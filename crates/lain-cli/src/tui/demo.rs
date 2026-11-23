use std::time::Duration;

#[cfg(test)]
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_core::plugin::manifest::Capability;
use lain_harness::advisor::{AdvisorKind, AdvisorNote};
use lain_ipc::{ActiveTool, ManifestEntry, PermissionGrant, ToolSource};
use serde_json::json;

use super::state::{State, ToolBlock};
use crate::Error;

pub(super) fn catalog() -> Result<super::plugins::Plugins, Error> {
    Ok(State::demo_launch()?.plugins)
}

impl State {
    pub fn demo_metadata(&mut self, now: Duration) -> Result<(), Error> {
        self.demo = true;
        self.session_id = Some("demo-local-01".into());
        self.model_chain = "openai:gpt-4o".into();
        self.cost = Some(0.0128);
        self.context = 38_000;
        self.context_window = 1_000_000;
        self.event(
            &lain_ipc::Event::Telemetry {
                session_id: "demo-local-01".into(),
                model: self.model_chain.clone(),
                context_tokens: 38_000,
                context_window: 1_000_000,
                tokens_used: 3400,
                scratchpad: String::new(),
            },
            now,
        );
        for screen in [
            super::app::Screen::Sessions,
            super::app::Screen::Memory,
            super::app::Screen::Models,
        ] {
            self.inspect.demo_refresh(screen, now);
        }
        self.notice = "OFFLINE DEMO · all activity and telemetry are synthetic · no provider or scripts called".into();
        self.creator = super::creator::Creator::sample();
        self.plugins = super::plugins::Plugins::sample()?;
        for tool in &mut self.plugins.tools {
            if tool.name == "demo_echo" {
                for permission in &mut tool.permissions {
                    permission.granted = false;
                }
            }
        }
        for (name, description) in [
            (
                if cfg!(windows) { "powershell" } else { "bash" },
                "Run a command as the host user; demo only.",
            ),
            ("memory_read", "Search trusted memory."),
            ("repo_map", "Outline the workspace."),
            ("test_tool", "Test a proposed script as the host user."),
        ] {
            self.plugins.tools.push(ActiveTool {
                name: name.into(),
                description: description.into(),
                parameters: json!({"type":"object"}),
                source: ToolSource::Builtin,
                permissions: vec![],
            });
        }
        let manifest = serde_json::from_value(
            json!({"name":"notes", "version":"1.0.0", "author":"demo fixture", "permissions":["network"],
            "tools":[{"name":"demo_notes","description":"Summarize example notes.","parameters":{"type":"object"},
                "backend":{"kind":"webhook","url":"https://example.invalid/notes"}}]}),
        )?;
        self.plugins.manifests.push(ManifestEntry {
            path: ".lain/plugins/notes.json".into(),
            manifest: Ok(manifest),
        });
        self.plugins.tools.push(ActiveTool {
            name: "demo_notes".into(),
            description: "Summarize example notes.".into(),
            parameters: json!({"type":"object"}),
            source: ToolSource::Plugin {
                manifest_name: "notes".into(),
                manifest_path: Some(".lain/plugins/notes.json".into()),
            },
            permissions: vec![PermissionGrant {
                capability: Capability::Network,
                granted: true,
            }],
        });
        Ok(())
    }

    pub fn demo_launch() -> Result<Self, Error> {
        let cwd = std::env::current_dir()?;
        let mut state = Self::new("demo/workspace".into(), &cwd)?;
        state.demo_metadata(Duration::ZERO)?;
        Ok(state)
    }

    #[cfg(test)]
    pub fn demo_turn() -> Result<Self, Error> {
        let mut state = Self::demo_launch()?;
        state.composer = "Inspect the plugin workflow and prepare a safe Creator plan.".into();
        state.key(
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            Duration::ZERO,
        );
        state.seed_demo_turn(Duration::ZERO);
        Ok(state)
    }

