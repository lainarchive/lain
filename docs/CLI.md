# Lain CLI

Every command prints exactly one JSON document on success. Exit codes:
`0` success, `2` usage, `3` refused (policy or explicit refusal), `4` failed.

Run `lain` with no arguments for the full usage text.

## Model commands

### `lain model run <task.json>`

Runs a task against the mock model through the Policy Engine (`model.invoke`,
read-only). The task JSON must carry a non-empty `prompt` and its
`granted_capabilities` decide whether the invocation is granted.

### `lain model approve <task.json> <model-id>`

Asks the human-approval gate (`requireHumanApproval`) for a model whose
registry descriptor is `external`; the engine answers `require_approval` (A5)
and the command records the decision.

### `lain model reclassify <model-id> <new-effect>`

Authorized override (requires `model.admin`): changes a model's effective
effect class for this process and logs the change. The frozen registry stays
the audited default. Unknown model → `4`, invalid class → `4`, refused → `3`.

### `lain model approval-record list | add <decision-id> <task-id> <model-id> <outcome> [--by <who>]`

The in-memory approval ledger. `list` reads; `add` is gated under
`model.approval.record` (requires `model.admin`). Outcomes:
`pending`, `granted`, `denied`, `timed_out`. Duplicate `decision-id` → `4`.

### `lain model approval-persist store <db-path> [<decision-id> <task-id> <model-id> <outcome> [--by <who>]] | dump <db-path>`

The SQLite approval ledger (`node:sqlite`). `store` with the direct-entry form
writes one gated record (requires `model.admin`); without it, it flushes the
process's in-memory ledger and skips duplicates, so a resume is idempotent.
`dump` reads the ledger back. Missing DB file on `dump` → `4`.

### `lain model invoke <task.json> <provider>`

M-7 scaffold. Routes the task to a provider adapter through the Policy Engine
(`model.invoke`, read-only). Known providers: `openai`, `gemini`, `local` —
all of them answer from local stubs; no network call is made. The result
document includes the masked credential status (`source`, `apiKey`) from
`src/model/provider/credentials.mjs`. Unknown provider → `4`. `--live` is
refused (`3`): real transports are the milestone proper and start only with
the owner's approval.

### `lain model credentials list`

M-7 scaffold. Reports, for `openai` and `gemini`, where a credential would
come from (`env`, `env-file`, `none`) with the key masked (`****` + last four,
or `(absent)`). The command never prints a raw key and never writes one.
