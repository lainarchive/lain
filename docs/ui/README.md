# The TUI dashboard (`lain tui`)

A full-screen live view of what Core is doing: one table of tasks and one
scrolling event log, fed by the Core event bus. Milestone 9(a); renderer is
[@opentui/core](https://www.npmjs.com/package/@opentui/core) 0.9.0, which needs
Node ≥ 26.4 (the repo's `engines` field moved from `^24` to `^26.4.0` with the
owner's authorization; the system Node was left untouched and a 26.x runtime
sits beside it at `~/.local/lain-node`).

## Run it

```
lain tui
```

Keys: `q` or Ctrl-C quits, `r` re-renders, `↑`/`↓` scroll the log. A piped
invocation (no TTY) refuses with exit 4 instead of hanging or writing escape
sequences into a log.

## How events reach the screen

`src/agent/task-runner.mjs` records every task event in the store first, then
publishes the same shape to `src/model/eventBus.mjs` (`publishTaskEvent`). The
publish is fire-and-forget: a live observer can never break a task's
recording, and the store remains the only durable record. The dashboard
(`src/ui/dashboard.mjs`) subscribes, folds events into a state object
(`applyTaskEvent`), repaints the table by reassigning its `content`, and
appends one log line per event.

The state layer and a plain-string renderer (`renderDashboard`) are the same
module's exports — they are what the tests snapshot deterministically without
a terminal. The OpenTUI view is a thin projection of the same state.

## Measured renderer facts (why the code looks like this)

- `TextTableRenderable` has no row mutation: the only update is reassigning
  `content`. `TextTableContent` is rows-of-cells — the first draft nested each
  header cell in its own row and the renderer printed the objects raw.
- The styled-text helpers (`bold` et al) produced chunks the renderer printed
  as `[object Object]` in the measured frame; header cells are therefore built
  by hand with `createTextAttributes`.
- `TextRenderable.add()` does not imply a line break — consecutive adds
  concatenate — so every log line ends in `\n`.
- `ScrollBoxRenderable` with `stickyScroll: true` pins to the bottom on every
  render, overriding manual scrolling. The dashboard instead follows new lines
  (`scrollChildIntoView … align: 'end'`) until the user scrolls up; scrolling
  down resumes following.
- The log sits above the table at a fixed height so a long task list can never
  push it off-screen; the table clips at the frame edge.

## Tests

`test/ui/dashboard.test.mjs` — AT-M9-01..09: state machine, unknown-event
policy, log bound, a deterministic string snapshot, bus wiring, and two tests
that drive a **real** renderer through `@opentui/core/testing`
(`createTestRenderer` + `captureCharFrame`): one asserts the frame shows the
table and log, one drives the same key wiring `main.mjs` installs through
`mockInput.pressArrow` and asserts follow/scroll-up/resume.

## Not in this milestone

Mouse wheel scrolling, themes/colors beyond the header's bold, task detail
views, and any write action from the UI. The dashboard is read-only by
design — every mutation still goes through the CLI and the Policy Engine.
