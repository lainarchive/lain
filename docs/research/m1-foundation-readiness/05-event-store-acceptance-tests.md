# 05 — Event Store Acceptance Tests

**Status:** Proposed test specification. **No test in this document has been executed** — the system under test does not exist. Every "expected result" is a design requirement, not an observation.
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** ESR · UAP · OQ · M (threshold measured on this machine) · D (derived by a stated rule) · P (proposed, needs measurement).
**Harness:** defined in `04-build-and-verification-system.md` §7 — `test/<class>/<test-id>.test.mjs`, fixtures under `test/fixtures/<test-id>/`, raw output retained under `artifacts/verify/<timestamp>/`.

**Non-vacuity rule (ESR).** Every denial-class test below requires a **positive control** that demonstrates the mechanism *can* succeed when it should. A suite of refusal tests passes trivially on a system that refuses everything — which is exactly the defect class the audit found in `ACCEPTANCE_TESTS.md` (39 tests, zero thresholds, none able to fail).

---

## Class 1 — Writer discipline

### AT-M1-01 — Single writer acquires the store; a second writer fails loudly
- **Preconditions:** store initialized; no other writer.
- **Procedure:** open writer W1; from a **separate process**, attempt to open W2 on the same path.
- **Expected:** W1 holds the lock; W2 exits non-zero within **2 s (P)** with a distinguishable error naming the holder's PID and start time; the store's contents are unchanged.
- **Failure conditions:** W2 blocks indefinitely; W2 succeeds; W2 exits zero; the error is indistinguishable from a generic I/O failure; the store file is modified.
- **Evidence:** both processes' exit codes and stderr; lock file contents; `max(seq)` before/after.
- **Positive control:** opening a *reader* on the same store while W1 holds the lock succeeds.

### AT-M1-02 — Lock is released on graceful shutdown
- **Procedure:** open W1, close it, then open W2.
- **Expected:** W2 acquires the lock immediately (≤ 500 ms, **P**); a `store.closed` event exists.
- **Failure conditions:** the lock persists; W2 reports `previous_session_ungraceful=false` incorrectly.
- **Positive control:** kill W1 without closing, then open W2 → W2 acquires, reports `previous_session_ungraceful=true`, and records a `store.lock.reclaimed` event.

### AT-M1-03 — Stale lock reclamation is recorded
- **Procedure:** synthesize a lock file whose PID is not alive (or whose `boot_id` differs), then open a writer.
- **Expected:** reclamation succeeds; a `store.lock.reclaimed` event is appended recording the previous holder and the reason.
- **Failure conditions:** silent reclamation with no event; refusal to open; reclamation of a lock whose holder **is** alive.
- **Positive control:** a lock whose holder is alive is **not** reclaimed.

## Class 2 — Concurrency and isolation

### AT-M1-04 — Two processes cannot corrupt a store
- **Procedure:** start 2 writers and 4 readers against one store for **30 s (P)**, each writer attempting batches; readers continuously verify `seq` contiguity and per-batch `count == last_seq − first_seq + 1`.
- **Expected:** at most one writer is ever admitted; readers observe **0** torn batches; `PRAGMA integrity_check` returns `ok`; the final `max(seq)` equals total admitted events.
- **Failure conditions:** any torn batch; any integrity error; interleaved batch allocation; a reader error that is not a clean "writer unavailable".
- **Evidence:** per-process logs, integrity check output, batch contiguity report.
- **Note (ESR):** this test is the one that closes the gap in the historical measurement, which compared commit strategies **within one process** and did not test multi-process writers.

### AT-M1-05 — Concurrent readers see consistent snapshots
- **Procedure:** hold a read transaction open while a writer appends 1 000 events in 10 batches.
- **Expected:** the reader's view is stable for the transaction's duration (it never observes a partially committed batch); after the reader re-opens, it sees all committed events.
- **Failure conditions:** a reader blocking the writer for more than **500 ms (P)**; a partial batch visible; readers observing different totals for the same snapshot.

## Class 3 — Atomicity, crash and recovery

