use std::{collections::BTreeSet, time::Duration};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lain_ipc::Event;
use ratatui::{backend::TestBackend, Terminal};

use super::{
    app::{self, Overlay, Screen},
    state::{Effect, Mode, State},
    view,
};

#[test]
fn shell_routes_without_losing_a_draft() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    for (index, screen) in Screen::ALL.iter().enumerate() {
        state.key(
            key(KeyCode::Char(char::from(b'1' + index as u8))),
            Duration::ZERO,
        );
        assert_eq!(state.screen, *screen);
        let text = render(&state)?;
        assert!(text.contains(screen.name()));
        if *screen != Screen::Session {
            assert!(text.contains(&format!("/{}", screen.id())));
            assert!(!text.contains("layer 1"));
        }
    }
    state.key(key(KeyCode::Char('1')), Duration::ZERO);
    state.composer = "draft".into();
    state.key(key(KeyCode::Char('3')), Duration::ZERO);
    assert_eq!(state.screen, Screen::Session);
    assert_eq!(state.composer, "draft3");
    state.key(
        KeyEvent::new(KeyCode::Right, KeyModifiers::ALT),
        Duration::ZERO,
    );
    assert_eq!(state.screen, Screen::Plugins);
    state.key(key(KeyCode::Char('6')), Duration::ZERO);
    assert_eq!(state.screen, Screen::Models);
    state.key(
        KeyEvent::new(KeyCode::Right, KeyModifiers::ALT),
        Duration::ZERO,
    );
    assert_eq!(state.screen, Screen::Session);
    assert_eq!(state.composer, "draft3");
    Ok(())
}

#[test]
fn palette_scores_filters_and_dispatches() -> Result<(), Box<dyn std::error::Error>> {
    assert!(app::score("plugins", "plugins") > app::score("pg", "plugins"));
    assert!(app::score("PLG", "Plugins").is_some());
    assert!(app::score("zq", "Plugins").is_none());
    assert!(app::score("", "Plugins").is_some());
    let mut state = State::sample()?;
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    for c in "plg".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    let text = render(&state)?;
    assert!(text.contains("Commands"));
    assert!(text.contains("Go to Plugins"));
    assert!(!text.contains("Go to Models"));
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    assert_eq!(state.screen, Screen::Plugins);
    assert!(state.overlay.is_none());
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    for c in "zzzz".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    assert!(render(&state)?.contains("No matching commands"));
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    assert!(state.overlay.is_some());
    Ok(())
}

#[test]
fn slash_uses_registry_and_unknown_commands_expire() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    for c in "/plug".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    assert!(render(&state)?.contains("/plugins"));
    state.key(key(KeyCode::Tab), Duration::ZERO);
    state.key(key(KeyCode::Up), Duration::ZERO);
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    assert_eq!(state.screen, Screen::Plugins);
    assert!(state.composer.is_empty());
    state.key(key(KeyCode::Char('1')), Duration::ZERO);
    state.composer = "/not-a-command".into();
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    assert!(render(&state)?.contains("Unknown command"));
    state.tick(Duration::from_secs(10));
    assert!(state.toast.is_none());
    assert!(!render(&state)?.contains("Unknown command"));
    assert_eq!(state.composer, "/not-a-command");
    Ok(())
}

#[test]
fn help_and_overlay_escape_take_precedence_over_rewind() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.key(key(KeyCode::Char('x')), Duration::ZERO);
    state.key(key(KeyCode::Enter), Duration::ZERO);
    let tasks = state.tasks.len();
    state.key(key(KeyCode::F(1)), Duration::ZERO);
    let text = render(&state)?;
    for expected in [
        "Global keys",
        "Session keys",
        "Ctrl+K",
        "Go to Creator",
        "Rewind turn",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    assert!(matches!(state.overlay, Some(Overlay::Palette { .. })));
    assert_eq!(state.key(key(KeyCode::Esc), Duration::ZERO), Effect::None);
    assert!(state.overlay.is_some());
    assert_eq!(state.key(key(KeyCode::Esc), Duration::ZERO), Effect::None);
    assert!(state.overlay.is_none());
    assert_eq!(state.tasks.len(), tasks);
    assert_eq!(state.key(key(KeyCode::Esc), Duration::ZERO), Effect::None);
    assert_eq!(
        state.key(key(KeyCode::Esc), Duration::from_millis(100)),
        Effect::Rewind
    );
    state.key(
        KeyEvent::new(KeyCode::Left, KeyModifiers::ALT),
        Duration::ZERO,
    );
    assert_eq!(state.key(key(KeyCode::Esc), Duration::ZERO), Effect::None);
    assert_eq!(state.key(key(KeyCode::Esc), Duration::ZERO), Effect::None);
    Ok(())
}

