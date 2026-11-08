# 02 — Security Truth: Event Ownership, C-1 Integrity Evidence, C-2 Containment Ceiling

**Status:** Research and proposed corrected security language. **`SECURITY_MODEL.md`, `SYSTEM_BOUNDARIES.md` and `DECISIONS.md` were NOT modified.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR · EAD · ESR · UAP · OQ · HIST (historical measurement, not re-executed this session) · SESS (measured this session) · UNV (unverified).

---

# Part 1 — Event ownership: the contradiction, resolved as a comparison

## 1.1 The contradiction, stated precisely

The Phase 4 audit found that `SYSTEM_BOUNDARIES.md:8-20` has **11 ownership rows and no events row**, that "single writer" appears **zero times** in the canonical tree, and that the reconciliation layer added a *Collaboration Service* owner in prose (`:71`) while the ownership table says **Sessions and turns → Session Manager** (`:9`). The M-1 recommendation then proposed adding one row. The brief correctly asks whether that is right, because "the event log" is not one responsibility but five:

| # | Responsibility | What it means concretely |
|---|---|---|
| R1 | **Storage and durability** | the file, the schema, transactions, WAL, locking, migration, backup |
| R2 | **Production** | who may append; schema validation at the boundary |
| R3 | **Consumption** | who reads, projection, projection rebuild, cursors |
| R4 | **Ordering and identity** | sequencing, `event_id` allocation, idempotency |
| R5 | **Authorization** | deciding whether an event **should** exist (i.e. whether an action may happen at all) |

**ESR — the key observation.** R5 is **not** an event-log responsibility at all: it belongs to the Policy Engine (EAD, ADR-004). The entire design tension in this question comes from conflating "who stores the record" with "who authorizes the action". Once R5 is separated out, the remaining four responsibilities are cohesive around one component, and the ownership question becomes tractable.

## 1.2 The four viable models

### Model A — **Event Store owns R1–R4** (durable log is the sole owner of its own integrity)
- **Responsibilities:** storage, schema validation, sequencing, lock, migration, backup, read API.
- **Advantages:** one component can be reasoned about and tested in isolation; the single-writer rule has an owner that can enforce it; the audit's measured failure mode (963/1766) has exactly one place to be prevented; security-relevant code stays small and auditable.
- **Disadvantages:** a new component name appears in the ownership table; producers must go through an append API rather than writing wherever they like.
- **Security implications:** strongest. The store becomes the one place where redaction-on-write and schema validation cannot be bypassed, and it holds **no authority** — it cannot authorize, only record.
- **Failure modes:** store unavailable → producers cannot record → §5.3 fail-closed rule decides what happens (see 1.3); store corrupt → detection at open, refusal to start rather than silent reset.
- **Extensibility:** projections and consumers attach as readers; FTS5 or a knowledge graph can later be derived **without** changing the canonical log.

### Model B — **Session Manager owns R1–R4** (events as a session detail)
- **Advantages:** no new component; matches `SYSTEM_BOUNDARIES.md:9` ("Sessions and turns → Session Manager") as written; fewer names.
- **Disadvantages:** conflates session lifecycle (a domain concern with its own state machine) with storage integrity (a mechanical concern); the Session Manager then owns *both* mutable state and the append-only log, so "the log records what happened" and "the session is what it is" can drift within one component; every future producer of events (tools, evaluation, business records) depends on a component whose primary job is something else.
- **Security implications:** weaker. A larger owner has a larger surface, and a bug in session logic becomes a bug in the audit trail.
- **Failure modes:** a session bug that corrupts session state is now indistinguishable from a log bug; recovery logic must handle both.
- **Extensibility:** poor — non-session events (research results, evaluation runs, business records) have no natural owner and will either be shoved into sessions or spawn exactly the second store this model was chosen to avoid.

### Model C — **Storage engine owns R1/R4; a thin event service owns R2/R3** (split by mechanism vs meaning)
- **Advantages:** clean separation; the "how bytes are stored" layer could be swapped.
- **Disadvantages:** two components must agree on the ordering and idempotency contract, which is precisely where the subtle bugs live; the swap-the-engine benefit is speculative (ADR-007 is the only candidate and is already Proposed); doubles the interface count for a ~600-line subsystem.
- **Security implications:** the redaction gate must live in one of them and be provably unskippable — with two components, "unskippable" needs an argument rather than an inspection.
- **Failure modes:** disagreement between the two layers about what a "committed batch" means; partial failures that neither owns.
- **Extensibility:** good in theory, costly in practice for a first release.

