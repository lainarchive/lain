use lain_ipc::{ClientFrame, Command, Event, ServerFrame, PROTOCOL_VERSION};
use serde_json::json;

#[test]
fn creator_commands_and_inventory_events_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
    let proposal = json!({"name":"echo", "description":"Echo", "parameters":{"type":"object"},
        "interpreter":"python", "source":"pass", "test_args":{}});
    for command in [
        json!({"type":"list_tools", "session_id":"s"}),
        json!({"type":"list_plugins"}),
        json!({"type":"list_sessions"}),
        json!({"type":"test_tool_proposal", "session_id":"s", "proposal":proposal}),
        json!({"type":"publish_tool_proposal", "session_id":"s", "proposal":proposal, "mode":"code"}),
        json!({"type":"publish_tool_proposal", "session_id":"s", "proposal":proposal, "mode":"architect"}),
        json!({"type":"publish_tool_proposal", "session_id":"s", "proposal":proposal, "mode":"ask"}),
    ] {
        let frame = json!({"version":PROTOCOL_VERSION,"id":42,"command":command});
        let decoded: ClientFrame = serde_json::from_value(frame.clone())?;
        assert_eq!(serde_json::to_value(&decoded)?, frame);
        assert_eq!(
            serde_json::from_slice::<ClientFrame>(&serde_json::to_vec(&decoded)?)?,
            decoded
        );
    }
    assert!(serde_json::from_value::<Command>(
        json!({"type":"publish_tool_proposal", "session_id":"s", "proposal":proposal})
    )
    .is_err());
    assert!(serde_json::from_value::<Command>(json!({"type":"publish_tool_proposal", "session_id":"s", "proposal":proposal, "mode":"invalid"})).is_err());
    for event in [
        json!({"type":"tools", "session_id":"s", "allow_creator_mode":true, "tools":[
            {"name":"echo", "description":"Echo", "parameters":{"type":"object"},
             "source":{"kind":"plugin", "manifest_name":"package", "manifest_path":".lain/tools/package.json"},
             "permissions":[{"capability":"subprocess", "granted":false}]}]}),
        json!({"type":"tools", "session_id":"s", "allow_creator_mode":false, "tools":[]}),
        json!({"type":"plugins", "plugins":[{"path":".lain/plugins/bad.json", "manifest":{"Err":"invalid JSON"}}]}),
        json!({"type":"plugins", "plugins":[]}),
        json!({"type":"tool_proposal_result", "session_id":"s", "execution":{
            "exit_code":0,"stdout":"null\n","stderr":"","result":null,"duration_ms":1,"error":null}, "written_paths":[]}),
        json!({"type":"tool_proposal_result", "session_id":"s", "execution":{
            "exit_code":7,"stdout":"","stderr":"failed","duration_ms":1,"error":"failed"}, "written_paths":[]}),
        json!({"type":"sessions", "sessions":[{"id":"s", "model":"test", "turn_count":2}]}),
        json!({"type":"sessions", "sessions":[]}),
    ] {
        let frame = json!({"version":PROTOCOL_VERSION,"id":42,"event":event});
        let decoded: ServerFrame = serde_json::from_value(frame.clone())?;
        assert!(decoded.event.is_terminal());
        assert_eq!(serde_json::to_value(&decoded)?, frame);
        assert_eq!(
            serde_json::from_slice::<ServerFrame>(&serde_json::to_vec(&decoded)?)?,
            decoded
        );
    }
    assert!(matches!(
        serde_json::from_value::<Command>(json!({"type":"ping"}))?,
        Command::Ping
    ));
    assert!(matches!(
        serde_json::from_value::<Event>(json!({"type":"pong","server_version":1}))?,
        Event::Pong { .. }
    ));
    Ok(())
}
