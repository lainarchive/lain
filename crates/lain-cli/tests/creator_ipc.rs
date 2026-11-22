use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use lain_agent::{AgentConfig, ProviderSelection};
use lain_cli::daemon::{ConfigFactory, DaemonHandler};
use lain_core::plugin::manifest::HOST_PROCESS_PERMISSIONS;
use lain_ipc::{
    Command, Endpoint, Event, IpcClient, IpcServer, ScriptProposal, SessionMode, ToolSource,
};
use lain_memory::MemoryStore;
use serde_json::json;
use tokio::{sync::watch, time::timeout};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn proposal() -> Result<ScriptProposal, serde_json::Error> {
    serde_json::from_value(
        json!({"name":"generated", "description":"Echo", "parameters":{"type":"object"},
        "interpreter":"python", "test_args":{"value":7},
        "source":"import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':r['params']}))\nprint('trace',file=sys.stderr)\n"}),
    )
}

fn endpoint(directory: &tempfile::TempDir) -> Endpoint {
    #[cfg(unix)]
    let path = directory.path().join("ipc.sock");
    #[cfg(windows)]
    let path = PathBuf::from(format!(
        r"\\.\pipe\lain-creator-{}-{}",
        std::process::id(),
        directory
            .path()
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    Endpoint(path)
}

async fn serve(
    directory: &tempfile::TempDir,
    enabled: bool,
    grants: bool,
) -> Result<
    (
        IpcClient,
        watch::Sender<bool>,
        tokio::task::JoinHandle<Result<(), lain_ipc::Error>>,
    ),
    Box<dyn std::error::Error>,
> {
    let mut config = AgentConfig::new(
        ProviderSelection::OpenAiCompatible {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key_env: None,
        },
        "inventory-test",
    );
    config.allow_creator_mode = enabled;
    config.coding_session = true;
    if grants {
        config.plugin_permissions = HOST_PROCESS_PERMISSIONS.into_iter().collect();
    }
    let path = directory.path().join("config.json");
    std::fs::write(&path, serde_json::to_vec(&config)?)?;
    let handler = Arc::new(DaemonHandler::new(
        Arc::new(Mutex::new(MemoryStore::open(":memory:")?)),
        Arc::new(ConfigFactory::new(path, directory.path())),
    ));
    let (stop, receiver) = watch::channel(false);
    let address = endpoint(directory);
    let server = IpcServer::bind(&address)?;
    let task = tokio::spawn(server.serve(handler, receiver));
    Ok((IpcClient::connect(&address).await?, stop, task))
}

fn error(events: &[Event], expected: &str) {
    assert!(
        matches!(events, [Event::Error {code, ..}] if code == expected),
        "{events:?}"
    );
}

#[tokio::test]
async fn lists_inventory_and_executes_shared_creator_paths() -> TestResult {
    timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir()?;
        let (mut client, stop, task) = serve(&directory, true, true).await?;
        assert!(matches!(client.request(Command::ListSessions).await?.as_slice(), [Event::Sessions {sessions}] if sessions.is_empty()));
        assert!(matches!(client.request(Command::ListPlugins).await?.as_slice(), [Event::Plugins {plugins}] if plugins.is_empty()));
        client.request(Command::StartSession {session_id:Some("s".into())}).await?;
        assert!(matches!(client.request(Command::ListSessions).await?.as_slice(), [Event::Sessions {sessions}]
            if sessions.len() == 1 && sessions.first().is_some_and(|s| s.id == "s" && s.turn_count == 0 && s.model.as_deref() == Some("inventory-test") && s.mode.is_none())));
        let tested = client.request(Command::TestToolProposal {session_id:"s".into(), proposal:proposal()?}).await?;
        assert!(matches!(tested.as_slice(), [Event::ToolProposalResult {execution, written_paths, ..}]
            if execution.exit_code == Some(0) && execution.result == Some(json!({"value":7})) && execution.stderr == "trace\n" && written_paths.is_empty()));
        assert!(!directory.path().join(".lain").exists());
        let published = client.request(Command::PublishToolProposal {session_id:"s".into(), mode:SessionMode::Code, proposal:proposal()?}).await?;
        assert!(matches!(published.as_slice(), [Event::ToolProposalResult {execution, written_paths, ..}]
            if execution.error.is_none() && written_paths == &[PathBuf::from(".lain/tools/tool-generated.py"), PathBuf::from(".lain/tools/tool-generated.json") ]));
        let tools = client.request(Command::ListTools {session_id:"s".into()}).await?;
        assert!(matches!(tools.as_slice(), [Event::Tools {allow_creator_mode:true, tools, ..}] if tools.iter().any(|t|
            t.name == "generated" && t.source == ToolSource::Plugin {manifest_name:"generated".into(), manifest_path:Some(PathBuf::from(".lain/tools/tool-generated.json"))}
            && t.permissions.len() == 4 && t.permissions.iter().all(|p| p.granted))));
        error(&client.request(Command::PublishToolProposal {session_id:"s".into(), mode:SessionMode::Code, proposal:proposal()?}).await?, "TOOL_DUPLICATE");
        std::fs::create_dir_all(directory.path().join(".lain/plugins"))?;
        std::fs::write(directory.path().join(".lain/plugins/broken.yaml"), "name: [unfinished")?;
        let listed = client.request(Command::ListPlugins).await?;
        assert!(matches!(listed.as_slice(), [Event::Plugins {plugins}] if plugins.len() == 2
            && plugins.iter().any(|p| p.manifest.is_err()) && plugins.iter().any(|p| p.manifest.as_ref().is_ok_and(|m| m.name == "generated"))));
        let mut failed = proposal()?;
        failed.name = "failure".into();
        failed.source = "import sys\nprint('partial')\nprint('diagnostic',file=sys.stderr)\nsys.exit(7)".into();
        let failed = client.request(Command::PublishToolProposal {session_id:"s".into(), mode:SessionMode::Code, proposal:failed}).await?;
        assert!(matches!(failed.as_slice(), [Event::ToolProposalResult {execution, written_paths, ..}]
            if execution.exit_code == Some(7) && execution.error.is_some() && execution.stdout.contains("partial") && execution.stderr.contains("diagnostic") && written_paths.is_empty()));
        assert!(!directory.path().join(".lain/tools/tool-failure.json").exists());
        let mut invalid = proposal()?;
        invalid.parameters = json!({"type":"object", "required":["absent"]});
        error(&client.request(Command::TestToolProposal {session_id:"s".into(), proposal:invalid}).await?, "TOOL_ARGUMENTS_INVALID");
        for command in [Command::ListTools {session_id:"missing".into()},
            Command::TestToolProposal {session_id:"missing".into(), proposal:proposal()?},
            Command::PublishToolProposal {session_id:"missing".into(), mode:SessionMode::Code, proposal:proposal()?}] {
            error(&client.request(command).await?, "SESSION_NOT_FOUND");
        }
        client.close().await?;
        stop.send(true)?;
        task.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn cancelled_proposals_do_not_publish_or_poison_the_next_proposal() -> TestResult {
    timeout(Duration::from_secs(20),async {
        let directory=tempfile::tempdir()?;
        let (mut client,stop,task)=serve(&directory,true,true).await?;
        client.request(Command::StartSession {session_id:Some("s".into())}).await?;
        for publish in [false,true] {
            let mut slow=proposal()?;
            slow.source="import pathlib,time\npathlib.Path('started').touch()\ntime.sleep(10)\nprint('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}')".into();
            let command=if publish {Command::PublishToolProposal {session_id:"s".into(),mode:SessionMode::Code,proposal:slow}} else {Command::TestToolProposal {session_id:"s".into(),proposal:slow}};
            let request=client.send(command).await?;
            while !directory.path().join("started").exists() {tokio::task::yield_now().await;}
            assert!(matches!(client.request(Command::ListSessions).await?.as_slice(),[Event::Sessions {sessions}] if sessions.first().is_some_and(|s|s.status==Some(lain_ipc::SessionStatus::Busy))));
            let cancel=client.send(Command::CancelTurn {session_id:"s".into()}).await?;
            let mut cancelled=false;let mut acknowledged=false;
            while !cancelled || !acknowledged {
                let (id,event)=client.recv().await?.ok_or("closed")?;
                if id==request {assert!(matches!(event,Event::Error {ref code,..} if code=="TOOL_EXECUTION_FAILED"));cancelled=true;}
                if id==cancel {acknowledged=true;}
            }
            assert!(!directory.path().join(".lain/tools/tool-generated.json").exists());
            std::fs::remove_file(directory.path().join("started"))?;
            assert!(matches!(client.request(Command::TestToolProposal {session_id:"s".into(),proposal:proposal()?}).await?.as_slice(),[Event::ToolProposalResult {..}]));
            assert!(matches!(client.request(Command::ListSessions).await?.as_slice(),[Event::Sessions {sessions}] if sessions.first().is_some_and(|s|s.status==Some(lain_ipc::SessionStatus::Idle))));
        }
        client.close().await?;stop.send(true)?;task.await??;
        Ok::<(),Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn creator_refusals_do_not_execute_or_write() -> TestResult {
    timeout(Duration::from_secs(20), async {
        for (enabled, grants) in [(false, true), (true, false), (true, true)] {
            let directory = tempfile::tempdir()?;
            let (mut client, stop, task) = serve(&directory, enabled, grants).await?;
            client.request(Command::StartSession {session_id:Some("s".into())}).await?;
            let mut request = proposal()?;
            request.source = "from pathlib import Path\nPath('executed').write_text('bad')".into();
            for mode in [SessionMode::Architect, SessionMode::Ask, SessionMode::Code] {
                if enabled && grants && mode == SessionMode::Code { continue; }
                error(&client.request(Command::PublishToolProposal {session_id:"s".into(), mode, proposal:request.clone()}).await?,
                    if !enabled {"TOOL_NOT_FOUND"} else {"TOOL_PERMISSION_DENIED"});
            }
            if !enabled || !grants {
                error(&client.request(Command::TestToolProposal {session_id:"s".into(), proposal:request}).await?,
                    if !enabled {"TOOL_NOT_FOUND"} else {"TOOL_PERMISSION_DENIED"});
            }
            let tools = client.request(Command::ListTools {session_id:"s".into()}).await?;
            assert!(matches!(tools.as_slice(), [Event::Tools {tools, ..}] if tools.iter().any(|t| t.name == "create_tool") == enabled));
            if enabled && !grants {
                assert!(matches!(tools.as_slice(), [Event::Tools {tools, ..}] if tools.iter().any(|t| t.name == "create_tool"
                    && t.permissions.len() == 4 && t.permissions.iter().all(|p| !p.granted))));
            }
            assert!(matches!(tools.as_slice(), [Event::Tools {tools, ..}] if tools.iter().any(|t|
                t.name == "repo_map" && t.source == ToolSource::Builtin && t.permissions.len() == 1 && t.permissions.iter().all(|p| p.granted))));
            assert!(!directory.path().join("executed").exists());
            assert!(!directory.path().join(".lain").exists());
            client.close().await?;
            stop.send(true)?;
            task.await??;
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}

#[tokio::test]
async fn oversized_inventory_and_directory_errors_leave_socket_usable() -> TestResult {
    timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir()?;
        let plugins = directory.path().join(".lain/plugins");
        std::fs::create_dir_all(&plugins)?;
        for index in 0..22 {
            std::fs::write(plugins.join(format!("p{index}.json")), serde_json::to_vec(&json!({
                "name":format!("p{index}"), "version":"1", "author":"x".repeat(50_000), "permissions":[], "tools":[]
            }))?)?;
        }
        let (mut client, stop, task) = serve(&directory, false, false).await?;
        error(&client.request(Command::ListPlugins).await?, "IPC_RESPONSE_TOO_LARGE");
        assert!(matches!(client.request(Command::Ping).await?.as_slice(), [Event::Pong {..}]));
        std::fs::remove_dir_all(&plugins)?;
        std::fs::write(&plugins, "not a directory")?;
        error(&client.request(Command::ListPlugins).await?, "TOOL_EXECUTION_FAILED");
        assert!(matches!(client.request(Command::Ping).await?.as_slice(), [Event::Pong {..}]));
        client.close().await?;
        stop.send(true)?;
        task.await??;
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await?
}