### Model D — **No owner; every component writes its own records**
- **Advantages:** none that survive scrutiny.
- **Disadvantages:** this is the *current* state, and its measured cost is 963 torn reads in 1 766.
- **Security implications:** unacceptable — redaction becomes per-producer and therefore optional.
- **Verdict:** rejected explicitly, because the audit already measured it.

## 1.3 Comparison summary and recommendation

| Criterion | A | B | C | D |
|---|---|---|---|---|
| Single-writer enforceable by one owner | **yes** | partly | yes | no |
| Redaction gate provably unskippable | **yes** | yes | needs argument | no |
| Small auditable security-relevant surface | **yes** | no | partly | no |
| Non-session events have a natural home | **yes** | no | yes | n/a |
| Interface count | 1 | 1 | 2 | 0 |
| Fixes the measured failure mode | **yes** | yes | yes | no |

**Recommendation (ESR, labelled as a recommendation — NOT an accepted decision): Model A, with three explicit boundaries.**

1. **The Event Store owns R1–R4** and is named in the ownership table as *Events and event log → Event Store*.
2. **The Policy Engine exclusively owns R5.** The store has **no authorization role whatsoever**: it validates shape and redacts, and it cannot grant, deny, or infer permission. This is ADR-004 applied structurally.
3. **Session Manager keeps owning session and turn state** (`SYSTEM_BOUNDARIES.md:9` stays true). `session_id`/`turn_id` in an event are **references**, not ownership transfers — which also resolves the Phase 4 finding F-5.1's false join between "sessions and turns" and "discussions and reviews".

**Normative sentence proposed for `SYSTEM_BOUNDARIES.md` (UAP — requires approval):**

> **The Event Store owns the append-only event log: its schema, sequencing, durability, redaction-on-write and read API. Exactly one writer process may append to a store at a time, and every append commits in a single transaction per batch. The Event Store records what happened; it never decides what may happen. Producers of events include the Session Manager, Task Manager, Agent Runtime, Policy Engine, Execution Runtime, Model Intelligence and the specialized systems; they hold no ownership of the log itself.**

**Fail-closed rule to be stated alongside it (ESR):** if the store cannot accept a record, the *action being recorded* does not proceed. A system that performs consequential actions without being able to record them has lost the property this component exists to provide.

---

# Part 2 — C-1: what the integrity measurement does and does not demonstrate

## 2.1 What was measured (HIST — not re-executed this session)

| Item | Value |
|---|---|
| Source | `.lain-audit/20-p0-preparation.md` §4 (finding E-3), artifacts under `.lain-audit/tmp-03/` |
| Comparison | **WAL + one transaction per batch** vs **WAL + per-document commits** |
| Result | **0 torn reads in 1 212 observations** vs **963 torn reads in 1 766 observations** |
| Storage baseline (same artifacts) | **146 B/event** at 100 000 rows (`bench_batch_100000_wal_NORMAL.db` 14 581 760 B); 143–147 B/event across variants |

**SESS — what I verified about the artifacts, read-only.** The named `.db` files and the report exist in `.lain-audit/`; the summary figures above are quoted from the report, and the databases were **not opened or re-queried** in this session. No benchmark was run. `21-p0-e3-e5-results.md` contains no re-run of E1/E2.

## 2.2 What the measurement demonstrates (ESR)

1. **Under this workload and on this machine, committing a batch in one transaction eliminated observable intermediate states**, where per-document commits produced them in roughly **55 %** of observations (963/1 766).
2. **The direction is mechanistically explicable**, not a coincidence: a read inside a transaction's window sees either none or all of a batch's rows.
3. **The cost of the safe option is measurable and small** — the storage baseline is unchanged across the two strategies (146 B/event), so the trade is latency, not size.

## 2.3 What it does **not** demonstrate (ESR — the honesty section)

