use std::time::Duration;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_ipc::Event;
use ratatui::{backend::TestBackend, Terminal};

use super::{
    state::{Effect, Mode, State},
    view,
};

fn render(state: &State) -> Result<String, Box<dyn std::error::Error>> {
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    terminal.draw(|frame| view::draw(frame, state, Duration::from_secs(2)))?;
    let buffer = terminal.backend().buffer();
    Ok((0..45)
        .map(|y| {
            (0..140)
                .filter_map(|x| buffer.cell((x, y)).map(|cell| cell.symbol()))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
fn banner_lanes_and_sticky_plan() -> Result<(), Box<dyn std::error::Error>> {
    let state = State::sample()?;
    let text = render(&state)?;
    for expected in [
        "planner → coder → advisor",
        "tok/s",
        "cost unknown",
        "ctx",
        "33%",
        "42k/128k",
        "feat/frontier",
        "layer 1",
        "3 nodes",
        "✓",
        "×",
        "○",
        "↻ repair 1",
        "[Plan] 3/5",
        "[●]",
        "Procedural rules",
        "aside",
        "warning",
        "blocker",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    assert!(!text.contains("$0"));
    Ok(())
}

#[test]
fn output_preview_and_full_drawer() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    let text = render(&state)?;
    assert!(text.contains("output 09"));
    assert!(!text.contains("output 10"));
    assert!(text.contains("… 2 more lines"));
    state.select_tool(0);
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    let expanded = render(&state)?;
    assert!(expanded.contains("output 11"));
    assert!(expanded.contains("[Plan] 3/5"));
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    assert!(!render(&state)?.contains("output 11"));
    state.tools.first_mut().ok_or("no sample tool")?.output =
        format!("{}TAIL", "word ".repeat(600));
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    for _ in 0..20 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
    }
    assert!(render(&state)?.contains("TAIL"));
    state
        .tools
        .first_mut()
        .ok_or("no sample tool")?
        .output
        .clear();
    assert!(render(&state)?.contains("Full output"));
    Ok(())
}

#[test]
fn keyboard_rewind_modes_and_mode_policy() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new(
        "branch".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    assert_eq!(state.mode, Mode::Architect);
    state.composer = "inspect this".into();
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Submit {
            read_only: true,
            ..
        }
    ));
    assert!(state.running);
    state.composer = "steer".into();
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Steer(_)
    ));
    assert!(matches!(
        state.key(key(KeyCode::Esc), Duration::from_millis(100)),
        Effect::None
    ));
    assert!(state.running);
    assert!(matches!(
        state.key(key(KeyCode::Esc), Duration::from_millis(601)),
        Effect::None
    ));
    assert!(matches!(
        state.key(key(KeyCode::Esc), Duration::from_millis(1000)),
        Effect::Rewind
    ));
    assert_eq!(state.composer, "inspect this");
    assert!(!state.running);
    assert!(state.dag.nodes().next().is_none());
    for expected in [Mode::Code, Mode::Ask, Mode::Architect] {
        state.key(key(KeyCode::Tab), Duration::ZERO);
        assert_eq!(state.mode, expected);
        assert_eq!(state.mode.read_only(), expected != Mode::Code);
    }
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Submit {
            read_only: true,
            ..
        }
    ));
    Ok(())
}

#[test]
fn empty_and_error_events_are_visible() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new(
        "detached@abcdef0".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    assert!(render(&state)?.contains("No turns yet"));
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::None
    ));
    state.event(
        &lain_ipc::Event::Error {
            code: "BROKEN".into(),
            message: "failed".into(),
        },
        Duration::ZERO,
    );
    assert!(render(&state)?.contains("BROKEN: failed"));
    Ok(())
}

#[test]
fn sample_dump() -> Result<(), Box<dyn std::error::Error>> {
    let text = render(&State::sample()?)?;
    if let Some(path) = std::env::var_os("LAIN_TUI_DUMP") {
        std::fs::write(path, format!("{text}\n"))?;
    }
    Ok(())
}

#[test]
fn whole_assistant_messages_are_separated() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.composer = "answer me".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    for text in ["Commentary", "", "Final answer"] {
        state.event(
            &Event::StreamToken {
                session_id: "s".into(),
                text: text.into(),
            },
            Duration::ZERO,
        );
    }
    let task = state
        .active
        .as_ref()
        .and_then(|id| state.tasks.get(id))
        .ok_or("missing active turn")?;
    assert_eq!(task.text, "Commentary\n\nFinal answer");
    Ok(())
}

#[test]
fn busy_steering_retains_the_draft_without_overwriting_edits(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.running = true;
    state.composer = "please check tests".into();
    assert!(
        matches!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::Steer(text) if text == "please check tests")
    );
    assert_eq!(state.composer, "please check tests");
    state.composer.push_str(" first");
    state.event(
        &Event::Error {
            code: "SESSION_BUSY".into(),
            message: "Turn in progress".into(),
        },
        Duration::ZERO,
    );
    assert_eq!(state.composer, "please check tests first");
    Ok(())
}

#[test]
fn lane_paging_reaches_long_answers_and_selection_resets_scroll(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.tasks.get_mut("1").ok_or("no sample task")?.text = (0..100)
        .map(|i| format!("answer {i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!render(&state)?.contains("answer 99"));
    for _ in 0..30 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
    }
    assert!(render(&state)?.contains("answer 99"));
    for _ in 0..30 {
        state.key(key(KeyCode::PageUp), Duration::ZERO);
    }
    assert!(render(&state)?.contains("answer 00"));
    for _ in 0..30 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
    }
    state.key(key(KeyCode::Down), Duration::ZERO);
    assert!(render(&state)?.contains("answer 00"));
    assert!(!render(&state)?.contains("answer 99"));
    Ok(())
}

#[test]
fn telemetry_events_completion_and_folding() -> Result<(), Box<dyn std::error::Error>> {
    use lain_ipc::Event;
    let mut state = State::new(
        "main".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    state.composer = "plan".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.event(
        &Event::ToolStarted {
            session_id: "s".into(),
            call_id: "c".into(),
            name: "repo_map".into(),
            arguments: serde_json::json!({}),
        },
        Duration::ZERO,
    );
    state.event(
        &Event::ToolFinished {
            session_id: "s".into(),
            call_id: "c".into(),
            name: "repo_map".into(),
            ok: true,
            summary: "symbols".into(),
        },
        Duration::ZERO,
    );
    state.event(
        &Event::StreamToken {
            session_id: "s".into(),
            text: "A plan".into(),
        },
        Duration::ZERO,
    );
    state.event(
        &Event::Telemetry {
            session_id: "s".into(),
            model: "local".into(),
            context_tokens: 100,
            context_window: 1000,
            tokens_used: 50,
            scratchpad: "[●] Plan".into(),
        },
        Duration::from_secs(1),
    );
    assert_eq!(state.velocity(Duration::from_secs(2)), 10.0);
    assert_eq!(state.velocity(Duration::from_secs(7)), 0.0);
    state.event(
        &Event::SessionCompleted {
            session_id: "s".into(),
            reason: "completed".into(),
            scratchpad: None,
        },
        Duration::from_secs(2),
    );
    assert!(!state.running);
    let text = render(&state)?;
    assert!(text.contains("◇"));
    assert!(text.contains("prepared"));
    assert!(text.contains("A plan"));
    state.selected = Some(super::state::Selection::Layer(0));
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    assert!(!render(&state)?.contains("symbols"));
    state.cost = Some(1.25);
    assert!(render(&state)?.contains("$1.2500"));
    Ok(())
}