### AT-M1-06 — Kill during a write leaves no partial batch
- **Procedure:** run a writer appending 1 000-event batches while a supervisor kills the process at **20 randomized points (P)** during commit windows; after each kill, reopen and inspect.
- **Expected:** **0** torn batches across all 20 runs; every batch is either fully present or fully absent; reopen completes.
- **Failure conditions:** any partial batch (rows present without a commit record, or `seq` gaps); failure to reopen; a batch counted twice.
- **Evidence:** per-run kill offset, pre/post `max(seq)`, contiguity report, reopen log.
- **Replaces (ESR):** the historical 963/1766 torn-read observation with an **enforced** property; the historical figure is cited as motivation, never as this test's result.

### AT-M1-07 — Interrupted batch is reported, not silently ignored
- **Procedure:** after a kill during commit (AT-M1-06), run the store's open procedure and request its recovery report.
- **Expected:** the report states that a transaction was rolled back (count, byte range if available) and that the batch is absent.
- **Failure conditions:** silence about the rollback; reporting a rollback that did not occur.

### AT-M1-08 — Power-loss durability — **NOT TESTABLE on this machine**
- **Procedure:** none available. Cutting power to a workstation repeatedly is neither safe nor repeatable here, and the storage stack's flush behaviour is outside Lain's control.
- **Required treatment (ESR):** reported as **NOT-TESTABLE** with the reason, and the security/durability language must state the resulting limit (`01-event-store-specification.md` §8 item 5). It must never be reported as passing.

### AT-M1-09 — Durable acknowledgement
- **Procedure:** append a batch; capture the receipt; kill the process **after** the receipt returns; reopen.
- **Expected:** every batch with a receipt is present exactly once.
- **Failure conditions:** a receipt returned for an absent batch; a batch present that never returned a receipt (this is allowed **only** if the store reports it as indeterminate).
- **Positive control:** a batch whose commit fails (injected error) returns **no** receipt.

## Class 4 — Identity, duplicates and ordering

### AT-M1-10 — Idempotent replay
- **Procedure:** append the same batch twice with the same `idempotency_key`s.
- **Expected:** the second call returns `duplicate=true` with the **original** `event_id`/`seq`; `count(*)` increases by the first batch only.
- **Failure conditions:** a duplicate row; a silent drop with no indication; an error instead of a duplicate result.

### AT-M1-11 — Ordering and clock skew
- **Procedure:** append events whose `occurred_at` values are non-monotonic (including one in the past and one with a different UTC offset).
- **Expected:** `seq` is strictly increasing in insertion order; `recorded_at` is store-assigned and monotonic; `occurred_at` is preserved verbatim; ordering by `occurred_at` is available only when explicitly requested and the response flags it.
- **Failure conditions:** rejection of a valid timestamp; store-generated `recorded_at`; reordering by wall clock.

## Class 5 — Security

### AT-M1-12 — Redaction before durability, fail-closed
- **Procedure:** append payloads containing (a) an email, (b) an API-key-shaped string, (c) a payload the filter cannot classify (injected rule error).
- **Expected:** (a) and (b) are stored redacted, with the `redaction` column naming what was removed and `rule_version`; the raw values are **absent from the file**, verified by scanning the raw bytes; (c) is **refused** with no row written.
- **Failure conditions:** a raw secret present in the file (byte scan); a redaction not recorded; an unclassifiable payload stored.
- **Positive control:** a clean payload is written unchanged, and the filter's counter reports `scanned > 0, redacted = 0`.
- **Note (ESR):** the byte-level scan is the only trustworthy check — a query through the store's own redaction-aware read path could hide a defect in the writer.

### AT-M1-13 — The store refuses to be bypassed
- **Procedure:** attempt to open the store file from a module outside `store/` and append directly.
- **Expected:** the boundary check (V-8) fails the verification run.
- **Failure conditions:** a direct write succeeds and verification still passes.
- **Positive control:** the store's own append path passes the same check.

## Class 6 — Corruption, migration, exhaustion, permissions

