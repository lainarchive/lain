---
name: lain-opentui
description: >-
  Build, modify, and test Lain's terminal UI using @opentui/core 0.9.0 and
  @opentui/core/testing. Use for any task touching src/ui/, src/cli/commands/tui.mjs,
  src/model/eventBus.mjs, or TUI dashboard views.
---

# Lain OpenTUI Development (`@opentui/core` 0.9.0)

## 1. Architecture & Boundaries

- **Core -> UI only via `src/model/eventBus.mjs`**: `publishTaskEvent` fires
  after the SQLite event store accepts an event. Publishing is fire-and-forget;
  a UI subscriber must never throw into or block Core.
- **Read-only UI**: mutations belong in the CLI and Policy Engine, never in
  UI event handlers.
- **Dynamic import**: `src/cli/commands/tui.mjs` must dynamically `import('../../ui/main.mjs')`
  so non-TUI CLI commands never load the Zig FFI.
- **Testable state + string layer**: keep pure state folding (`applyTaskEvent`)
  and deterministic plain-string rendering (`renderDashboard`) separate from
  OpenTUI renderables so logic tests run without a renderer.

## 2. Measured `@opentui/core` 0.9.0 Facts (Do Not Re-learn)

- **`TextTableRenderable`**: no row mutation API; update by reassigning
  `table.content`. `TextTableContent` is rows-of-cells (do not nest header
  cells in separate rows).
- **Styled headers**: `bold()` chunks printed `[object Object]` in measured
  frames; build styled cells with `createTextAttributes` instead.
- **`TextRenderable.add()`**: does not insert a newline; end every log line
  with `\n`.
- **`ScrollBoxRenderable`**: `stickyScroll: true` overrides manual scrolling.
  Implement follow-until-scrolled-up with `scrollChildIntoView(..., align: 'end')`
  and resume following when the user scrolls back down.
- **Layout**: place fixed-height panels (e.g., log box) so variable-height
  tables clip at the frame edge instead of pushing controls off-screen.
- **Quit path**: pass `exitOnCtrlC: false` to `createCliRenderer`, handle `q`
  and Ctrl-C via `renderer.keyInput.on('keypress', ...)`, then call
  `view.dispose()`, `renderer.destroy()`, and `await renderer.closed`.

## 3. Production TUI Design Rules (from `tui-design`)

- **Responsive Breakpoints:** Support `80x24` minimum; below `80` cols, collapse sidebars or switch to stacked/tabbed panes.
- **Focus & Keyboard UX:** Show a clear active-pane indicator (`>` or accent border), support `Tab`/`Shift+Tab` pane cycling, `j`/`k` alongside `↑`/`↓`, `Esc` to close modals, and a pinned bottom footer listing active shortcuts.
- **Palette & Unicode Discipline:** Avoid raw saturated primaries on `#000`; use restrained semantic contrast tokens, and keep box/cell widths Unicode-safe so frames never wrap or jitter.

## 4. Verification

Run headless renderer frame tests with `@opentui/core/testing`
(`createTestRenderer`, `captureCharFrame`, `mockInput`):

```powershell
node --test test/ui/dashboard.test.mjs
```