1. **It does not establish a universal guarantee.** 1 212 clean observations bound the *observed* failure rate, not the true one; they say nothing about multi-process writers, batches larger than memory, or a batch that spans a WAL checkpoint.
2. **It does not test the absence of a writer lock.** The benchmark compared commit strategies within one process. Whether two processes can corrupt a store is **untested** (see AT-M1-04).
3. **It says nothing about power-loss durability.** WAL + `synchronous` interacts with the Windows storage stack, and no power-loss test was performed or is planned on this machine (§4.6 of the event-store specification states the limit).
4. **It does not cover corruption detection, migration, restore, or storage exhaustion** — none of those were exercised.
5. **It is not reproducible on demand from a documented command.** The artifacts exist, the procedure is described in the audit report, but no single command regenerates the result; the "report → re-run" gap is itself a finding (recorded in `07-implementation-sequence.md` as step 0.4).

## 2.4 The guarantees required, and which need implementation and testing (ESR)

| # | Guarantee | Status | Needs |
|---|---|---|---|
| G1 | One writer process at a time; second writer fails loudly | **not implemented, not tested** | implementation + AT-M1-04/05 |
| G2 | Batch atomicity (all-or-nothing, contiguous `seq`) | **mechanism measured (HIST); our implementation untested** | implementation + AT-M1-06/07 |
| G3 | Durable acknowledgement (receipt only after commit) | **not implemented** | implementation + AT-M1-09 |
| G4 | Idempotent replay (duplicate returns the original, never a silent drop) | **not implemented** | implementation + AT-M1-10 |
| G5 | Redaction before durability, fail-closed on unclassifiable payloads | **not implemented** | implementation + AT-M1-12 |
| G6 | Crash-consistent reopen; interrupted batch absent, not partial | **not implemented** | implementation + AT-M1-06 |
| G7 | Tamper detection (hash chain) | **not implemented; optional for v0.1** | OQ-M1.6 |
| G8 | Restore verified against the source | **not implemented** | implementation + AT-M1-14 |

**ESR — the precise claim this package makes.** *The audit measured that batch-committed WAL eliminated torn reads under a controlled workload.* M-1's obligation is to make that property **enforced by construction and checked by test**, which is a different claim from re-running the benchmark.

---

# Part 3 — C-2: the exact verified containment ceiling

## 3.1 What is verified (HIST — E3/E5, `.lain-audit/21-p0-e3-e5-results.md`, run 2026-11-05 23:21–23:30)

**Capability (E3), all non-elevated:** restricted tokens can be created (four flag combinations, including `LUA_TOKEN|WRITE_RESTRICTED` with restricting SIDs); the token's integrity level can be set to Low (`S-1-16-4096`); a directory's integrity label can be set with `icacls /setintegritylevel (OI)(CI)Low` (exit 0) and the label inherits to child-created files; a Low child process can be spawned without elevation (`CreateProcessAsUserW OK pid=12972`). **This answers the open question S-3: yes.**

**Containment (E5), 11 vector classes as (control, escape) pairs:**

