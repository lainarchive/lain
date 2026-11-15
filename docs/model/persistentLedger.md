# M-6 design note — the persistent approval ledger and the DB-backed provider loader

Status: scaffold (uncommitted, pending owner review). Everything here runs, is
tested, and touches nothing outside the model subsystem.

## Why a persisted ledger

The M-5 ledger is a `Map` in process memory: a fresh process sees an empty
history, which is exactly wrong for an audit trail — the record of who decided
what is the asset, and it must outlive the process that recorded it. The
persistent ledger writes the same entries into a SQLite table, using
`node:sqlite` (`DatabaseSync`) — the same built-in the task store and the state
store already use. The brief suggested "vendored sql.js" as a fallback; no
sql.js is vendored in this repository, and none is needed: the built-in is the
SQLite the repo already runs on.

## Schema

```sql
CREATE TABLE IF NOT EXISTS approval_ledger (
  decision_id TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  at          TEXT NOT NULL,
  decided_by  TEXT
);
```

Two deliberate deviations from the brief's schema, both recorded in the module
header:

- **`outcome` was added.** The brief's schema had no outcome column — a ledger
  row that cannot say what was decided is not a ledger.
- **`by` became `decided_by`.** Same data, but it matches the in-memory
  entry's field name and stops reading like a SQL keyword.

The entry shape stays camelCase at the API boundary (`taskId`, `modelId`) and
snake_case only inside the table, so callers of the in-memory and persistent
ledgers see one shape.

## The gate

Every write goes through the real policy engine under a new rule row:

```js
'model.approval.persist': { tool_effect_class: 'local_reversible', requires: ['model.admin'] }
```

Persistence does not lower the bar, it raises the stakes: a durable audit
trail anyone can write is worth less than nothing. Shape validation runs
before the engine (caller errors are caller errors), the duplicate check runs
before the engine (a `decision_id` is never overwritten — the table's
`PRIMARY KEY` is the backstop, the explicit check is the message), and the
recording time is the ledger's clock, not the caller's — same rules as the
in-memory ledger, so the two stay interchangeable. The outcome vocabulary is
now exported from `approvalLedger.mjs` and imported here: one vocabulary for
one concept, no translation layer to get wrong.

Reads (`list`) are ungated, like every other read of history.

## The CLI

```
lain model approval-persist store <db-path> [<decision-id> <task-id> <model-id> <outcome> [--by <who>]]
lain model approval-persist dump  <db-path>
```

`store` with a decision writes that one decision straight into the durable
ledger; `store` without persists whatever the in-memory ledger holds — which
is only meaningful in the process that recorded them, because the in-memory
ledger is process-scoped. A decision already persisted is skipped, so a
re-store after a partial run resumes instead of failing. `dump` prints the
table in insertion order; it opens through the same ledger module, so a
missing table is created (empty result) and a missing file is exit 4. Exit
codes follow the house convention: 0 ok, 2 usage, 3 policy refusal, 4 failure.

## The DB-backed provider loader

`src/model/provider/sqlite.mjs` reads a `providers.db` binding table:

```sql
CREATE TABLE IF NOT EXISTS provider_bindings (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL
);
```

`loadProviderFromDb(dbPath, modelId)` returns `{ provider, endpoint, invoke }`
where `invoke` is a mock shaped like the M-5 stubs — no network, no fetch, no
keys. Failure modes are explicit: a missing database is `ProviderDBNotFound`
(a caller error, caught by callers — not "caught by the policy engine" as the
brief had it; the engine decides permissions, not file existence), an unknown
model is `ProviderNotFound`, and the database is opened **read-only** so a
loader can never create or rewrite its own source of truth.

**No API keys in the database.** A secret at rest in a plaintext SQLite file
is a leak waiting for a backup job. Keys belong in the OS credential store
(Credential Manager / `keytar`-class storage); the binding table carries only
non-secret routing metadata. When real providers arrive, the loader resolves
the binding and the secret is fetched from the credential store at invocation
time, never persisted by Lain.

## Encryption and backup policy

- **At rest:** the ledger contains ids, outcomes and timestamps — no prompts,
  no content, no secrets — so the threat is correlation, not disclosure.
  Protection comes from the state directory's ACLs (the same model that guards
  `state.db`), not from encrypting this table. If the deployment demands
  encryption-at-rest for the ledger too, that is SQLCipher or EFS on the state
  directory — milestone-proper work with its own key-management decision, not
  scaffold scope.
- **Backup:** the state store already uses `node:sqlite`'s `backup()` API
  (`src/store/index.mjs`); the ledger travels with the same backup policy once
  it lives in the state database. The scaffold keeps it in its own file so the
  wiring decision (own file vs. state.db table) stays open and reversible.
- **Append-only:** like the in-memory ledger, rows are never updated or
  deleted by this module. A corrected decision is a new row that supersedes
  the old one — the wiring for supersede semantics is milestone proper.

## What is deliberately not here

- The approval flow does not read the persistent ledger yet — the in-memory
  ledger remains the session record, and deciding when a decision becomes
  durable is milestone-proper design, not scaffold.
- Real provider transports, credential-store integration, and the
  `providers.db` placement in the state directory.