#[test]
fn registry_actions_preserve_policy_and_confirm_discard() -> Result<(), Box<dyn std::error::Error>>
{
    let mut state = State::sample()?;
    state.composer = "/code".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.mode, Mode::Code);
    state.composer = "keep me".into();
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    for c in "new".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(matches!(state.overlay, Some(Overlay::Confirm(_))));
    assert!(render(&state)?.contains("Discard"));
    state.key(key(KeyCode::Esc), Duration::ZERO);
    assert_eq!(state.composer, "keep me");
    assert_eq!(
        state.key(key(KeyCode::Char('q')), Duration::ZERO),
        Effect::None
    );
    Ok(())
}

#[test]
fn palette_snapshot() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.notice =
        "OFFLINE DEMO · synthetic verified evidence and advisor notes · no provider contacted"
            .into();
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    let text = render(&state)?;
    assert!(text.contains("Go to Session"));
    assert!(text.contains("OFFLINE DEMO"));
    if let Ok(path) = std::env::var("LAIN_TUI_PALETTE_DUMP") {
        std::fs::write(path, format!("{text}\n"))?;
    }
    Ok(())
}

#[test]
fn long_palette_query_keeps_empty_results_visible() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    for _ in 0..512 {
        state.key(key(KeyCode::Char('z')), Duration::ZERO);
    }
    assert!(render(&state)?.contains("No matching commands"));
    Ok(())
}

#[test]
fn shell_commands_and_small_screen_guards() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    for command in &app::COMMANDS {
        assert_eq!(
            app::matching(command.id).first().map(|c| c.id),
            Some(command.id)
        );
    }
    assert_eq!(app::matching("").len(), app::COMMANDS.len());
    assert!(app::score("x", "").is_none());
    assert!(app::score("Ä", "ä").is_some());
    state.select_tool(0);
    state.composer = "/output".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(state.tools.first().is_some_and(|t| t.expanded));
    state.composer = "/ask".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.mode, Mode::Ask);
    state.composer = "work".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.composer = "/code".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.mode, Mode::Ask);
    state.composer = "/new".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(matches!(state.overlay, Some(Overlay::Confirm(_))));
    assert_eq!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::NewSession
    );
    assert!(!state.running);
    assert!(state.tasks.is_empty());
    assert!(state.composer.is_empty());
    state.composer = "draft".into();
    state.key(
        KeyEvent::new(KeyCode::Right, KeyModifiers::ALT),
        Duration::ZERO,
    );
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    assert_eq!(state.composer, "draft");
    let tiny = ratatui::layout::Rect::new(0, 0, 119, 29);
    super::input::handle_key(&mut state, key(KeyCode::F(1)), Duration::ZERO, tiny);
    assert!(state.overlay.is_none());
    assert_eq!(state.screen, Screen::Plugins);
    Ok(())
}

