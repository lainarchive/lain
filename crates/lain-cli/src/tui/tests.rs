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
        let event = if state.screen == Screen::Creator {
            KeyEvent::new(KeyCode::Right, KeyModifiers::ALT)
        } else {
            key(KeyCode::Char(char::from(b'1' + index as u8)))
        };
        state.key(event, Duration::ZERO);
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
    assert_eq!(state.screen, Screen::Bots);
    state.key(
        KeyEvent::new(KeyCode::Right, KeyModifiers::ALT),
        Duration::ZERO,
    );
    assert_eq!(state.screen, Screen::Session);
    assert_eq!(state.composer, "draft3");
    Ok(())
}

#[test]
fn demo_starts_at_launch_and_the_first_submit_seeds_a_labelled_turn(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_launch()?;
    assert!(state.launch());
    assert!(state.tools.is_empty());
    state.composer = "my own prompt".into();
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Submit { .. }
    ));
    state.seed_demo_turn(Duration::from_secs(2));
    assert!(!state.launch());
    assert_eq!(state.tools.len(), 3);
    let task = state
        .active
        .as_ref()
        .and_then(|id| state.tasks.get(id))
        .ok_or("missing turn")?;
    assert_eq!(task.prompt, "my own prompt");
    assert!(task.text.contains("Canned demo turn"));
    assert!(state.tools.iter().all(|tool| tool.node == task.node.id));
    Ok(())
}

#[test]
fn actual_demo_plugins_include_an_explicit_denied_plugin_permission(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_launch()?;
    state.screen = Screen::Plugins;
    assert!(render(&state)?.contains("✗ network"));
    assert!(state.plugins.tools.iter().any(
        |tool| tool.name == "demo_echo" && tool.permissions.iter().any(|grant| !grant.granted)
    ));
    Ok(())
}

#[test]
fn switching_to_code_recomputes_only_stale_creator_mode_refusals(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_launch()?;
    state
        .creator
        .request(Mode::Architect, super::creator::Operation::Publish);
    assert!(state
        .creator
        .error
        .as_deref()
        .is_some_and(|error| error.contains("Architect is read-only")));
    state.composer = "/code".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(state.creator.error.is_none());
    state.composer = "/architect".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state
        .creator
        .request(Mode::Architect, super::creator::Operation::Publish);
    state.composer = "/ask".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(state
        .creator
        .error
        .as_deref()
        .is_some_and(|error| error.contains("Ask is read-only")));
    state.creator.error = Some("real execution failure".into());
    state.composer = "/ask".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(
        state.creator.error.as_deref(),
        Some("real execution failure")
    );
    Ok(())
}

