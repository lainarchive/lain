# Approval ledger (M-5 design note)

**Status:** scaffold — the ledger exists in memory and is gated like every
other write; persistence is the milestone proper.

## Why a ledger

The M-3 gate (`requireHumanApproval`) *asks*; nothing *remembers*. A human
approval that leaves no record cannot be audited, cannot be revisited when
someone asks "who let the external model run on that task?", and cannot be
replayed into policy decisions later. The ledger is the missing memory: one
entry per human decision, keyed by the `decision_id` of the policy decision
that required it.

## What exists

- `src/model/approvalLedger.mjs` — `recordApproval(entry, options)` is the
  one write path. It validates shape first (non-empty `decision_id`,
  `taskId`, `modelId`; `outcome` in the engine's own approval vocabulary
  `pending | granted | denied | timed_out`; duplicate `decision_id`
  refused, never overwritten), then asks the real engine under the
  `model.approval.record` rule (requires `model.admin`), then stores the
  entry with the **ledger's** timestamp — a caller-supplied `at` is not
  trusted. `listApprovals()` returns copies in insertion order;
  `resetApprovals()` is a test seam only.
- `src/policy/rules.mjs` — `model.approval.record`:
  `{ tool_effect_class: 'local_reversible', requires: ['model.admin'] }`.
  The brief asked for `internal`, which is not in the engine's vocabulary
  (`EFFECT_CLASSES` in `src/policy/arms.mjs`); `local_reversible` is the
  honest class for in-memory bookkeeping, matching `model.reclassify`.
- `src/cli/commands/model-approval-record.mjs` —
  `lain model approval-record list` (read-only dump, exit 0) and
  `lain model approval-record add <decision-id> <task-id> <model-id>
  <outcome> [--by <who>]` (gated write; exit 0 / 3 policy refusal /
  4 shape error / 2 usage).

## Why `add` is not a raw add

An audit trail any caller can write is worth nothing — the value of the
ledger is that its contents were authorized. So the brief's `add(entry)`
became `recordApproval`, which asks the gate first. Shape errors are thrown
before the engine is consulted: the gate decides whether a *valid* record
may be written, not whether garbage may be written.

## How it will be persisted (future)

The module-level `Map` is the seam. The milestone proper replaces it with
SQLite (already the store backend elsewhere in Lain) behind the same three
functions; the shape validation and the gate stay. The ledger must be
append-only in its durable form: no update, no delete, supersede-by-new-
entry if a decision is revised.

## Privacy considerations

Entries carry ids and outcomes, not prompts: `decision_id`, `taskId`,
`modelId`, `outcome`, `at`, optional `decided_by`. Prompt text and model
output stay out of the ledger — they belong to the task record, where they
are already bounded and inspectable. `decided_by` records who answered,
which is the point of an audit trail; if a deployment has several humans,
that field is what makes the record answerable. When persistence lands,
the ledger inherits the store's file permissions and stays inside the
state base the boundary check already guards.
