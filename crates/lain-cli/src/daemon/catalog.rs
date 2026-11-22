use std::collections::BTreeSet;

use lain_core::{
    plugin::{
        manifest::{Capability, HOST_PROCESS_PERMISSIONS},
        PluginManager,
    },
    tools::{
        publish_tool_proposal_checked, test_tool_proposal, ToolError, ToolSource as CoreSource,
    },
};
use lain_ipc::{
    ActiveTool, Event, EventSink, PermissionGrant, ScriptProposal, SessionInfo, SessionMode,
    ToolSource, MAX_FRAME_SIZE,
};

use super::{DaemonHandler, Error};

struct ProposalCancellation<'a> {
    session: &'a super::Session,
    runner: Option<tokio::sync::MutexGuard<'a, lain_agent::AgentRunner>>,
}

impl Drop for ProposalCancellation<'_> {
    fn drop(&mut self) {
        let _guard = self
            .session
            .cancellation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.session.canceller.reset();
        drop(self.runner.take());
    }
}

impl DaemonHandler {
    fn plugin_manager(&self, grants: BTreeSet<Capability>) -> Result<PluginManager, Error> {
        let workspace = self.factory.workspace().ok_or_else(|| {
            Error::failure("WORKSPACE_UNAVAILABLE", "Runner factory has no workspace")
        })?;
        Ok(PluginManager::new(workspace, grants))
    }

    pub(super) async fn list_plugins(&self, events: &EventSink) -> Result<(), Error> {
        let manager = self.plugin_manager(BTreeSet::new())?;
        let plugins = tokio::task::spawn_blocking(move || manager.inventory())
            .await
            .map_err(|error| Error::failure("PLUGIN_INVENTORY_FAILED", error))?
            .map_err(ToolError::from)?;
        reply(events, Event::Plugins { plugins }).await
    }

    pub(super) async fn list_tools(
        &self,
        session_id: String,
        events: &EventSink,
    ) -> Result<(), Error> {
        let session = self.session(&session_id).await?;
        let tools = session
            .tools
            .definitions()
            .into_iter()
            .map(|definition| {
                let (source, required, implicit) = match session.tools.source(&definition.name) {
                    Some(CoreSource::Plugin {
                        manifest_name,
                        manifest_path,
                    }) => (
                        ToolSource::Plugin {
                            manifest_name,
                            manifest_path,
                        },
                        session
                            .tools
                            .manifest_permissions(&definition.name)
                            .unwrap_or_default(),
                        false,
                    ),
                    _ => {
                        let (required, implicit) = match definition.name.as_str() {
                            "test_tool" | "create_tool" => {
                                (HOST_PROCESS_PERMISSIONS.into_iter().collect(), false)
                            }
                            "bash" | "powershell" => {
                                (HOST_PROCESS_PERMISSIONS.into_iter().collect(), true)
                            }
                            "repo_map" => (BTreeSet::from([Capability::ReadFs]), true),
                            _ => (BTreeSet::new(), true),
                        };
                        (ToolSource::Builtin, required, implicit)
                    }
                };
                let permissions = required
                    .into_iter()
                    .map(|capability| PermissionGrant {
                        capability,
                        granted: implicit
                            || session.config.plugin_permissions.contains(&capability),
                    })
                    .collect();
                ActiveTool {
                    name: definition.name,
                    description: definition.description,
                    parameters: definition.parameters,
                    source,
                    permissions,
                }
            })
            .collect();
        reply(
            events,
            Event::Tools {
                session_id,
                allow_creator_mode: session.config.allow_creator_mode,
                tools,
            },
        )
        .await
    }

    pub(super) async fn list_sessions(&self, events: &EventSink) -> Result<(), Error> {
        let active = self.sessions.read().await;
        let mut sessions = active
            .iter()
            .map(|(id, session)| {
                let turn_count = session
                    .runner
                    .try_lock()
                    .map(|runner| runner.state().turn_count)
                    .unwrap_or_else(|_| {
                        session
                            .turn_count
                            .load(std::sync::atomic::Ordering::Relaxed)
                    });
                SessionInfo {
                    id: id.clone(),
                    mode: None,
                    model: Some(session.config.model.clone()),
                    turn_count,
                }
            })
            .collect::<Vec<_>>();
        drop(active);
        sessions.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        reply(events, Event::Sessions { sessions }).await
    }

    pub(super) async fn tool_proposal(
        &self,
        session_id: String,
        proposal: ScriptProposal,
        publish_mode: Option<SessionMode>,
        events: &EventSink,
    ) -> Result<(), Error> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::failure("SESSION_NOT_FOUND", &session_id))?;
        let runner = session
            .runner
            .try_lock()
            .map_err(|_| Error::failure("SESSION_BUSY", &session_id))?;
        drop(sessions);
        let _cancellation = ProposalCancellation {
            session: &session,
            runner: Some(runner),
        };
        if !session.config.allow_creator_mode {
            return Err(ToolError::Unknown(
                if publish_mode.is_some() {
                    "create_tool"
                } else {
                    "test_tool"
                }
                .into(),
            )
            .into());
        }
        if publish_mode.is_some_and(|mode| mode != SessionMode::Code) {
            return Err(
                ToolError::Permission("Creator publishing requires Code mode".into()).into(),
            );
        }
        let manager = self.plugin_manager(session.config.plugin_permissions.clone())?;
        let cancelled = || ToolError::Execution("Creator proposal cancelled".into());
        let operation = async {
            if publish_mode.is_some() {
                publish_tool_proposal_checked(&manager, &session.tools, proposal, || {
                    let guard = session
                        .cancellation
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if session.canceller.is_cancelled() {
                        Err(cancelled())
                    } else {
                        Ok(guard)
                    }
                })
                .await
            } else {
                test_tool_proposal(&manager, proposal).await
            }
        };
        let report = tokio::select! {
            biased;
            ()=session.canceller.cancelled()=>return Err(cancelled().into()),
            ()=events.closed()=>return Err(cancelled().into()),
            result=operation=>result?,
        };
        reply(
            events,
            Event::ToolProposalResult {
                session_id,
                execution: report.execution,
                written_paths: report.written_paths,
            },
        )
        .await
    }
}

async fn reply(events: &EventSink, event: Event) -> Result<(), Error> {
    if serde_json::to_vec(&event)?.len().saturating_add(64) > MAX_FRAME_SIZE {
        return Err(Error::failure(
            "IPC_RESPONSE_TOO_LARGE",
            "Response exceeds the IPC frame limit",
        ));
    }
    events.send(event).await?;
    Ok(())
}