#[test]
fn shell_help_and_tab_highlight_fit_minimum_size() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    let mut terminal = Terminal::new(TestBackend::new(120, 30))?;
    state.key(key(KeyCode::Char('3')), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    let text = contents(&terminal);
    let x = text
        .lines()
        .nth(4)
        .and_then(|line| line.find("3 Creator"))
        .ok_or("missing tab")?;
    let cell = terminal
        .backend()
        .buffer()
        .cell((x as u16, 4))
        .ok_or("missing cell")?;
    assert_eq!(cell.fg, super::theme::CYAN);
    assert_eq!(cell.bg, super::theme::PANEL);
    state.key(key(KeyCode::Char('1')), Duration::ZERO);
    state.key(key(KeyCode::Char('?')), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    let text = contents(&terminal);
    for command in &app::COMMANDS {
        assert!(text.contains(command.title), "missing {}", command.title);
    }
    assert!(text.contains("Global keys"));
    assert!(text.contains("Session keys"));
    Ok(())
}

fn render(state: &State) -> Result<String, Box<dyn std::error::Error>> {
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    terminal.draw(|frame| {
        view::draw(frame, state, Duration::from_secs(2));
    })?;
    Ok(contents(&terminal))
}

fn contents(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .filter_map(|x| buffer.cell((x, y)).map(|cell| cell.symbol()))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn plugins_permission_colors_and_detail_paging() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.screen = Screen::Plugins;
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(terminal
        .backend()
        .buffer()
        .content
        .iter()
        .any(|cell| cell.symbol() == "✓" && cell.fg == super::theme::GREEN));
    state.key(key(KeyCode::Char('/')), Duration::ZERO);
    for c in "create_tool".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(terminal
        .backend()
        .buffer()
        .content
        .iter()
        .any(|cell| cell.symbol() == "✗" && cell.fg == super::theme::RED));
    if let Some(tool) = state
        .plugins
        .tools
        .iter_mut()
        .find(|tool| tool.name == "create_tool")
    {
        tool.description = (0..70)
            .map(|n| format!("description-line-{n:02}"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    draw_scrolled(&mut terminal, &mut state)?;
    for _ in 0..20 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert_eq!(state.scroll.plugin_detail, state.scroll.plugin_max);
    assert!(contents(&terminal).contains("description-line-69"));
    let bottom = state.scroll.plugin_detail;
    state.key(key(KeyCode::PageUp), Duration::ZERO);
    assert!(state.scroll.plugin_detail < bottom);
    state.plugins.tools.clear();
    state.plugins.filter.clear();
    state.plugins.filtering = false;
    state.key(key(KeyCode::Esc), Duration::ZERO);
    assert!(render(&state)?.contains("? network"));
    Ok(())
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
fn plugins_browse_filter_and_pass_creator_template() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.key(key(KeyCode::Char('2')), Duration::ZERO);
    let text = render(&state)?;
    for expected in [
        "Manifests",
        "Active tools",
        "demo_echo",
        "broken.json",
        "webhook",
        "properties",
        "✓ network",
        "/plugins",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    state.composer = "keep session draft".into();
    state.key(key(KeyCode::Char('/')), Duration::ZERO);
    for c in "demo_echo".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(render(&state)?.contains("Backend: webhook (from disk inventory)"));
    state.key(key(KeyCode::Esc), Duration::ZERO);
    state.key(key(KeyCode::Char('/')), Duration::ZERO);
    for c in "create_tool".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    let text = render(&state)?;
    assert!(text.contains("create_tool"));
    assert!(!text.contains("broken.json"));
    assert!(text.contains("✗ subprocess"));
    assert_eq!(state.composer, "keep session draft");
    state.key(key(KeyCode::Esc), Duration::ZERO);
    assert!(state.plugins.filter.is_empty());
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.screen, Screen::Creator);
    let template = state.creator_template.as_ref().ok_or("missing template")?;
    assert_eq!(
        template.path,
        std::path::PathBuf::from(".lain/plugins/echo.json")
    );
    assert!(template.manifest.as_ref().is_ok_and(|m| m.name == "echo"));
    assert!(render(&state)?.contains("Template: echo"));
    Ok(())
}

#[test]
fn plugins_show_errors_and_keep_filter_input_out_of_global_shortcuts(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.screen = Screen::Plugins;
    state.key(key(KeyCode::Char('/')), Duration::ZERO);
    for c in "zz12?q".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    assert_eq!(state.screen, Screen::Plugins);
    assert!(state.overlay.is_none());
    assert_eq!(state.plugins.filter, "zz12?q");
    assert_eq!(
        super::input::handle_key(
            &mut state,
            key(KeyCode::Char('q')),
            Duration::ZERO,
            ratatui::layout::Rect::new(0, 0, 80, 10)
        ),
        Effect::None
    );
    assert_eq!(state.plugins.filter, "zz12?q");
    assert!(render(&state)?.contains("No matching entries"));
    state.key(key(KeyCode::Esc), Duration::ZERO);
    state.key(key(KeyCode::Down), Duration::ZERO);
    assert!(render(&state)?.contains("Load error"));
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.screen, Screen::Plugins);
    assert!(state.creator_template.is_none());
    state.plugins.inventory_error =
        Some("Daemon does not support ListPlugins: IPC_INVALID_FRAME".into());
    state.plugins.tools_error = Some("ListTools failed: SESSION_NOT_FOUND".into());
    let text = render(&state)?;
    assert!(text.contains("does not support ListPlugins"));
    assert!(text.contains("SESSION_NOT_FOUND"));
    state.key(key(KeyCode::Char('r')), Duration::ZERO);
    assert!(!state.plugins.loaded);
    assert!(state.plugins.inventory_error.is_none());
    Ok(())
}

fn draw_scrolled(
    terminal: &mut Terminal<TestBackend>,
    state: &mut State,
) -> Result<(), Box<dyn std::error::Error>> {
    terminal.draw(|frame| {
        state.scroll = view::draw(frame, state, Duration::ZERO);
    })?;
    Ok(())
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
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    for _ in 0..20 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
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
fn viewport_paging_reaches_every_line_with_one_line_of_overlap(
) -> Result<(), Box<dyn std::error::Error>> {
    fn visible(text: &str, kind: &str) -> BTreeSet<usize> {
        let content = if kind == "lane" {
            text.to_owned()
        } else {
            let title = match kind {
                "tool" => "Full output",
                "plan" => "Scratchpad",
                _ => "Procedural rules",
            };
            text.lines()
                .skip_while(|line| !line.contains(title))
                .skip(1)
                .map_while(|line| line.split_once("││").map(|(_, right)| right))
                .collect::<Vec<_>>()
                .join("\n")
        };
        content
            .lines()
            .filter_map(|line| {
                line.split_once(&format!("{kind} "))?
                    .1
                    .chars()
                    .take(2)
                    .collect::<String>()
                    .parse()
                    .ok()
            })
            .collect()
    }
    for height in [30, 33, 45] {
        for (kind, modifiers) in [
            ("tool", KeyModifiers::NONE),
            ("plan", KeyModifiers::SHIFT),
            ("plan", KeyModifiers::ALT),
            ("rule", KeyModifiers::CONTROL),
            ("lane", KeyModifiers::NONE),
        ] {
            let mut state = State::sample()?;
            state.plan = (0..40)
                .map(|i| format!("[ ] plan {i:02}"))
                .collect::<Vec<_>>()
                .join("\n");
            state.rules = (0..40).map(|i| format!("rule {i:02}")).collect();
            state.tools.first_mut().ok_or("missing tool")?.output = (0..40)
                .map(|i| format!("tool {i:02}"))
                .collect::<Vec<_>>()
                .join("\n");
            state.tasks.get_mut("1").ok_or("missing lane")?.text = (0..40)
                .map(|i| format!("lane {i:02}"))
                .collect::<Vec<_>>()
                .join("\n");
            state.select_tool(0);
            state.key(key(KeyCode::Char(' ')), Duration::ZERO);
            if kind == "lane" {
                state.selected = Some(super::state::Selection::Node("1".into()));
            }
            let mut terminal = Terminal::new(TestBackend::new(140, height))?;
            draw_scrolled(&mut terminal, &mut state)?;
            let mut previous = visible(&contents(&terminal), kind);
            let mut seen = previous.clone();
            for _ in 0..40 {
                if seen.len() == 40 {
                    break;
                }
                state.key(KeyEvent::new(KeyCode::PageDown, modifiers), Duration::ZERO);
                draw_scrolled(&mut terminal, &mut state)?;
                let next = visible(&contents(&terminal), kind);
                if previous.len() > 1 && next.last() > previous.last() && next.last() < Some(&39) {
                    assert_eq!(
                        previous.intersection(&next).count(),
                        1,
                        "{kind} at {height} rows"
                    );
                }
                seen.extend(next.iter().copied());
                previous = next;
            }
            assert_eq!(seen.len(), 40, "{kind} at {height} rows: {seen:?}");
            let mut seen = previous;
            for _ in 0..40 {
                if seen.len() == 40 {
                    break;
                }
                state.key(KeyEvent::new(KeyCode::PageUp, modifiers), Duration::ZERO);
                draw_scrolled(&mut terminal, &mut state)?;
                seen.extend(visible(&contents(&terminal), kind));
            }
            assert_eq!(seen.len(), 40, "reverse {kind} at {height} rows: {seen:?}");
        }
    }
    Ok(())
}

#[test]
fn paging_up_moves_immediately_after_the_lanes_reach_bottom(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new(
        "test".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    state.composer = "long answer".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.tasks.values_mut().next().ok_or("missing turn")?.text = (0..100)
        .map(|i| format!("answer {i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    for _ in 0..40 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert!(contents(&terminal).contains("answer 99"));
    state.key(key(KeyCode::PageUp), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(!contents(&terminal).contains("answer 99"));
    state
        .tasks
        .values_mut()
        .next()
        .ok_or("missing turn")?
        .text
        .clear();
    draw_scrolled(&mut terminal, &mut state)?;
    assert_eq!(state.scroll.lane, 0);
    assert!(contents(&terminal).contains("long answer"));
    Ok(())
}

#[test]
fn sticky_panels_scroll_independently_and_do_not_overshoot(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.plan = (0..80)
        .map(|i| format!("[ ] plan {i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    state.rules = (0..80).map(|i| format!("rule {i:02}")).collect();
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    for _ in 0..40 {
        state.key(
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::SHIFT),
            Duration::ZERO,
        );
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert!(contents(&terminal).contains("[ ] plan 79"));
    state.key(
        KeyEvent::new(KeyCode::PageUp, KeyModifiers::SHIFT),
        Duration::ZERO,
    );
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(!contents(&terminal).contains("[ ] plan 79"));
    let plan_scroll = state.scroll.plan;
    for _ in 0..40 {
        state.key(
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::CONTROL),
            Duration::ZERO,
        );
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert!(contents(&terminal).contains("rule 79"));
    assert_eq!(state.scroll.plan, plan_scroll);
    state.key(
        KeyEvent::new(KeyCode::PageUp, KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(!contents(&terminal).contains("rule 79"));
    state.plan.clear();
    state.rules.clear();
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(contents(&terminal).contains("No scratchpad yet"));
    assert!(contents(&terminal).contains("No procedural rules recalled"));
    assert!(contents(&terminal).contains("Alt-PgUp/PgDn plan"));
    assert!(contents(&terminal).contains("Shift alias"));
    assert!(contents(&terminal).contains("Ctrl-PgUp/PgDn rules"));
    Ok(())
}

#[test]
fn hidden_composer_ignores_keys_until_a_visible_frame_is_drawn(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.composer = "hidden draft".into();
    let small = ratatui::layout::Rect::new(0, 0, 119, 45);
    for code in [
        KeyCode::Enter,
        KeyCode::Tab,
        KeyCode::Char('x'),
        KeyCode::Char('q'),
        KeyCode::Backspace,
        KeyCode::Esc,
        KeyCode::Esc,
        KeyCode::Down,
        KeyCode::PageDown,
        KeyCode::Char(' '),
    ] {
        assert!(matches!(
            super::input::handle_key(&mut state, key(code), Duration::ZERO, small),
            Effect::None
        ));
    }
    assert_eq!(state.composer, "hidden draft");
    assert!(state.active.is_none());
    assert_eq!(state.mode, Mode::Architect);
    assert!(state.selected.is_none());
    assert!(matches!(
        super::input::handle_key(
            &mut state,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
            Duration::ZERO,
            small
        ),
        Effect::Quit
    ));
    let large = ratatui::layout::Rect::new(0, 0, 140, 45);
    assert!(
        matches!(super::input::handle_key(&mut state, key(KeyCode::Enter), Duration::ZERO, large), Effect::Submit { text, .. } if text == "hidden draft")
    );
    state.composer.clear();
    assert!(matches!(
        super::input::handle_key(&mut state, key(KeyCode::Char('q')), Duration::ZERO, small),
        Effect::Quit
    ));
    Ok(())
}

#[test]
fn small_terminals_show_a_resize_message_and_recover_at_minimum_size(
) -> Result<(), Box<dyn std::error::Error>> {
    let state = State::sample()?;
    for (width, height) in [(119, 45), (140, 29), (60, 12)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height))?;
        terminal.draw(|frame| {
            view::draw(frame, &state, Duration::ZERO);
        })?;
        let text = contents(&terminal);
        assert!(
            text.contains("terminal too small (need 120x30)"),
            "{width}x{height}: {text}"
        );
        assert!(!text.contains("Execution DAG"));
    }
    let mut terminal = Terminal::new(TestBackend::new(120, 30))?;
    terminal.draw(|frame| {
        view::draw(frame, &state, Duration::ZERO);
    })?;
    let text = contents(&terminal);
    assert!(!text.contains("terminal too small"));
    for expected in [
        "cost unknown",
        "ctx",
        "Execution DAG",
        "Scratchpad",
        "Procedural rules",
        "Compose",
        "Tab mode",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    let mut tiny = Terminal::new(TestBackend::new(1, 1))?;
    tiny.draw(|frame| {
        view::draw(frame, &state, Duration::ZERO);
    })?;
    Ok(())
}

#[test]
fn offline_submissions_finish_as_not_sent_and_can_be_rewound(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.composer = "offline prompt".into();
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Submit { .. }
    ));
    state.not_sent(Duration::from_secs(1));
    assert!(!state.running);
    let task = state
        .active
        .as_ref()
        .and_then(|id| state.tasks.get(id))
        .ok_or("missing turn")?;
    assert_eq!(task.phase.label(), "not sent");
    assert_eq!(task.ended, Some(Duration::from_secs(1)));
    assert!(render(&state)?.contains("not sent"));
    state.key(key(KeyCode::Esc), Duration::from_millis(1010));
    assert!(matches!(
        state.key(key(KeyCode::Esc), Duration::from_millis(1020)),
        Effect::Rewind
    ));
    assert_eq!(state.composer, "offline prompt");
    state.not_sent(Duration::from_secs(2));
    assert!(!state.running);
    Ok(())
}

#[test]
fn paging_up_moves_immediately_after_the_drawer_reaches_bottom(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.select_tool(0);
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    state.tools.first_mut().ok_or("missing tool")?.output = (0..100)
        .map(|i| format!("line {i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    for _ in 0..20 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        terminal.draw(|frame| {
            state.scroll = view::draw(frame, &state, Duration::ZERO);
        })?;
    }
    assert!(contents(&terminal).contains("line 99"));
    state.key(key(KeyCode::PageUp), Duration::ZERO);
    terminal.draw(|frame| {
        state.scroll = view::draw(frame, &state, Duration::ZERO);
    })?;
    assert!(!contents(&terminal).contains("line 99"));
    state
        .tools
        .first_mut()
        .ok_or("missing tool")?
        .output
        .clear();
    terminal.draw(|frame| {
        state.scroll = view::draw(frame, &state, Duration::ZERO);
    })?;
    assert_eq!(state.scroll.drawer, 0);
    Ok(())
}

#[test]
fn second_demo_rewind_keeps_sample_notes_but_removes_its_own(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    let prior = state.notes.clone();
    state.composer = "first".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.event(
        &Event::SessionCompleted {
            session_id: "s".into(),
            reason: "completed".into(),
            scratchpad: None,
        },
        Duration::ZERO,
    );
    state.composer = "second".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    let turn = state
        .active
        .as_ref()
        .and_then(|id| id.strip_prefix("turn-"))
        .ok_or("missing turn id")?
        .parse()?;
    state.notes.push(lain_harness::advisor::AdvisorNote {
        kind: lain_harness::advisor::AdvisorKind::Aside,
        turn,
        text: "current turn".into(),
    });
    state.key(key(KeyCode::Esc), Duration::from_millis(10));
    assert!(matches!(
        state.key(key(KeyCode::Esc), Duration::from_millis(20)),
        Effect::Rewind
    ));
    assert_eq!(state.notes, prior);
    assert_eq!(state.composer, "second");
    Ok(())
}

#[test]
fn q_inserts_into_a_draft_and_only_quits_an_empty_composer(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.composer = "a ".into();
    assert!(matches!(
        state.key(key(KeyCode::Char('q')), Duration::ZERO),
        Effect::None
    ));
    assert_eq!(state.composer, "a q");
    assert!(matches!(
        state.key(
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
            Duration::ZERO
        ),
        Effect::Quit
    ));
    state.composer.clear();
    assert!(matches!(
        state.key(key(KeyCode::Char('q')), Duration::ZERO),
        Effect::Quit
    ));
    Ok(())
}

#[test]
fn sticky_panels_mark_hidden_lines_including_wrapped_rules(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    assert!(!render(&state)?.contains("more below"));
    state.plan = "[ ] long plan\n".repeat(60);
    state.rules = vec!["wrapped rule ".repeat(120)];
    let text = render(&state)?;
    assert!(text.contains("Scratchpad … more below"));
    assert!(text.contains("Procedural rules … more below"));
    state.select_tool(0);
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    let text = render(&state)?;
    assert!(text.contains("Scratchpad … more below"));
    assert!(text.contains("Procedural rules … more below"));
    state.plan.clear();
    state.rules.clear();
    assert!(!render(&state)?.contains("more below"));
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
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    for _ in 0..30 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert!(render(&state)?.contains("answer 99"));
    for _ in 0..30 {
        state.key(key(KeyCode::PageUp), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert!(render(&state)?.contains("answer 00"));
    for _ in 0..30 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
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