### AT-M1-14 — Corruption is detected, never silently skipped
- **Procedure:** (a) flip bytes in one payload; (b) truncate the file mid-page; (c) zero the header.
- **Expected:** (a) `verify` reports the `seq` and digest mismatch, and default reads fail loudly at that row; (b) and (c) the store refuses to start, naming the path, and **does not** create an empty store in its place.
- **Failure conditions:** silent skip; empty-store recreation; a successful start on a corrupt header; a generic error with no location.

### AT-M1-15 — Hash-chain verdict is distinct
- **Procedure:** modify a committed row in place (with the chain enabled) and run `verify`.
- **Expected:** verdict `CHAIN_BROKEN` at a named `seq`, distinct from `CORRUPT`.
- **Failure conditions:** the two verdicts conflated; modification undetected.
- **Positive control (mandatory):** an untouched store verifies `OK`.

### AT-M1-16 — Schema migration is transactional and reversible on failure
- **Procedure:** apply a migration that fails midway (injected error); then apply a valid migration.
- **Expected:** the failed migration leaves the schema version and all rows unchanged; the valid migration commits, records a migration event, and a pre-migration backup exists.
- **Failure conditions:** partial migration; version advanced without the change; no backup; a migration applied without an event.

### AT-M1-17 — Storage exhaustion
- **Procedure:** point the store at a volume with insufficient space (or a size-limited file), then append.
- **Expected:** a distinct `ENOSPC`-class error; no truncation; the store remains openable and readable; a subsequent append after space is restored succeeds.
- **Failure conditions:** silent partial write; truncation of existing data; an unopenable store; a generic error.

### AT-M1-18 — Permission failure
- **Procedure:** make the store file/directory read-only for the process, then attempt to open a writer.
- **Expected:** a distinct permission error naming the path; **no** fallback to a temporary directory; no retry loop; readers still work when only write access is missing.
- **Failure conditions:** silent relocation of the store; an infinite retry; a misleading error.

### AT-M1-19 — Backup and restore verified against the source
- **Procedure:** back up with `VACUUM INTO`; restore into a **new** path in a temporary directory; compare `max(seq)`, row count, and a SHA-256 of 100 sampled payload digests; then remove the temporary directory.
- **Expected:** the restored store opens, passes `verify`, and matches on all three comparisons; a `store.backup.taken` event exists in the source.
- **Failure conditions:** any mismatch; a restore that cannot be opened; a backup taken without a recorded event; residue left in the source store.

---

## Threshold summary

| Tier | Count | Examples |
|---|---|---|
| **M** (measured on this machine) | 4 | 0 torn batches (mechanism measured HIST); integrity `ok`; 0 raw secrets in a byte scan; batch contiguity |
| **D** (derived by a stated rule) | 6 | receipt-after-commit; duplicate returns original; refusal on unclassifiable payload; version unchanged after failed migration; no truncation on `ENOSPC`; distinct permission error |
| **P** (proposed, needs measurement) | 6 | 2 s second-writer failure; 500 ms lock acquisition; 30 s multi-process run; 20 kill points; 500 ms reader-vs-writer; 100 sampled digests |
| **NOT-TESTABLE** | 1 | AT-M1-08 power loss |

**ESR — the honest reading.** The correctness properties (atomicity, single writer, redaction, no-silent-corruption) are threshold-free: they are 0-or-1 outcomes, and that is deliberate, because a correctness property with a tolerance is not a correctness property. The six **P** numbers are timing and sample-size conveniences that must be replaced with measurements before they gate a release — they do not weaken any correctness claim.

## Open questions

| # | Question |
|---|---|
| OQ-M1.19 | Is AT-M1-04's 30-second multi-process run sufficient, or is a longer soak required before the store is trusted as the system of record? |
| OQ-M1.20 | Should AT-M1-12's byte-scan check run in every verification pass (cost, but catches the worst defect class) or only in the security suite? |
| OQ-M1.21 | Is the hash chain (AT-M1-15) in scope for v0.1 (OQ-M1.6), or does the test exist and get marked deferred? |
