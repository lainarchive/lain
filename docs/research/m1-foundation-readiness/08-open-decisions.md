# 08 — Open Decisions

**Status:** Decision register for M-1. **Nothing here is decided.** Each entry gives the options, a recommendation **labelled as a recommendation**, what it blocks, and how reversible it is.
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** ESR (evidence-supported recommendation) · UAP (unapproved proposal) · EUR · OQ.

**Reading guide (ESR).** "Blocks" means *this work cannot start honestly until the decision exists*. Three decisions block the very next step; the rest can be answered in parallel with M-1 work because the affected step sits later in the sequence. As with every other fork in this project, the expensive decisions are the ones that determine **what the system may do**, not the ones that determine how it is written.

---

## A. Blocking — needed before Step 1

### OQ-M1.15 — Type system: one dev dependency, or none
- **Options.** (a) Zero-dependency plain ESM JavaScript with JSDoc types, checked by nothing. (b) TypeScript with `tsc --noEmit`, one dev dependency, run via Node's own type stripping.
- **Recommendation (ESR/UAP): (b).** The event store's correctness rests on shapes (receipts, batches, decisions) that tests cover only partially, and one dev dependency is the smallest possible price for static checking. Option (a) is defensible if the priority is an absolutely minimal dependency tree.
- **Blocks:** the `package.json` that gives the repository its first build command (Step 1).
- **Reversibility:** high before code exists; moderate later. **Cost of (b):** one dependency, pinned.

### OQ-M1.16 — Format/lint tooling
- **Options.** (a) Biome, one dependency, format + lint in one tool. (b) Nothing until the codebase justifies it. (c) ESLint + Prettier, several dependencies, most familiar.
- **Recommendation (ESR): (a)**, because a single formatter removes style from review entirely and keeps the dependency count at one. **(b)** is a legitimate minimal choice; **(c)** contradicts constraint 6.
- **Blocks:** Step 1's script set. **Reversibility:** high.

### OQ-M1.17 — Secret scanning
- **Options.** (a) Require `gitleaks` and fail the check when it is absent. (b) Run it when present, otherwise record `SKIPPED` and **fail in verification mode** (recommended in `04-…` V-7). (c) Skip the check entirely for now.
- **Recommendation (ESR): (b)** — it never lets a skipped security check masquerade as a pass, and it does not block M-1 on installing a tool. **(c)** is acceptable only with an explicit recorded "not run".
- **Blocks:** V-7's behaviour. **Reversibility:** high.

---

## B. Blocking before Step 2 (the event store)

### OQ-M1.1 — Event ownership model
- **Options:** four models compared in `02-security-and-containment.md` §1.2 — **A** Event Store owns storage/production/consumption/ordering (R1–R4) with the Policy Engine exclusively owning authorization (R5); **B** Session Manager owns R1–R4; **C** split storage engine + event service; **D** no owner (the current state, whose measured cost is 963 torn reads in 1 766).
- **Recommendation (ESR/UAP): Model A**, with the three boundaries stated in `02-…` §1.3 (`session_id`/`turn_id` are references, not ownership transfers; the store has no authorization role; one normative single-writer sentence added to `SYSTEM_BOUNDARIES.md`).
- **Blocks:** the ownership-table row; whether sessions/tasks tables live inside the store (OQ-M1.8); what Step 2 is allowed to own.
- **Reversibility:** the *implementation* is unaffected by the name chosen; the *canonical claim* is what changes, and it is hard to walk back once other documents cite it.

### OQ-M1.4 — Durability default
- **Options.** (a) `synchronous=FULL` — strongest available integrity, slower writes. (b) `synchronous=NORMAL` with the trade recorded as a configuration reason.
- **Recommendation (ESR/UAP): (a) for the event store**, because it is the system of record and its write rate is interactive, not bulk. The measured storage cost is identical either way (146 B/event), so the trade is latency only.
- **Blocks:** the store's open parameters. **Reversibility:** high (a configuration value).

### OQ-M1.6 / OQ-M1.21 — Tamper-evidence hash chain in v0.1?
- **Options.** (a) Implement the chain now (extra code, detection of in-place edits). (b) Defer it; keep the test specified but marked deferred.
- **Recommendation (ESR): (b) defer, with the test written.** The chain detects an attacker who already has write access to the file; it does not prevent them, and M-1's threat model is a single-user machine. Revisit when the store is used for anything with an external auditor.
- **Blocks:** AT-M1-15's status. **Reversibility:** high — the chain can be added later for new batches only, which weakens it, so if it is ever wanted, the cost of delay should be acknowledged.

### OQ-M1.7 / OQ-M1.13 — Retention and compaction
- **Options.** (a) Never delete; warn at a soft size (2 GiB ≈ 14.7 M events at 146 B/event). (b) A retention policy with tombstone events preserving `seq` continuity.
- **Recommendation (ESR): (a)** for v0.1. The store's whole value is that it can prove what happened, and storage is cheap; a retention policy is a subsystem with its own failure modes.
- **Blocks:** whether Step 2 includes compaction. **Reversibility:** high.

### OQ-M1.8 — Does the store own sessions and tasks tables?
- **Options.** (a) Events only; sessions/tasks are tables another component owns, referenced by id. (b) The store owns them too.
- **Recommendation (ESR): (a)**, to keep the store's job mechanical and to keep the ownership decision (OQ-M1.1) narrow. It also means a session-table bug cannot corrupt the log.
- **Blocks:** Step 2's schema and Step 5's task records. **Reversibility:** moderate (a migration if changed later).