#[test]
fn multiline_paste_grows_and_scrolls_without_changing_the_submitted_text(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_launch()?;
    let text = (0..12)
        .map(|i| format!("draft-line-{i:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    state.paste(&text);
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(contents(&terminal).contains("draft-line-11"));
    assert!(!contents(&terminal).contains("draft-line-00"));
    for _ in 0..12 {
        state.key(key(KeyCode::Up), Duration::ZERO);
    }
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(contents(&terminal).contains("draft-line-00"));
    assert!(
        matches!(state.key(key(KeyCode::Enter),Duration::ZERO),Effect::Submit {text:submitted,..} if submitted==text)
    );
    Ok(())
}

#[test]
fn demo_new_session_metadata_uses_the_current_clock() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new("demo/workspace".into(), &std::env::current_dir()?)?;
    let now = Duration::from_secs(100);
    state.demo_metadata(now)?;
    state.screen = Screen::Sessions;
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    terminal.draw(|frame| {
        super::view::draw(frame, &state, now);
    })?;
    assert!(contents(&terminal).contains("read just now"));
    Ok(())
}

#[test]
fn help_pages_to_all_commands_at_the_supported_minimum() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.key(key(KeyCode::F(1)), Duration::ZERO);
    let mut terminal = Terminal::new(TestBackend::new(120, 30))?;
    draw_scrolled(&mut terminal, &mut state)?;
    let first = contents(&terminal);
    state.key(key(KeyCode::PageDown), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    let last = contents(&terminal);
    assert_ne!(first, last);
    assert!(last.contains("/rewind"));
    state.key(key(KeyCode::PageUp), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    assert_eq!(contents(&terminal), first);
    state.key(key(KeyCode::Esc), Duration::ZERO);
    assert!(state.overlay.is_none());
    Ok(())
}

#[test]
fn primary_busy_rejection_stops_working_but_steer_errors_do_not(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_turn()?;
    let now = Duration::from_secs(2);
    let event = Event::Error {
        code: "SESSION_BUSY".into(),
        message: "s".into(),
    };
    state.event(&event, now);
    assert!(state.running);
    state.reject_turn("SESSION_BUSY", now);
    assert!(!state.running);
    let task = state
        .active
        .as_ref()
        .and_then(|id| state.tasks.get(id))
        .ok_or("missing active turn")?;
    assert_eq!(task.phase, super::state::Phase::NotSent);
    assert_eq!(task.ended, Some(now));
    assert!(state.notice.contains("SESSION_BUSY"));
    state.running = true;
    state.reject_turn("SESSION_NOT_FOUND", now);
    assert!(!state.running);
    assert_eq!(
        state
            .active
            .as_ref()
            .and_then(|id| state.tasks.get(id))
            .map(|t| t.phase),
        Some(super::state::Phase::Failed)
    );
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
    assert_eq!(
        state.key(key(KeyCode::Esc), Duration::ZERO),
        Effect::Interrupt
    );
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
    assert!(state.running);
    state = state.fresh_session()?;
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
        .next()
        .and_then(|line| line.find("3 Creator"))
        .ok_or("missing tab")?;
    let cell = terminal
        .backend()
        .buffer()
        .cell((x as u16, 0))
        .ok_or("missing cell")?;
    assert_eq!(cell.fg, super::theme::CYAN);
    assert_eq!(cell.bg, super::theme::PANEL);
    state.key(
        KeyEvent::new(KeyCode::Left, KeyModifiers::ALT),
        Duration::ZERO,
    );
    state.key(
        KeyEvent::new(KeyCode::Left, KeyModifiers::ALT),
        Duration::ZERO,
    );
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

#[test]
fn creator_reports_page_by_the_viewport_without_overshooting(
) -> Result<(), Box<dyn std::error::Error>> {
    use super::creator::{Operation, Step};
    let mut state = State::sample()?;
    state.screen = Screen::Creator;
    state.creator.step = Step::Test;
    state.creator.simulate(Operation::Test)?;
    if let Some(report) = &mut state.creator.report {
        report.execution.stdout = (0..100)
            .map(|n| format!("stdout-line-{n:02}"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    for height in [30, 33, 45] {
        let mut terminal = Terminal::new(TestBackend::new(140, height))?;
        state.scroll.creator_output = 0;
        draw_scrolled(&mut terminal, &mut state)?;
        for _ in 0..20 {
            state.key(key(KeyCode::PageDown), Duration::ZERO);
            draw_scrolled(&mut terminal, &mut state)?;
        }
        assert!(contents(&terminal).contains("stdout-line-99"));
        assert_eq!(state.scroll.creator_output, state.scroll.creator_max);
        let bottom = state.scroll.creator_output;
        state.key(key(KeyCode::PageUp), Duration::ZERO);
        assert_eq!(
            state.scroll.creator_output,
            bottom.saturating_sub(state.scroll.creator_page)
        );
    }
    Ok(())
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn launch_state() -> Result<State, Box<dyn std::error::Error>> {
    let mut state = State::new(
        "feat/wired".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    state.plugins = super::plugins::Plugins::sample()?;
    state.session_id = Some("demo-local".into());
    state.model_chain = "demo-model".into();
    state.context = 38_000;
    state.context_window = 1_000_000;
    state.notice = "OFFLINE DEMO · synthetic telemetry".into();
    Ok(state)
}

#[test]
fn themes_cycle_from_slash_and_palette_and_recolor_editors(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = launch_state()?;
    assert_eq!(state.theme, super::theme::Theme::Wired);
    for c in "/theme".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.theme, super::theme::Theme::Mono);
    state.screen = Screen::Creator;
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(terminal
        .backend()
        .buffer()
        .content
        .iter()
        .all(|cell| match cell.fg {
            ratatui::style::Color::Rgb(r, g, b) => r == g && g == b,
            _ => true,
        }));
    state.key(
        KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    for c in "theme".chars() {
        state.key(key(KeyCode::Char(c)), Duration::ZERO);
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.theme, super::theme::Theme::Wired);
    Ok(())
}

#[test]
fn launch_layout_is_responsive_and_footer_uses_known_telemetry(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = launch_state()?;
    let text = render(&state)?;
    for expected in [
        "λ lain v",
        "session",
        "get started",
        "demo-local",
        "/creator",
        "/plugins",
        "/theme",
        "/plugins to find tools",
        "plugin echo",
        "demo_echo",
        "branch:feat/wired",
        "3% 38k/1M",
        "Ask Lain anything",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    if let Some(path) = std::env::var_os("LAIN_VIS_A_DUMP") {
        std::fs::write(path, format!("{text}\n"))?;
    }
    let mut terminal = Terminal::new(TestBackend::new(80, 24))?;
    draw_scrolled(&mut terminal, &mut state)?;
    let compact = contents(&terminal);
    assert!(!compact.contains("terminal too small"));
    assert!(!compact.contains("get started"));
    assert!(!compact.contains("/plugins to find tools"));
    assert!(compact.contains("Ask Lain anything"));
    assert!(compact.contains("/creator"));
    assert!(matches!(
        super::input::handle_key(
            &mut state,
            key(KeyCode::Char('x')),
            Duration::ZERO,
            ratatui::layout::Rect::new(0, 0, 80, 24)
        ),
        Effect::None
    ));
    assert_eq!(state.composer, "x");
    state.model_chain = "model unknown".into();
    state.context_window = 0;
    let text = render(&state)?;
    let footer = text.lines().last().ok_or("missing footer")?;
    assert!(!footer.contains("ctx"));
    assert!(!footer.contains("model unknown"));
    Ok(())
}

#[test]
fn launch_grid_overflow_and_small_screen_guards() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = launch_state()?;
    let mut tool = state.plugins.tools.first().ok_or("missing tool")?.clone();
    tool.source = lain_ipc::ToolSource::Builtin;
    for n in 0..20 {
        tool.name = format!("other_{n:02}");
        state.plugins.tools.push(tool.clone());
    }
    assert!(render(&state)?.contains("+"));
    assert!(render(&state)?.contains("more"));
    for (width, height, cards) in [(100, 24, true), (80, 24, false)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height))?;
        draw_scrolled(&mut terminal, &mut state)?;
        let text = contents(&terminal);
        assert_eq!(text.contains("get started"), cards);
        assert!(!text.contains("/plugins to find tools"));
    }
    assert!(!view::has_room(
        ratatui::layout::Rect::new(0, 0, 79, 24),
        &state
    ));
    state.plugins.tools.clear();
    state.plugins.tools_error = Some("Daemon does not support ListTools".into());
    assert!(render(&state)?.contains("Daemon does not support ListTools"));
    for mode in [Mode::Architect, Mode::Code, Mode::Ask] {
        state.mode = mode;
        assert!(render(&state)?
            .lines()
            .last()
            .unwrap_or("")
            .contains(mode.name()));
    }
    state.composer = "start".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(!state.launch());
    assert!(!view::has_room(
        ratatui::layout::Rect::new(0, 0, 80, 24),
        &state
    ));
    Ok(())
}

#[test]
fn transcript_drawers_working_and_follow_contract() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.tasks.get_mut("2").ok_or("missing task")?.text =
        "**Ready** with `repo_map`.\n- Check evidence\n```rust\nlet safe = true;\n```".into();
    state.running = true;
    state.active = Some("2".into());
    let text = render(&state)?;
    for expected in [
        "λ lain ·",
        "Ready",
        "Check evidence",
        "let safe = true;",
        "Working…",
        "└ Tip:",
        "◆ advisor ·",
        "ctrl+o expands",
        "✱",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    assert!(!text.contains("Execution DAG"));
    assert!(!text.contains("Scratchpad"));
    state.key(
        KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    assert!(render(&state)?.contains("Execution DAG"));
    state.key(
        KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    assert!(render(&state)?.contains("Scratchpad"));
    state.key(
        KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    assert!(state.tools.last().is_some_and(|t| t.expanded));
    state.key(
        KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    state.key(
        KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    state.tasks.get_mut("2").ok_or("missing task")?.text = (0..90)
        .map(|n| format!("line {n:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    draw_scrolled(&mut terminal, &mut state)?;
    state.key(key(KeyCode::PageUp), Duration::ZERO);
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(!state.follow);
    state.event(
        &lain_ipc::Event::StreamToken {
            session_id: "demo".into(),
            text: "new tail".into(),
        },
        Duration::ZERO,
    );
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(contents(&terminal).contains("↓ new output"));
    for _ in 0..8 {
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        draw_scrolled(&mut terminal, &mut state)?;
    }
    assert!(state.follow);
    Ok(())
}

#[test]
fn live_sessions_omit_unknown_columns_and_page_rows() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new(
        "main".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    state.screen = Screen::Sessions;
    state.inspect.sessions.accept(
        (0..40)
            .map(|i| {
                super::inspect::SessionRow::from(lain_ipc::SessionInfo {
                    id: format!("live-{i:02}"),
                    model: Some("known-model".into()),
                    mode: None,
                    turn_count: i,
                    status: None,
                })
            })
            .collect(),
        Duration::ZERO,
    );
    state.inspect.daemon.accept("ready".into(), Duration::ZERO);
    for _ in 0..50 {
        state.key(key(KeyCode::Down), Duration::ZERO);
    }
    assert_eq!(state.inspect.session_selected, 39);
    for (width, height) in [(140, 45), (120, 30)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height))?;
        draw_scrolled(&mut terminal, &mut state)?;
        let text = contents(&terminal);
        assert!(text.contains("live-39"));
        assert!(text.contains("/40 · read just now"));
        for omitted in ["In tokens", "Out tokens", "Cost", "Age", "pid ", "uptime "] {
            assert!(!text.contains(omitted), "invented {omitted}");
        }
    }
    state.key(key(KeyCode::Char('r')), Duration::ZERO);
    assert!(matches!(
        state.inspect.sessions.state,
        super::inspect::ReadState::Idle
    ));
    Ok(())
}

#[test]
fn bots_render_navigation_and_unavailable_state() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_launch()?;
    state.key(key(KeyCode::Char('7')), Duration::ZERO);
    assert_eq!(state.screen, Screen::Bots);
    state.inspect.demo_refresh(Screen::Bots, Duration::ZERO);
    let text = render(&state)?;
    for expected in [
        "Bots",
        "OFFLINE DEMO",
        "running",
        "idle",
        "busy",
        "episodic",
        "procedural",
        "412.3k",
        "~$0.41",
        "38m ago",
        "rows 1-8/8",
        "every 5s",
        "read-only",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(render(&state)?.contains("Attaching is not available"));
    state.key(key(KeyCode::Esc), Duration::ZERO);
    assert_eq!(state.screen, Screen::Session);
    state.composer = "/bots".into();
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert_eq!(state.screen, Screen::Bots);
    assert!(state.composer.is_empty());
    state.screen = Screen::Bots;
    state.toast = None;
    state.inspect.sessions.unavailable("old daemon");
    state.inspect.memory.unavailable("unsupported");
    let text = render(&state)?;
    assert!(text.contains("old daemon"));
    assert!(text.contains("unsupported"));
    state.inspect.sessions.accept(vec![], Duration::ZERO);
    assert!(render(&state)?.contains("No live agents"));
    assert_eq!(
        super::app::matching("bots").first().map(|c| c.action),
        Some(super::app::Action::Go(Screen::Bots))
    );
    Ok(())
}

#[test]
fn bots_refresh_only_while_visible_and_preserves_inflight_reads() {
    use super::inspect::{Inspect, ReadState};
    let mut view = Inspect::default();
    view.tick(Screen::Bots, Duration::ZERO);
    view.sessions.accept(vec![], Duration::ZERO);
    view.tick(Screen::Bots, Duration::from_secs(4));
    assert!(matches!(view.sessions.state, ReadState::Ready(_)));
    view.tick(Screen::Bots, Duration::from_secs(5));
    assert!(matches!(view.sessions.state, ReadState::Idle));
    view.sessions.state = ReadState::Loading;
    view.tick(Screen::Bots, Duration::from_secs(10));
    assert!(matches!(view.sessions.state, ReadState::Loading));
    view.sessions.accept(vec![], Duration::from_secs(11));
    view.tick(Screen::Memory, Duration::from_secs(20));
    assert!(matches!(view.sessions.state, ReadState::Ready(_)));
    view.tick(Screen::Bots, Duration::from_secs(21));
    assert!(matches!(view.sessions.state, ReadState::Idle));
}

#[test]
fn compact_table_numbers_handle_empty_and_invalid_values() {
    use super::formatting::{age, money, number};
    assert_eq!(number(0), "0");
    assert_eq!(number(999), "999");
    assert_eq!(number(412300), "412.3k");
    assert_eq!(number(999999), "1.0M");
    assert_eq!(number(2500000000), "2.5G");
    assert_eq!(money(Some(0.4123)), "~$0.41");
    assert_eq!(money(Some(0.0)), "~$0.00");
    for value in [None, Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
        assert_eq!(money(value), "—");
    }
    assert_eq!(age(0), "just now");
    assert_eq!(age(2280), "38m ago");
}

#[test]
fn bots_live_unknowns_and_numeric_column_alignment() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new(
        "main".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    state.screen = Screen::Bots;
    state.inspect.sessions.accept(
        vec![super::inspect::SessionRow::from(lain_ipc::SessionInfo {
            id: "legacy".into(),
            model: None,
            mode: None,
            turn_count: 0,
            status: None,
        })],
        Duration::ZERO,
    );
    state.inspect.memory.accept(vec![], Duration::ZERO);
    state
        .inspect
        .daemon
        .accept("running".into(), Duration::ZERO);
    let text = render(&state)?;
    assert!(text.contains("1 unknown"));
    for omitted in ["pid ", "up ", "Cost", " Age ", "▰", "▱"] {
        assert!(!text.contains(omitted), "invented {omitted}");
    }
    fn end_column(line: &str, needle: &str) -> Result<usize, Box<dyn std::error::Error>> {
        let index = line.find(needle).ok_or("missing cell")?;
        Ok(line.get(..index).ok_or("invalid prefix")?.chars().count() + needle.chars().count())
    }
    for screen in [Screen::Sessions, Screen::Bots] {
        let mut state = State::demo_launch()?;
        state.screen = screen;
        state.inspect.demo_refresh(screen, Duration::ZERO);
        let text = render(&state)?;
        let header = text
            .lines()
            .find(|line| line.contains("Cost"))
            .ok_or("missing header")?;
        let row = text
            .lines()
            .find(|line| line.contains("demo-local-01"))
            .ok_or("missing row")?;
        assert_eq!(end_column(header, "Cost")?, end_column(row, "~$0.41")?);
        assert_eq!(
            end_column(
                header,
                if screen == Screen::Sessions {
                    "In tokens"
                } else {
                    "In"
                }
            )?,
            end_column(row, "412.3k")?
        );
    }
    Ok(())
}

#[test]
fn memory_detail_pages_by_the_visible_height() -> Result<(), Box<dyn std::error::Error>> {
    for height in [30, 45] {
        let mut state = State::demo_turn()?;
        state.screen = Screen::Memory;
        state.inspect.memory.accept(
            vec![super::inspect::MemoryEntry {
                kind: "episode",
                text: (0..100).map(|i| format!("record line {i}\n")).collect(),
            }],
            Duration::ZERO,
        );
        let mut terminal = Terminal::new(TestBackend::new(140, height))?;
        draw_scrolled(&mut terminal, &mut state)?;
        let page = state.scroll.memory_page;
        assert!(page > 1);
        state.key(key(KeyCode::PageDown), Duration::ZERO);
        assert_eq!(state.scroll.memory_detail, page);
        draw_scrolled(&mut terminal, &mut state)?;
        let right = contents(&terminal)
            .lines()
            .map(|line| line.chars().skip(56).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!right.contains("record line 0"));
        state.key(key(KeyCode::PageUp), Duration::ZERO);
        assert_eq!(state.scroll.memory_detail, 0);
    }
    Ok(())
}

#[test]
fn model_rate_needs_a_real_interval_and_excludes_initial_lifetime_tokens(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::new(
        "main".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    state.screen = Screen::Models;
    assert!(render(&state)?.contains("Current model · unavailable"));
    assert!(!render(&state)?.contains("tok/s"));
    for (at, tokens) in [(0, 10_000), (2, 10_100)] {
        state.event(
            &Event::Telemetry {
                session_id: "live".into(),
                model: "known-model".into(),
                context_tokens: 100,
                context_window: 1000,
                tokens_used: tokens,
                scratchpad: String::new(),
            },
            Duration::from_secs(at),
        );
        if at == 0 {
            assert_eq!(state.token_rate(Duration::ZERO), None);
        }
    }
    assert_eq!(state.token_rate(Duration::from_secs(2)), Some(50.0));
    assert_eq!(state.token_rate(Duration::from_secs(8)), None);
    let text = render(&state)?;
    assert!(text.contains("50.0 tok/s"));
    assert!(text.contains("Tokens used · 10100"));
    assert!(!text.contains("cost $"));
    state
        .inspect
        .config
        .unavailable("Local config metadata unavailable");
    assert!(render(&state)?.contains("Local config metadata unavailable"));
    Ok(())
}

#[test]
fn transcript_polish_uses_compact_arguments_and_useful_tips(
) -> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(super::transcript::arguments("{}"), "");
    assert_eq!(
        super::transcript::arguments(r#"{"path":"crates/lain-cli/src/tui"}"#),
        "crates/lain-cli/src/tui"
    );
    assert_eq!(super::transcript::arguments("invalid"), "invalid");
    let state = State::demo_turn()?;
    let text = render(&state)?;
    assert!(!text.contains("● running"));
    assert!(text.contains("repo_map()"));
    assert!(text.contains("memory_read(Creator publishing workflow)"));
    assert_eq!(text.matches("└ crates/lain-cli").count(), 1);
    assert!(!text.contains("└   creator.rs"));
    assert!(text.contains("Esc Esc rewinds"));
    Ok(())
}

#[test]
fn demo_launch_has_real_builtin_names_and_known_sample_telemetry(
) -> Result<(), Box<dyn std::error::Error>> {
    let state = State::demo_launch()?;
    let text = render(&state)?;
    for expected in [
        "demo-",
        "ctx",
        "cost $",
        "tok/s",
        "memory_read",
        "repo_map",
        "create_tool",
        "test_tool",
        "plugin echo",
        "plugin notes",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    assert!(!text.contains("cost unknown"));
    let fresh = State::new(
        "main".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    assert!(!render(&fresh)?.contains("0.0 tok/s"));
    assert!(!render(&fresh)?.contains("cost unknown"));
    Ok(())
}

#[test]
fn inspection_screens_show_real_data_and_unavailable_states(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::demo_turn()?;
    state.screen = Screen::Sessions;
    let text = render(&state)?;
    for expected in [
        "live sessions",
        "Model",
        "Mode",
        "Turns",
        "rows 1-",
        "read just now",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    state.key(key(KeyCode::Down), Duration::ZERO);
    assert_eq!(state.inspect.session_selected, 1);
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(render(&state)?.contains("not available over the socket yet"));
    state.toast = None;
    state.screen = Screen::Memory;
    assert!(render(&state)?.contains("episodic"));
    state.key(key(KeyCode::Char('/')), Duration::ZERO);
    state.paste("unsandboxed");
    assert!(render(&state)?.contains("unsandboxed"));
    assert!(!render(&state)?.contains("episode ·"));
    state.key(key(KeyCode::Char('6')), Duration::ZERO);
    assert_eq!(state.screen, Screen::Memory);
    state.key(key(KeyCode::Esc), Duration::ZERO);
    state.screen = Screen::Models;
    for expected in [
        "Current model",
        "Context",
        "Tokens used",
        "cost $",
        "Configured locally",
        "open_ai_compatible",
        "selection",
    ] {
        assert!(render(&state)?.contains(expected), "missing {expected}");
    }
    let mut fresh = State::new(
        "main".into(),
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    for screen in [Screen::Sessions, Screen::Memory, Screen::Models] {
        fresh.screen = screen;
        let text = render(&fresh)?;
        assert!(!text.contains("cost $"));
        assert!(!text.contains("0.0 tok/s"));
        assert!(!text.contains("In tokens"));
    }
    fresh.inspect.sessions.unavailable("unsupported");
    fresh.inspect.memory.unavailable("unsupported");
    for screen in [Screen::Sessions, Screen::Memory] {
        fresh.screen = screen;
        assert!(render(&fresh)?.contains("not available over the socket yet"));
    }
    fresh.inspect.sessions.accept(vec![], Duration::ZERO);
    fresh.screen = Screen::Sessions;
    let text = render(&fresh)?;
    assert!(text.contains("No live sessions"));
    assert!(text.contains("rows 0-0/0"));
    fresh.inspect.memory.accept(vec![], Duration::ZERO);
    fresh.screen = Screen::Memory;
    assert!(render(&fresh)?.contains("No matching memory"));
    Ok(())
}

#[test]
fn markdown_styles_fences_and_drawer_defaults() -> Result<(), Box<dyn std::error::Error>> {
    let spans = super::transcript::inline("**bold** and `code` and **unfinished");
    assert!(spans.iter().any(|span| span.content == "bold"
        && span
            .style
            .add_modifier
            .contains(ratatui::style::Modifier::BOLD)));
    assert!(spans
        .iter()
        .any(|span| span.content == "code" && span.style.fg == Some(super::theme::CYAN)));
    assert!(spans
        .iter()
        .any(|span| span.content.contains("**unfinished")));
    assert!(super::transcript::markdown("", 80).is_empty());
    let lines = super::transcript::markdown("```rust\nlet x = 1;\n```", 80);
    assert!(lines.iter().any(|line| line.to_string().ends_with('│')));
    assert_ne!(
        super::transcript::spinner(Duration::ZERO),
        super::transcript::spinner(Duration::from_millis(100))
    );
    let mut state = State::demo_turn()?;
    let mut terminal = Terminal::new(TestBackend::new(160, 45))?;
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(state.scroll.dag_visible && state.scroll.plan_visible);
    state.key(
        KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    state.key(
        KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    draw_scrolled(&mut terminal, &mut state)?;
    assert!(!state.scroll.dag_visible && !state.scroll.plan_visible);
    let count = state.plugins.tools.len();
    state.plugins = super::demo::catalog()?;
    assert_eq!(state.plugins.tools.len(), count);
    let mut state = State::demo_launch()?;
    state.composer = "first line\nsecond line".into();
    assert!(matches!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Submit { .. }
    ));
    assert!(render(&state)?.contains("second line"));
    let mut terminal = Terminal::new(TestBackend::new(140, 45))?;
    draw_scrolled(&mut terminal, &mut state)?;
    let y = contents(&terminal)
        .lines()
        .position(|line| line.contains("first line"))
        .ok_or("missing prompt")? as u16;
    assert_eq!(
        terminal
            .backend()
            .buffer()
            .cell((139, y))
            .ok_or("missing cell")?
            .bg,
        super::theme::PANEL
    );
    state.key(key(KeyCode::Up), Duration::ZERO);
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    assert!(render(&state)?.contains("▸ layer 1"));
    assert!(!render(&state)?.contains("second line"));
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    assert!(render(&state)?.contains("second line"));
    Ok(())
}

#[test]
fn creator_steps_validate_schema_and_keep_editor_drafts() -> Result<(), Box<dyn std::error::Error>>
{
    use super::creator::{editor, Step};
    let mut state = State::sample()?;
    state.screen = Screen::Creator;
    state.key(key(KeyCode::Tab), Duration::ZERO);
    assert_eq!(state.creator.step, Step::Schema);
    state.creator.schema = editor("{", "Input schema");
    assert!(render(&state)?.contains("Invalid schema"));
    state.creator.schema = editor(r#"{"type":7}"#, "Input schema");
    assert!(state.creator.schema_value().is_err());
    state.creator.schema = editor(r#"{"type":"object"}"#, "Input schema");
    assert!(render(&state)?.contains("Valid schema"));
    state.key(
        KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        Duration::ZERO,
    );
    assert_eq!(state.creator.step, Step::Interpreter);
    state.key(key(KeyCode::Down), Duration::ZERO);
    assert_eq!(
        state.creator.interpreter,
        lain_core::plugin::manifest::ScriptInterpreter::Powershell
    );
    state.key(key(KeyCode::Tab), Duration::ZERO);
    state.creator.source = editor("", "Source");
    for c in "q12?".chars() {
        assert_eq!(
            state.key(key(KeyCode::Char(c)), Duration::ZERO),
            Effect::None
        );
    }
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.key(key(KeyCode::Char('x')), Duration::ZERO);
    assert_eq!(state.creator.source.lines(), &["q12?", "x"]);
    assert!(state.overlay.is_none());
    state.key(
        KeyEvent::new(KeyCode::Right, KeyModifiers::ALT),
        Duration::ZERO,
    );
    state.key(
        KeyEvent::new(KeyCode::Left, KeyModifiers::ALT),
        Duration::ZERO,
    );
    assert_eq!(state.creator.source.lines(), &["q12?", "x"]);
    state.key(key(KeyCode::BackTab), Duration::ZERO);
    assert_eq!(state.creator.step, Step::Interpreter);
    Ok(())
}

#[test]
fn creator_publish_requires_code_access_and_typed_confirmation(
) -> Result<(), Box<dyn std::error::Error>> {
    use super::creator::{Operation, Step};
    let mut state = State::sample()?;
    state.screen = Screen::Creator;
    state.creator.step = Step::Publish;
    assert!(render(&state)?.contains("Publish disabled: Architect"));
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    assert!(state.overlay.is_none());
    state.mode = Mode::Ask;
    assert!(render(&state)?.contains("Publish disabled: Ask"));
    state.mode = Mode::Code;
    state.creator.allowed = Some(false);
    assert!(render(&state)?.contains("creator mode is disabled"));
    state.creator.allowed = Some(true);
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.paste("y");
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    let text = render(&state)?;
    for expected in [
        "Confirm publish",
        ".lain/tools/tool-demo_created.py",
        ".lain/tools/tool-demo_created.json",
        "read_fs",
        "subprocess",
        "unsandboxed",
        "host user",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    state.key(key(KeyCode::Char('y')), Duration::ZERO);
    state.mode = Mode::Ask;
    assert_eq!(state.key(key(KeyCode::Enter), Duration::ZERO), Effect::None);
    state.key(key(KeyCode::Esc), Duration::ZERO);
    state.mode = Mode::Code;
    state.key(key(KeyCode::Enter), Duration::ZERO);
    state.key(key(KeyCode::Char('y')), Duration::ZERO);
    assert_eq!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Creator(Operation::Publish)
    );
    state.creator.dirty = true;
    state.creator.simulate(Operation::Publish)?;
    assert!(state.creator.dirty);
    assert!(render(&state)?.contains("SIMULATED publish"));
    assert!(render(&state)?.contains("no files written"));
    state.creator.step = Step::Test;
    assert_eq!(
        state.key(key(KeyCode::Enter), Duration::ZERO),
        Effect::Creator(Operation::Test)
    );
    state.creator.simulate(Operation::Test)?;
    let text = render(&state)?;
    for expected in [
        "SIMULATED test",
        "Exit: 0",
        "Stdout",
        "Stderr",
        "Result",
        "Duration:",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
    Ok(())
}

#[test]
fn creator_rejects_invalid_drafts_and_pastes_without_submitting(
) -> Result<(), Box<dyn std::error::Error>> {
    use super::creator::{editor, Step};
    let mut state = State::sample()?;
    state.paste("keep\nthis draft");
    assert_eq!(state.composer, "keep\nthis draft");
    state.screen = Screen::Creator;
    state.creator.step = Step::Source;
    state.creator.source = editor("", "Source");
    state.paste("first\nsecond");
    assert_eq!(state.creator.source.lines(), &["first", "second"]);
    state.creator.busy = true;
    state.paste("must not insert");
    assert_eq!(state.creator.source.lines(), &["first", "second"]);
    state.creator.busy = false;
    state.creator.source = editor("", "Source");
    assert!(state.creator.proposal().is_err());
    state.creator.source = editor("print('x')", "Source");
    state.creator.args = editor("{", "Sample input");
    assert!(state.creator.proposal().is_err());
    state.creator.args = editor("{}", "Sample input");
    state.creator.name = editor("../escape", "Name");
    state.mode = Mode::Code;
    state.creator.step = Step::Publish;
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(state.overlay.is_none());
    assert!(state
        .creator
        .error
        .as_deref()
        .is_some_and(|error| error.contains("Name needs")));
    state.creator.name = editor("ok", "Name");
    state.creator.allowed = None;
    state.key(key(KeyCode::Enter), Duration::ZERO);
    assert!(state.overlay.is_none());
    state.creator.schema = editor("[]", "Schema");
    assert!(state.creator.schema_value().is_err());
    Ok(())
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
    assert_eq!(state.creator.template.as_deref(), Some("echo"));
    assert_eq!(state.creator.name.lines(), &["demo_echo"]);
    assert!(state
        .creator
        .description
        .lines()
        .join("\n")
        .contains("webhook"));
    assert!(state.creator.schema_value()?.get("properties").is_some());
    assert_eq!(state.creator.source.lines(), &[""]);
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
    assert!(state.creator.template.is_none());
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
    let mut state = State::sample()?;
    state.dag_drawer = Some(true);
    state.plan_drawer = Some(true);
    let text = render(&state)?;
    for expected in [
        "planner → coder → advisor",
        "tok/s",
        "ctx",
        "32%",
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
    assert!(text.contains("output 02"));
    assert!(!text.contains("output 03"));
    assert!(text.contains("+9 lines · ctrl+o expands"));
    state.select_tool(0);
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    let expanded = render(&state)?;
    assert!(expanded.contains("output 11"));
    assert!(!expanded.contains("Scratchpad"));
    state.key(key(KeyCode::Char(' ')), Duration::ZERO);
    state.plan_drawer = Some(true);
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
        Effect::Interrupt
    ));
    assert!(!state.running);
    assert!(render(&state)?.contains("interrupted"));
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
    assert!(render(&state)?.contains("get started"));
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
        let content = {
            let title = match kind {
                "lane" => "Execution DAG",
                "tool" => "Full output",
                "plan" => "Scratchpad",
                _ => "Procedural rules",
            };
            text.lines()
                .skip_while(|line| !line.contains(title))
                .skip(1)
                .map_while(|line| {
                    line.split_once('│')
                        .and_then(|(_, right)| right.rsplit_once('│').map(|(content, _)| content))
                })
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
            state.follow = false;
            state.plan_drawer = Some(true);
            state.dag_drawer = Some(kind == "lane");
            state.dag_focus = kind == "lane";
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
    assert_eq!(state.scroll.transcript, 0);
    assert!(contents(&terminal).contains("long answer"));
    Ok(())
}

#[test]
fn sticky_panels_scroll_independently_and_do_not_overshoot(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut state = State::sample()?;
    state.plan_drawer = Some(true);
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
    for expected in ["ctx", "Verify integration", "Ask Lain anything", "Tab mode"] {
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
    state.plan_drawer = Some(true);
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
    state.follow = false;
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