    pub fn seed_demo_turn(&mut self, now: Duration) {
        let Some(node) = self.active.clone() else {
            return;
        };
        let state = self;
        if let Some(task) = state.active.as_ref().and_then(|id| state.tasks.get_mut(id)) {
            task.model = state.model_chain.clone();
            task.tokens = 3400;
            task.text = concat!(
                "**Canned demo turn, not a provider response to your prompt.**\n\n",
                "**The Creator path is ready to review.**\n\n",
                "- Browse manifests with `/plugins`.\n",
                "- Build and test a proposal in `/creator`.\n",
                "- Publish only in **Code** mode after reviewing permissions.\n\n",
                "```python\ndef run(args):\n    return {\"message\": args[\"message\"]}\n```\n\n",
                "This is a prepared plan, **not verified execution**. The final catalog check is still running."
            ).into();
        }
        for (index, name, output, finished) in [
            (0, "memory_read", "Found two trusted workspace conventions.", true),
            (1, "repo_map", "crates/lain-cli/src/tui/\n  creator.rs\n  creator_ipc.rs\n  creator_view.rs\n  plugins.rs\n  transcript.rs\n  theme.rs", true),
            (2, "demo_notes", "Preparing a catalog summary…", false),
        ] {
            let arguments = match name {
                "memory_read" => json!({"query":"Creator publishing workflow"}).to_string(),
                "demo_notes" => json!({"topic":"Creator catalog"}).to_string(),
                _ => "{}".into(),
            };
            state.tools.push(ToolBlock {node:node.clone(),call_id:format!("demo-{index}"), name:name.into(),arguments,output:output.into(),
                ok:finished.then_some(true),expanded:false,started:now, ended:finished.then_some(now+Duration::from_millis(400))});
        }
        state.notes.push(AdvisorNote {
            turn: state.next_turn,
            kind: AdvisorKind::Warning,
            text: "Scripts run unsandboxed as the host user; inspect source before testing.".into(),
        });
        state.plan =
            "[✓] Inspect plugin contracts\n[✓] Prepare Creator plan\n[●] Review catalog".into();
        state.rules = vec!["Require observed evidence before claiming verification.".into()];
        state.seed_demo_lanes(&node, now);
    }

    /// Six planned lanes over three layers, so the rail and timeline have a run to show.
    fn seed_demo_lanes(&mut self, plan: &str, now: Duration) {
        use super::state::Phase;
        use lain_harness::evidence::Status;
        let at = |s: u64| now + Duration::from_secs(s);
        if let Some(task) = self.tasks.get_mut(plan) {
            task.title = "plan".into();
        }
        let verified = Phase::Evidence(Status::ObservedVerified);
        let waiting = Phase::Evidence(Status::Planned);
        for (id, deps, model, phase, started, ended, tokens) in [
            (
                "manifest-v2",
                vec![plan],
                "gpt-5-mini",
                verified,
                at(1),
                Some(at(18)),
                312_000,
            ),
            (
                "policy-gate",
                vec![plan],
                "claude-4.5",
                verified,
                at(1),
                Some(at(24)),
                1_100_000,
            ),
            (
                "ipc-bridge",
                vec!["manifest-v2", "policy-gate"],
                "gpt-5",
                Phase::Running,
                at(19),
                None,
                608_000,
            ),
            (
                "windows-job",
                vec!["policy-gate"],
                "gpt-5",
                Phase::Running,
                at(25),
                None,
                291_000,
            ),
            (
                "sandbox-tests",
                vec!["ipc-bridge", "windows-job"],
                "claude-4.5",
                waiting,
                now,
                None,
                0,
            ),
            (
                "security-doc",
                vec!["windows-job"],
                "gpt-5-mini",
                waiting,
                now,
                None,
                0,
            ),
        ] {
            if self
                .add_lane(id, &deps, model, phase, started, ended, tokens)
                .is_err()
            {
                return;
            }
        }
        for (index, (lane, name, arguments, output, ok, started, ended)) in [
            (
                "manifest-v2",
                "bash",
                json!({"command":"cargo test -p lain-plugin"}),
                "23 passed",
                Some(true),
                14,
                Some(18),
            ),
            (
                "policy-gate",
                "bash",
                json!({"command":"cargo test policy"}),
                "41 passed",
                Some(true),
                20,
                Some(24),
            ),
            (
                "ipc-bridge",
                "bash",
                json!({"command":"cargo check -p lain-ipc"}),
                "finished",
                Some(true),
                22,
                Some(26),
            ),
            (
                "windows-job",
                "edit",
                json!({"path":"sandbox/windows.rs"}),
                "+40 -6",
                Some(true),
                28,
                Some(29),
            ),
            (
                "ipc-bridge",
                "bash",
                json!({"command":"cargo test -p lain-ipc"}),
                "",
                None,
                30,
                None,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            self.tools.push(ToolBlock {
                node: lane.into(),
                call_id: format!("demo-lane-{index}"),
                name: name.into(),
                arguments: arguments.to_string(),
                output: output.into(),
                ok,
                expanded: false,
                started: at(started),
                ended: ended.map(at),
            });
        }
    }
}
