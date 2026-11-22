# UI/UX and frontend standards

**Scope:** every Lain interface. Interfaces are clients
(ADR-003): they observe Core state through versioned APIs and the event bus, and they never own canonical task,
session, policy or memory state.

- **Terminal UI** is `@opentui/core` (`src/ui/`, `lain tui`). Its measured renderer facts, layout, focus and key rules live
  in `.agents/skills/lain-opentui/SKILL.md`; this file adds the shared design system and does not repeat them.
- **Web UI** is the [neural dashboard](../dashboard/README.md), served by the Rust CLI's Axum bridge.
  Adding packages still needs owner approval and an edit to `tools/check/repo-hygiene.mjs`.
  The desktop framework remains open (ADR-010).

## 1. Design system

**Dark first.** Dark is the default theme, not a variant. Light is opt-in and derived from the same tokens.

**Minimal and typography-driven.** Hierarchy comes from type size, weight and spacing, not from boxes, shadows, gradients
or illustration. No decorative imagery, no animation that does not report state.

**Tokens, not values.** Colours, spacing, radii and type are named semantic tokens, defined once and shared by terminal
and web:

| Token | Role |
| --- | --- |
| `bg`, `bg-raised`, `bg-sunken` | surfaces, at most three levels |
| `fg`, `fg-muted`, `fg-faint` | text emphasis |
| `border` | the only divider colour |
| `accent` | focus, selection, the one interactive highlight |
| `ok`, `warn`, `err`, `info` | status only, never decoration |

- Web: tokens are CSS variables on `:root` (dark) and `[data-theme=light]`, mapped into `tailwind.config` `theme.extend`.
  Components use token classes (`bg-raised`, `text-fg-muted`); raw hex values and arbitrary Tailwind values
  (`text-[#9a9a9a]`) are rejected in review.
- Terminal: the same token names map to the OpenTUI palette. Restrained contrast on near-black; no saturated primaries on
  `#000`.
- Status is never colour alone. Pair it with a word or glyph (`ok`, `FAILED`, `●`), so it survives monochrome terminals and
  colour-blind readers.

**Typography.**

- Two families: one sans for prose and labels, one monospace for identifiers, paths, digests, numbers and logs.
- A short scale (12, 13, 14, 16, 20 px on web). Body is 13 or 14 px. Headings are rare.
- Numbers use `tabular-nums` and right alignment so columns do not jitter as values change.

**Primitives.**

- Web components are built on Radix primitives through shadcn/ui, copied into the repository and themed with the tokens.
  Accessibility (focus trap, roles, keyboard) comes from Radix; do not reimplement it.
- Icons are Lucide, 16 px, stroke 1.5, always with an accessible label or adjacent text. No other icon set.
- No component library beyond these without owner approval.

## 2. Information density

The primary surface is an operations dashboard for autonomous work: many tasks, agents and events, read at a glance.

- Tables over cards. One row per entity, compact row height (28-32 px on web, one line in the terminal).
- Every screen answers, without a click: what is running, what is blocked and why, what it costs, what needs approval.
- Identifiers are truncated in the middle (`tsk_8f3a…c21e`) with the full value on hover or copy.
- Timestamps show relative time with the absolute ISO time on hover; durations use one consistent unit per column.
- Approvals, policy refusals and spend are always visible and never behind a collapsed panel (ADR-004, ADR-005).
- Long event streams are virtualised and follow the tail until the user scrolls up, then hold position.
- Empty, loading and error states are designed, terse and state the cause and the next action.
- Full keyboard operation: every action has a key, and the active shortcuts are visible.

## 3. State and performance

**Server state and client state are separate.**

- Server state is anything Core owns: tasks, sessions, events, approvals, spend. It lives in a query cache keyed by
  resource (TanStack Query is the default candidate), filled by queries and updated by Core events. It is never copied
  into component state or a client store.
- Client state is UI-only: selection, focus, open panes, filters, scroll position. It lives in component state or the URL;
  a small store only when several distant components share it.
- Derived values are computed with selectors at read time, not stored.

**Optimistic updates, within the authority model.**

- Optimistic updates apply to UI-local and low-risk, reversible operations (reorder, pin, rename a view). The change shows
  immediately, is marked pending, and is rolled back with an explained error if Core refuses.
- Never optimistic for anything the Policy Engine decides: approvals, task admission, tool execution, spend, extension
  activation. Those show `pending` until Core records the outcome, because a UI that shows an approval Core has not
  granted is a false claim of authority.

**Zero unnecessary re-renders.**

- Subscribe to the narrowest slice: selector-based subscriptions, never a whole store or a context whose value changes
  per event.
- Stable keys from entity IDs, never array indices. Stable callbacks and props across renders.
- Batch event-driven updates per animation frame; one Core event must not trigger a full-table re-render.
- Measure before and after with the React Profiler (web) or frame capture (terminal) when a change touches a hot path,
  and put the number in the PR.
- Terminal: repaint by reassigning `content`, as the OpenTUI skill records; never rebuild the renderable tree per event.

## 4. Verification

- Terminal: headless frame tests with `@opentui/core/testing`, plus the `npm test` and `npm run verify` gates.
- Web, once it exists: component tests for every state (empty, loading, error, populated, pending, refused), a keyboard-only
  pass, and a check that no raw colour values entered the diff.
