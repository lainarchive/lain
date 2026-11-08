# 08 — Dependency and Readiness Matrix

**Status:** PROPOSED assessment. **A specification is not an implementation; a passing write-boundary experiment is not process containment.**
**Date:** 2026-11-08
**Scope:** every dependency a real bounded agent needs, with its true state, so M-2 planning starts from what exists rather than what was designed.
**Verification classification:** VERIFIED (implemented **and** tested here) · PARTIAL (implemented, incompletely verified) · SPECIFIED (a document exists) · RECOMMENDED (a proposal exists) · UNRESOLVED · OUT OF SCOPE.

---

## 1. The matrix

| # | Dependency | State | Evidence / where it lives | What is missing for M-2 |
|---|---|---|---|---|
| D-01 | Repository + build/check command | **VERIFIED** | `npm test` 110/110; `npm run check` 7 pass/1 skip; `check:self` 8/8; `npm run verify` exits 1 by design without gitleaks | Nothing |
| D-02 | Event store: single write transaction at a time | **VERIFIED** | 37/37 store tests; contention reproduced and documented; `STORE_LOCK_LOST` measured | Callers must handle `STORE_LOCK_LOST` (a contract, not code) |
| D-03 | Event store: redaction on write, verified byte-level | **VERIFIED** | Database + WAL + SHM scanned; residual-secret refusal | — |
| D-04 | Event store: recovery, duplicates, ordering, tamper detection | **VERIFIED** | AT-M1-13…19 | Retention policy still open (D-V-adjacent) |
| D-05 | Host probe | **PARTIAL** | `src/host/probe.mjs`; 35 fixture tests; real run captured | GPU probe only via `nvidia-smi`; no measurement under load |
| D-06 | Resource admission | **PARTIAL** | `src/budget/index.mjs`, three profiles, typed deny/indeterminate | Limits are RECOMMENDED, never observed under load; no job-limit wiring |
| D-07 | Policy Engine `decide()` (total, 8 arms, default deny) | **SPECIFIED** | `06-one-bounded-agent-specification.md` §3.2; M-1 Step 4 descoped | **The whole component.** No `src/policy/` exists |
| D-08 | Session and task records | **SPECIFIED** | Task contract in `06-bounded-agent-execution-contract.md` §3 | **The whole component.** No `src/tasks/` |
| D-09 | Model binding | **SPECIFIED** | `07-model-binding-contract.md` | Component + digest-verification feasibility (OQ-MB-3) |
| D-10 | Contained execution (restricted token + Low IL + Job Object) | **PARTIAL** | Verification E measured the write boundary and the toolchain | **No integration code**; job limits unexercised; controller-side handle ownership unwritten |
| D-11 | Tool execution contract | **SPECIFIED** | `06-…-contract.md` §6, four-tool set | Component + the tools themselves |
| D-12 | Cancellation cascade | **RECOMMENDED** | `01-cancellation-semantics.md` | Component; OQ-CX-1/2 undecided |
| D-13 | Result recording with `indeterminate[]` | **SPECIFIED** | `06-…-contract.md` §5 | Component |
| D-14 | Approval flow (prompt, timeout, `deny_indeterminate`) | **SPECIFIED** | ADR-004/OD-7; M-1 research | Component + a CLI surface; **no UI exists** |
| D-15 | Auditability (every action traceable to a decision) | **PARTIAL** | Store supports it; `decision_id` linkage is specified | Depends on D-07 and D-11 |
| D-16 | Capability grant records (digest-bound) | **SPECIFIED** | Phase 6 research §2; `08-open-decisions.md` F-1.2 | Component; M-2 needs only a static grant set |
| D-17 | Read restriction | **OUT OF SCOPE for M-2** | Measured: reads unrestricted | Documented limitation OQ-TM-1 |
| D-18 | Network restriction | **OUT OF SCOPE for M-2** | Unenforced; policy-only (§3 of the boundary doc) | AppContainer/LPAC — Tier 2, unmeasured |
| D-19 | UI/COM isolation | **NOT-TESTABLE** in the current design | MIC does not address it | Tier 2 |
| D-20 | Multi-agent orchestration, delegation, swarms | **OUT OF SCOPE** | Phase 5 research; ADR-013 | Later milestone |
| D-21 | Knowledge graph, embeddings | **OUT OF SCOPE** | ADR-013, OD-5 | Later milestone |
| D-22 | Plugins, MCP, Creator Mode, Mods | **OUT OF SCOPE** | Phase 6 research; mods deferred by recommendation | Later milestone |
| D-23 | Desktop UI | **OUT OF SCOPE** | OD-4 (CLI-first; ADR-010 deferred) | Later milestone |
| D-24 | gitleaks in the security gate | **UNRESOLVED** | `npm run verify` fails closed without it | A $0 install decision (D-V6) |
| D-25 | Independent off-device backup | **UNRESOLVED** | One physical disk carries C: and D: | Removable media or an authorized off-device copy |

## 2. What the matrix says when read as a whole

**ESR — three conclusions, in order of importance.**

1. **M-2's blockers are three components, not ten.** Policy (D-07), tasks (D-08) and execution integration (D-10) block everything else; the remaining gaps are either downstream of them or explicitly out of scope. That is a smaller and more honest picture than "M-2 needs ten things".
2. **The verified foundation is real but narrow.** Everything marked VERIFIED is deterministic and model-free. **Nothing involving a model, a tool process or a grant has been exercised end to end** — because none of it exists. Any statement about M-2's behaviour today would be a statement about a document.
3. **Two dependencies are environmental, not architectural:** the missing secret scanner (D-24) and the absent second physical volume (D-25). Neither blocks M-2; both block a claim of *durable* protection, and both are cheap to resolve relative to their risk.

## 3. Dependency order (what must exist before what)

```
D-07 policy decide()  ──┐
D-08 task records     ──┼─→ D-11 tool contract ──→ D-13 result recording ──→ D-15 audit linkage
D-10 contained exec   ──┘        │
                                 └─→ D-12 cancellation ──→ AT-CX acceptance suite
D-09 model binding ─────────────────→ the bounded loop (06-… §4)
D-14 approval flow ────────────────→ any `require_approval` arm becoming reachable
```

**Rules that follow (PROPOSED):** policy and tasks come first because every later component must *ask* rather than decide; execution integration comes before any tool, because a tool that runs outside containment invalidates the boundary claim; and the bounded loop comes last, because it is the only component that cannot be tested without all the others.

## 4. What must not be built yet

**ESR.** The Phase 5–8 research specifies a great deal that M-2 must not touch: delegation, the capability-scoring router, the evaluation lab, the research lab, the opportunity registry, the extension platform. Each depends on primitives that do not exist (task DAGs, measured capability records, grant records), and building them now would produce exactly the failure the research itself warned about — simulated capability with no substrate. The M-1 sequence document already made this argument; the matrix confirms it has not changed.

## 5. Open questions

| # | Question | Consequence if unanswered |
|---|---|---|
| OQ-DM-1 | Is `src/policy/` in M-2 scope, or should M-2 use a hard-coded allow-list and defer the Policy Engine? | A hard-coded list is faster and contradicts ADR-004-shaped thinking; the engine is slower and correct |
| OQ-DM-2 | Do task records live in the event store (events only, projected) or in their own tables? | M-1 research recommended tables owned elsewhere; changing it later means a migration |
| OQ-DM-3 | Is D-16 (grant records) needed for M-2, or is a static per-task grant set sufficient? | Static is sufficient for one agent; it must not become the permanent answer by accident |
