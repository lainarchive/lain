# 01 — Event-Store Ownership Verification

**Status:** Verified by code inspection **and** by reproduction under real multi-process contention.
**Date:** 2026-11-08
**Scope:** determine which guarantee the implementation actually provides, and whether the documentation describes it accurately.
**Independent?** Yes. This measurement was not part of the implementation work; it was designed to falsify the stronger reading of the documented rule.

## The question, stated without conflation

| Guarantee | Meaning |
|---|---|
| **A** | Only one write transaction executes at a time. |
| **B** | Only one process owns the writer role **continuously**. |
| **C** | Both. |
| **D** | Neither. |

These are different claims. A is about transactions; B is about a process's standing between transactions. An implementation can provide A perfectly and B not at all.

## What the code does (inspection)

- `src/store/index.mjs:221` — `appendMany` refuses unless `holdsWriteLock`: `StoreError('WRITER_NOT_OWNED', …)`.
- `src/store/index.mjs:230-248` — the batch is inserted inside the open transaction, `db.exec('COMMIT')` runs, and then `claimWriteLock(db, dbPath)` is called **immediately and synchronously** (no `await` between). If re-acquisition fails, `holdsWriteLock = false` and `StoreLockedError('STORE_LOCK_LOST', …)` is thrown with `committed_through_seq` in the detail — the batch stays durable, the handle stops being a writer.
- `src/store/lock.mjs:96-110` — `claimWriteLock` is `BEGIN IMMEDIATE`, nothing else. The header comment records the three measurements that forced this design: `openSync(path,'r+')` does **not** exclude on this platform; `fs.flockSync` and `fs.constants.LOCK_EX` are undefined in Node 24.21.0; `BEGIN IMMEDIATE` does exclude.
- `src/store/lock.mjs:17-21, 34-59` — `<db>.writer.json` and `<db>.writer.lock` are diagnostics only and are **never consulted** to grant or refuse ownership.
- `src/store/index.mjs` (backup path, ~`:395-404`) — `backup()` releases the lock for the duration of the copy (the online backup API cannot run inside the held transaction) and re-takes it, throwing `STORE_LOCK_LOST` if a writer appeared meanwhile.

**Reading:** the lock exists for the duration of a transaction, then is released by `COMMIT` and re-taken. Whether the re-take wins is a race. Within one process the sequence is atomic (synchronous, single-threaded); **across processes the gap is real**.

## Reproduction (measured)

Method: a scratch database in `%TEMP%`; writer A opened the store through its real API and appended batches in a loop; four competing processes each polled `BEGIN IMMEDIATE` in a tight loop (no `busy_timeout`) and reported on the first acquisition. Scratch only; the repository database was never touched; the scratch directory was removed afterwards.

| Run | A committed before losing the lock | Competing writers that acquired it | Competing attempts |
|---|---|---|---|
| 1 | 651 batches | 4 of 4 | 1 455 |
| 2 | 613 batches | 4 of 4 (b0 at attempt 50, others at 0) | 54 |
| 3 | 375 batches | 4 of 4 (b0 at attempt 41, b3 at 97) | 142 |

A's outcome in every run: `{"a_error":"STORE_LOCK_LOST", "a_lost_lock":1, "holds":false}`.

**Result: guarantee A holds; guarantee B does not.** A competing process can and does acquire the write lock while the first writer is mid-session and still committing batches. The loser is refused rather than allowed to continue without ownership — the fail-closed response — but "this process is the writer" is true only between commits.

## Documentation accuracy, and the correction made

The canonical rule (`SYSTEM_BOUNDARIES.md:8-11`) said a writer "holds the database's write lock **for the life of its session**", which is false under the measurement above. `docs/implementation/event-store.md:21-26` repeated it as "Ownership is a long-lived `BEGIN IMMEDIATE` held for the life of the session", and `src/store/index.mjs` carried a comment describing the post-commit gap as hypothetical.

Corrected in this assignment, with the smallest change that makes each statement true:

1. `SYSTEM_BOUNDARIES.md` — the rule now says the log has "exactly one write transaction at a time"; it states that this is transaction serialization, not continuous process ownership; it describes the post-commit window and the `STORE_LOCK_LOST` refusal; and it records the measurement.
2. `docs/implementation/event-store.md` — the guarantee is renamed "Single writer per transaction"; a new subsection states what is **not** guaranteed, with the measured result; the limitations list gained the post-commit window; the ownership-model entry was updated because `SYSTEM_BOUNDARIES.md` now has an events row (the row records an implemented guarantee, not an accepted architecture).
3. `src/store/index.mjs` — the comment no longer presents the gap as hypothetical.

The distinct-Event-Store **ownership model** remains a recommendation. Nothing in this correction promotes it to an accepted decision.

## What Lain actually needs

| Option | Satisfies | Cost | Verdict |
|---|---|---|---|
| **Transaction-level serialization (current)** | A | none beyond what exists | **Sufficient for v0.1, and honest about B** |
| Continuous process ownership | A + B | a file-lock mechanism Windows does not give us cheaply (measured: no `flock`), or a broker | Not justified by any current requirement |
| Dedicated writer service | A + B + a place to route writes | a second process, a protocol, a lifecycle, its own failure modes | Rejected: complexity without a consumer |
| Application-level ownership file | B, weakly | advisory only — a PID in a file is stale, reusable and forgeable | Rejected: cannot grant authority without becoming the authority |

**Recommendation (labelled a recommendation).** Keep transaction serialization. Treat `STORE_LOCK_LOST` as a first-class outcome that callers must handle (close and reopen, or fail the task). If a future requirement needs continuous ownership — for example several long-lived agents each holding a store handle — the narrowest sufficient addition is a **single writer process that owns the handle**, with everyone else calling it; that decision should wait until such a consumer exists.

## Limitations of this verification

- The measurement uses a polling competitor with `busy_timeout = 0`, which is the most adversarial shape available. It measures that the window is reachable, not how wide it is in wall-clock terms.
- Contention was produced by processes on one machine against a file on one volume. Shared-storage semantics were not tested.
- The guarantee is stated for the store's own API. A second process that opens the database file with the SQLite library directly, bypassing `open()`, was not tested — it would be subject to SQLite's locking but not to `WRITER_NOT_OWNED`.