### OQ-M1.9 — Encryption at rest
- **Options.** (a) Plaintext, with the limitation stated. (b) Encryption with a key-management story.
- **Recommendation (ESR): (a) for v0.1, stated plainly** (`01-…` §8). Encryption without key management is a false claim of confidentiality, and key management is a subsystem. The honest alternative is the redaction-on-write filter plus not storing secrets at all.
- **Blocks:** nothing in M-1; it bounds what the security language may claim. **Reversibility:** moderate.

---

## C. Blocking before M-2 (the model loop)

### OQ-M1.3 — Can the toolchain work in a Low-integrity workspace? (P-5)
- **Options.** (a) Measure it (procedure in `03-…` §6 P-5) and let the result decide whether MIC is *the* containment layer. (b) Assume it works. (c) Assume it does not and design a different boundary.
- **Recommendation (ESR): (a), unconditionally.** This is the highest-value unmeasured question in the package; (b) is exactly the unverified-assumption pattern this project forbids, and (c) forecloses a mechanism that is already verified to contain nine attack classes.
- **Blocks:** M-2.2 entirely, and the wording of the containment claim. **Reversibility:** n/a — it is a measurement, not a choice.

### OQ-M1.23 — Model binding and the P0 spike
- **Options.** (a) Require the P0 spike's tool-call verdict before M-2 starts. (b) Start M-2 with the pinned `qwen3-4b-instruct-2507` binding (digest `1a2c1c9c3f3b…`) and discover reliability as we go.
- **Recommendation (ESR): (a).** The spike answers whether a ≤ 4 B model at 4 096 context can drive a tool-calling loop at all; discovering the answer by building the loop inverts the roadmap's own critique.
- **Blocks:** M-2.1. **Reversibility:** high, but the wasted work is real.

### OQ-M1.22 — Cancellation semantics
- **Options.** (a) Immediate kill. (b) Safe-point cancellation (let a running tool finish, then stop). (c) Cancellable at either granularity, declared per task.
- **Recommendation (ESR): (c), defaulting to safe-point for `local_reversible` effects and immediate for `none`.** The distinction matters because an immediately-killed effectful tool can leave a half-written artifact whose state the log cannot prove — the same indeterminacy the store exists to eliminate.
- **Blocks:** M-2.5 and the result-recording contract. **Reversibility:** moderate.

### OQ-M1.25 — Unattended `local_irreversible` effects
- **Options.** (a) Never unattended (approval per occurrence). (b) Allowed unattended within budget, with a record.
- **Recommendation (ESR): (a)**, consistent with ADR-013 and with the standing rule that absence of approval is denial.
- **Blocks:** the policy arm table's coverage. **Reversibility:** high.

### OQ-M1.24 — One tool call per turn: rule or ceiling?
- **Recommendation (ESR): keep it a hard v0.1 rule** (it is part of the slice's definition) and revisit only with evidence about the model's reliability.
- **Blocks:** nothing immediate.

---

## D. Needed, but not blocking M-1 or M-2

| # | Question | Recommendation (ESR/UAP) | Notes |
|---|---|---|---|
| OQ-M1.2 / OQ-5 | Windows-only v0.1? | **Yes, explicitly** — the entire containment mechanism is OS-specific, and an unnamed target OS is how `SECURITY_MODEL.md:42` came to promise containers nobody could run. Naming the target is also what makes the containment claim meaningful. | Canonical documents name no OS anywhere (audit G-1) |
| OQ-M1.10 | Is Low→Medium UI/COM escalation accepted as a documented limit? | **Yes, documented as a known limit** — it is not mitigated, and saying so is the difference between a limit and a false guarantee | Bounds the wording in `02-…` §3.3 |
| OQ-M1.11 | Second, non-MIC boundary for high-value tools? | Defer until P-5's result; if the toolchain cannot run Low, this becomes the live question | Depends on OQ-M1.3 |
| OQ-M1.12 | Accept the §3 configured-limit defaults? | **Accept provisionally**, and replace the **P** entries as P-3/P-4 measurements land | `03-…` §3 |
| OQ-M1.14 | `%TEMP%` quota for contained processes? | **Yes before any contained tool execution** — otherwise containment has an unbounded writable region | `02-…` §3.2 item 4 |
| OQ-M1.18 | Package manager for later phases | None needed for M-1; decide at M-2 | pnpm is in the owner's global stack |
| OQ-M1.19 | Is a 30 s multi-process soak enough for AT-M1-04? | Raise it once the store is real; the *correctness* threshold (0 torn batches) does not change | `05-…` |
| OQ-M1.20 | Byte-scan redaction in every verification pass? | **Yes** — it is the cheapest insurance against the worst defect class, and its cost is a file read | `05-…` AT-M1-12 |
| OQ-M1.5 / OQ-2 | Does the auto-activation clause survive (Phase 4 F-M1-4)? | **No, not as written** — it rests on three undefined terms and a grant record that does not exist. Rewrite with definitions or remove | Canonical edit `DECISIONS.md` §Reconciliation |
| OQ-1 | Are Mods (event interception) in scope at all? | **Out of scope for v0.1.** Interception is a higher trust surface than a normal plugin, and the audit found the canonical text treats it as low-risk | `ARCHITECTURE.md:157` |
| OQ-M1.26 | Income objective in `VISION.md`? | **State it**, because Phase 8's entire design exists to serve it and the repository currently does not mention it | Needs `VISION.md` (C-4), itself a user decision |

---

## E. What is deliberately **not** in this register

**ESR.** Anything already answered by evidence is not an open decision. In particular: the containment mechanism (measured, not chosen); the storage engine (measured, and `node:sqlite` is the only zero-dependency option that meets the constraints); the batch-commit requirement (measured: 0 torn reads vs 963); the redaction-on-write requirement (forced by append-only permanence, audit E-4); and the "absence of approval is denial" rule (EAD, ADR-004). Re-opening any of these would be re-litigating a measurement, which the project's own constraints forbid.