| Result | Count | Detail |
|---|---|---|
| Controls passed | **9 / 9** | every escape class had a working positive control |
| Classes contained | **9** | symlink, junction, hardlink, case variant, ADS, `\\?\`, `\\.\`, trailing dot, trailing space |
| Classes not testable | **2** (reported as 3 rows incl. the DOS device) | 8.3 short name (disabled on this volume); UNC (`\\localhost\C$` unreachable — `ERROR_NETNAME_DELETED`, Win32 67); DOS device `NUL` (write absorbed) |
| Escapes observed | **0** | independent proof: `outside\` and `canary\` name+SHA-256 snapshots **drift = NONE** |
| Decisive case | hardlink write → **DENY** | MIC evaluates the **object's label**, not the path — which is why the seven path-based bypass classes found in the earlier security assessment do not defeat it |
| Native denial code | `ERROR_ACCESS_DENIED` (5) | `win32code=5377` was a harness artifact (masked `COR_E_UNAUTHORIZEDACCESS`) and must not be cited as a Win32 code |

## 3.2 Separating verified from untested from unsupported (ESR)

**Verified behaviour (HIST):** a Low-integrity process cannot write through a hardlink, symlink, junction, case variant, ADS, `\\?\`, `\\.\`, trailing-dot or trailing-space path to an object whose label is Medium or higher, in the tested configuration, with all positive controls passing.

**Untested behaviour (UNV — must not be *implied* as contained):**
1. **8.3 short names** — not testable on this volume; if enabled elsewhere, untested.
2. **UNC paths** — the test path was unreachable in this environment; a share that *is* reachable is untested.
3. **Low→Medium escalation via UI/COM** — the audit names this explicitly as untouched. A Low process interacting with a Medium-integrity service is a known escalation surface, and **nothing in M-1 addresses it**.
4. **Other Low-integrity locations** — MIC bounds *higher*-integrity objects only. A Low process can still write anywhere the user can write that is labelled Low or unlabelled-and-writable (notably `%TEMP%` and other user-writable locations that inherit no protective label). The workspace label is not a global sandbox.
5. **The toolchain question (OQ-M1.3)** — whether `node`, `git` or `python` can do real work in a Low-labelled workspace (index writes, `%TEMP%` scratch, editor swaps) is **unmeasured**. This is the audit's own named next step and it decides whether MIC is usable as *the* containment layer or only as a hardening layer.
6. **Model-driven tool calls** — the run used a controlled child. It does not demonstrate that a tool call shaped by a model cannot be induced into an *allowed* in-workspace action with a harmful effect (that is a policy/admission question, not a MIC question).

**Unsupported security claims (currently in the repository):**
- `SECURITY_MODEL.md:42`'s container/VM isolation promise. There is no container runtime, no WSL distro, no Windows Sandbox substrate available without elevation, and no WDAC policy. **The claim cannot be satisfied on this machine as written.**
- Any implication that Lain's containment equals process isolation, or that a contained process cannot affect the user's session. It can: it runs as the user, at Low integrity, with the user's read access and Low-write access.

## 3.3 Proposed corrected security language (UAP — requires approval; `SECURITY_MODEL.md` NOT modified)

> **Execution containment.** Lain contains untrusted execution with operating-system enforcement, not with prompt instructions and not with path validation alone. On Windows the mechanism is a **restricted, Low-integrity token** applied to the executing process together with a **Low integrity label** on the workspace and a **Job Object** that bounds the process tree and terminates it as a unit.
>
> **What this achieves, as verified on 2026-11-05:** a Low-integrity process could not write to higher-integrity objects through any of nine tested path-manipulation classes (symbolic link, junction, hardlink, case variant, alternate data stream, `\\?\`, `\\.\`, trailing dot, trailing space), each with a positive control that confirmed the test could have succeeded. The decisive property is that **integrity is evaluated on the object, not on the path**, which defeats path-normalisation bypasses by construction.
>
> **What this does not achieve.** It is containment, not isolation. A Low-integrity process (a) can still write to locations that are themselves Low or unprotected, including temporary directories; (b) can read anything the user account can read; (c) is not prevented from attempting interaction with higher-integrity user interfaces or COM services, which is a known escalation surface that Lain does not currently mitigate; and (d) provides no protection against an attacker who already runs as the same user with full file access. Two of the eleven tested classes — 8.3 short names and UNC paths — could not be tested in this environment and are therefore **not claimed to be contained**. Whether ordinary development tools (`node`, `git`, `python`) can operate at all inside a Low-integrity workspace is **not yet measured**; until it is, Lain must not describe its workspace as able to run those tools safely.
>
> **Containers and virtual machines** are an optional, user-installed hardening tier, not a default and not a requirement. Lain does not install or require a container runtime, does not request elevation at run time, and does not claim isolation it has not demonstrated on the machine it is running on.

**ESR — why this wording.** It states a smaller guarantee that is true, it names its own gaps, and it is falsifiable: each sentence corresponds to a test or an explicitly untested class. The audit's verdict was that the repository **overstates its isolation and understates its verified containment**; this language reverses both errors without adding a single unverified claim.

---

## 4. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-M1.1 | Adopt Model A (Event Store owns the log; Policy owns authorization)? | the ownership row, and whether sessions/tasks tables live in the store (OQ-M1.8) |
| OQ-M1.3 | Can the toolchain perform real work in a Low-integrity workspace? | whether MIC is the containment layer or a hardening layer — **the highest-value remaining security measurement** |
| OQ-M1.10 | Is the Low→Medium UI/COM escalation surface accepted as out of scope for v0.1, documented as a known limit? | the correctness of §3.3's wording |
| OQ-M1.11 | Is a second, non-MIC boundary (e.g. per-tool adapter with explicit file handles) required for the tools that matter most? | tool execution design in M-2+ |
