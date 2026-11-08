# Event store — implemented behaviour

This document describes the event store **as implemented** at commit `e01dbb2`.
It is not the specification it was built from: the proposal is
`docs/research/m1-foundation-readiness/01-event-store-specification.md`, and where
the two differ this document is the record of what is actually true.

## What it is

An append-only event log in one SQLite database file, written through
`node:sqlite` (SQLite 3.53.4, stable in Node 24.21.0 — verified, not assumed: the
module emits no experimental warning and exports `DatabaseSync`, `StatementSync`,
`Session`, `constants` and `backup`).

Everything later records through it: sessions, task state, policy decisions, tool
executions. Its purpose is not logging. It is the system of record that makes
"what did Lain do" answerable after the fact, including after a hard kill.

## Guarantees this implementation provides

**Single writer, decided by SQLite.** Ownership is a long-lived
`BEGIN IMMEDIATE` held for the life of the session and re-taken immediately after
every commit. A second process is refused with `STORE_LOCKED`, not queued:
`busy_timeout` is deliberately `0`, because waiting converts a refusal into a
silent delay and the caller cannot tell the difference between "my turn came" and
"the writer died".

**The lock is not a file.** `<db>.writer.json` and `<db>.writer.lock` are written
for diagnosis only and are never consulted to grant or refuse ownership. This is
the substantive difference from the first implementation attempt: an exclusive
file handle does not exclude on this platform, and the contention test proved it
by opening the same lock file from a second process while the first held it.

**Atomic batches.** Every draft is validated before any is written, so a batch
containing one invalid event writes nothing at all. The batch is then inserted in
one transaction. A partial batch cannot appear committed: either the `COMMIT`
happened or it did not.

**Redaction before persistence, failing closed.** Payloads pass through a filter
that masks sensitive keys and secret-shaped values, and the canonical bytes that
would be stored are then scanned again. If a secret shape survives into those
bytes, `preparePayload` refuses the write with `RESIDUAL_SECRET` rather than
storing it. This exists because the log is append-only: a secret written once is
permanent, and there is no edit operation that could remove it.

**Integrity is checkable, not assumed.** `verify()` reports three named checks —
`sqlite_integrity_check`, `sequence_contiguous`, `payload_hashes` — each with its
own evidence, so a failure names what broke instead of returning a single boolean.

**Damage is reported, not repaired.** `inspect(dbPath)` opens read-only, reports
what it finds, and never takes ownership. A corrupted file is described; nothing
is silently rebuilt.

## Known limitations, stated plainly

1. **A backup briefly releases single-writer ownership.** `node:sqlite`'s backup
   job cannot run while this process holds its write transaction — measured, it
   rejects with `errcode: 0`, `errstr: "not an error"`. `backup()` therefore
   releases the lock for the duration of the copy and re-takes it immediately,
   throwing `STORE_LOCK_LOST` if another writer appeared in that window. The gap
   is real; it exists only while an explicit backup runs.
2. **No retention and no compaction.** The store grows without bound. The
   documented warning threshold is 2 GiB, about 14.7 million events at the
   measured 146 bytes per event.
3. **No tamper-evidence chain.** `payload_hash` detects an edited payload because
   verification recomputes it; a deleted row is detected as a sequence gap. An
   attacker who rewrites both the payload and its stored hash is not detected.
   The hash-chain decision is open (`docs/research/m1-foundation-readiness/08-open-decisions.md`,
   OQ-M1.6/OQ-M1.21).
4. **No encryption at rest.** Redaction protects against secrets being written;
   it does not protect the file from being read.
5. **Ownership of the store is a recommendation, not a decision.**
   `SYSTEM_BOUNDARIES.md` has no row for events, and the ownership model in
   `docs/research/m1-foundation-readiness/02-security-and-containment.md` is
   labelled a recommendation. The implementation does not depend on the answer,
   because it only stores and orders records.

## The boundary that matters most

The store may validate structure, assign and validate identifiers, persist,
maintain ordering, read, answer bounded queries, verify integrity and recover.

It may **not** grant permissions, approve tools, decide authorization, execute
tools, invoke models, or decide which agents may act. That is not a style
preference: `tools/check/store-boundary.mjs` fails the build if code under
`src/store/` calls into policy or authorization, so the boundary is enforced by
the verification gate rather than promised in a document.

## Events and schema

`SCHEMA_VERSION = 1`, `EVENT_TYPES_VERSION = 1`. Columns: `seq` (the ordering
key, integer primary key), `event_id` (ULID, unique), `event_type`,
`schema_version`, `occurred_at`, `recorded_at`, `session_id`, `task_id`,
`producer`, `correlation_id`, `causation_id`, `payload_text`, `payload_hash`,
`redaction_applied`, `redaction_rules`.

The distinction between `occurred_at` (when the thing happened) and `recorded_at`
(when the store learned about it) is deliberate: they differ after a recovery,
and collapsing them would make a late-recorded event look like a live one.

Payloads are canonical JSON with sorted keys, so the same logical payload always
hashes to the same value. Values that cannot be serialized faithfully — `NaN`,
`Infinity`, `bigint`, functions, symbols, `undefined` — are refused by name
rather than coerced, because a coerced value that hashes consistently is worse
than a refusal.

A store whose `schema_version` is newer than this build is refused with
`SCHEMA_MISMATCH`. It is never migrated downwards and never opened optimistically.

## How to use it

```js
import { open } from '../src/store/index.mjs';

const store = open({ path: './artifacts/lain.db', producer: 'lain/cli@0.1.0' });
store.append([{ event_type: 'session.started', occurred_at: new Date().toISOString(), payload: {} }]);
const events = store.read({ limit: 100 });
const verdict = store.verify();
await store.backup({ path: './artifacts/lain-backup.db' });
store.close();
```

## Verification

`node --test --test-reporter=spec "test/store/*.test.mjs"` → 37 tests, 37 pass,
0 fail, including the eight single-writer subprocess cases and their positive
controls. Every denial test is paired with a control that proves the same code
path succeeds when it should, so a test cannot pass by refusing everything.
