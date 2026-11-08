# 06 — M-2 Readiness Review

**Status:** M-2 is **not ready to start**. Five prerequisites are listed; one is now measured, one has a concrete recommendation, one has a proposed contract, and two remain open decisions. **Nothing here implements M-2.**
**Date:** 2026-11-08
**Scope:** assess the M-2 prerequisites, propose the cancellation approach and the minimum model-binding contract, and separate tested capability from untested assumption.
**Independent?** The containment assessment below is based on this assignment's own experiment ([05](05-low-integrity-toolchain-experiment.md)), not on the earlier audit's summary.

## Prerequisite status

| # | Prerequisite | State after this assignment |
|---|---|---|
| 1 | Low-integrity toolchain works | **MEASURED — PASS** for write containment and toolchain operation; reads, UI/COM, network and resource limits untested |
| 2 | Cancellation semantics | **PROPOSED** below; a decision is required (§9.1 of the assignment) |
| 3 | Model binding contract | **PROPOSED** below; no model was called and none will be without authorization |
| 4 | Containment design and evidence | **PARTIAL** — a write boundary exists and is measured; a read boundary and resource ceilings do not |
| 5 | Explicit authorization for M-2 | **ABSENT** — the brief explicitly withholds it |

## 9.1 Cancellation semantics

| Approach | Database integrity | Child processes | Tool side effects | Event recording | Partial results | Verdict |
|---|---|---|---|---|---|---|
| **Immediate kill** | safe (the store commits per batch; an open transaction is rolled back on close) | reliable **if** the process tree is owned by a Job Object with kill-on-close — otherwise children survive | a tool killed mid-write can leave a half-written artefact the log cannot prove | needs a terminal event written *before* the kill, or the log ends mid-story | discarded | correct for effects with no lasting consequence |
| **Safe-point** (finish the current tool, then stop) | safe | clean | effects complete, so the artefact matches the log | the terminal event can be written after the tool returns | preserved | correct for effects that must not be half-applied |
| **Hybrid** (declare per task/effect) | safe | clean | matches the declared effect class | same | per declaration | recommended |

**Recommendation (labelled a recommendation).** Use **hybrid cancellation driven by the effect class** already defined in the Phase 5 research:

- effect class `none` or `local_reversible` → **immediate** kill is acceptable, because a half-applied reversible effect can be re-derived.
- effect class `local_irreversible` → **safe-point**: the running tool is allowed to reach its next checkpoint, then the cascade stops.
- effect class `external` → never automatic; requires the approval path in any case.

Non-negotiable properties for either mode, because they are what makes cancellation *verifiable* rather than *announced*:

1. The terminal record is written **before** any process is killed, so a crash during cancellation still leaves a truthful log.
2. The process tree is killed as a **unit** (Job Object, kill-on-close). Measured background: killing a Windows parent does not kill its children (audit finding S-5), which is exactly how an orphan becomes invisible work.
3. **Zero-orphan verification** after the kill: enumerate the tree; if anything survives, the cancellation is reported as **failed**, not as successful.
4. Dependents are **re-derived** from the DAG rather than cascaded, so a cancelled task cannot mark unrelated work cancelled.
5. Idempotency keys are recorded per effect, so a re-run after cancellation is not a duplicate.

**Not implemented. Not tested.** The above is a design proposal of comparable weight to the other M-1 research, and it should not be cited as a decision.

## 9.2 Minimum model-binding contract (specified, not implemented)

```
binding {
  binding_id          ULID
  provider            { id, kind: local | remote }
  model               { id, digest_sha256, quantization, context_window, max_output }
  runtime             { adapter: openai_compatible_local | ollama_native
                                | llama_cpp_server | manual_cli
                        endpoint, runtime_version }
  cost_class          free | local | trial | paid | unknown
  limits              { max_requests, timeout_ms, max_concurrent: 1,
                        max_context_tokens, max_output_tokens }
  cancellation        { supported: bool, mechanism, verified: bool }
  retry               { policy: none | idempotent_only, max_attempts, backoff }
  provenance          { discovered_at, discovered_by, health, note }
}
```

Rules that must hold before any call is made:

1. **Digest is required.** A tag or name is not identity. A mismatch refuses the binding.
2. **`cost_class: unknown` fails closed** with a recorded reason. Unknown pricing never becomes a free route.
3. **No paid fallback, ever.** A failed local call is a failure, not a reason to spend money.
4. **Model selection is deterministic**, resolved by hard filters then scoring — never chosen by the model itself, because a model choosing its own executor can choose a paid one.
5. **One concurrent model call** in v0.1 (the ceiling recorded in `RESOURCE_BUDGET.md`), with the context window checked *before* the call rather than truncated during it.
6. **Admission is checked first**: memory ceiling, VRAM budget and store availability are preconditions, and an indeterminate measurement yields `DenyIndeterminate`, not an attempt.
7. **Retries only for idempotent requests**; a request that may have reached the provider is not retried blindly.
8. **Cancellation capability is declared**, and `verified: false` means the caller must not assume a request was actually stopped.
9. **Every call is recorded** as an event before its result is used, with the binding digest and the decision id that authorized it.
10. **Remote execution is off by default** and never inferred from a previous approval.

**Nothing in this contract has been implemented, and no model call was made while writing it.**

## 9.3 Containment prerequisites, separated by evidence

**Tested (this assignment, `%TEMP%`, non-elevated):** a Low-IL child can read, create and modify files inside a labelled workspace; can run Node 24.21.0 scripts, Python 3.15.0 scripts and Git 2.56 commands including a full `init`/`add`/`commit`; can spawn a child process; and **cannot** write outside the labelled workspace — including into Medium-integrity directories under the same parent — with every escape artefact confirmed absent.

**Untested assumptions, which must not be presented as containment:**

| Property | State |
|---|---|
| Filesystem **read** boundary | **not contained** — MIC does not restrict reads; a Low child reads whatever the user can read |
| Writes to *other* Low-labelled locations | **not contained** by design |
| UI/COM escalation (low → medium) | **not tested**, and the earlier audit records it as unaddressed |
| Network reachability | **not tested**; no connection was attempted, so nothing is claimed |
| CPU / memory / disk / handle limits | **not applied**; no resource ceiling was enforced on the child |
| Child-process lifetime | mechanism known (Job Object with kill-on-close) but **not implemented or tested** in this experiment |
| Credential protection | **not tested**; the experiment deliberately touched no credential |
| Auditability of contained actions | partially available — the store records events, but the experiment's child wrote outside the store |

**A statement worth keeping in the canonical language:** the correct claim today is *"a write boundary around a labelled workspace, measured against four escape attempts, with reads unrestricted and UI/COM, network and resource limits untested."* The repository must not call itself sandboxed, and must not describe MIC as process isolation.

## What the next milestone would need

1. A decision on cancellation semantics (this document proposes one).
2. A decision on the model-binding contract and the pinned binding (digest `1a2c1c9c3f3b…`, `qwen3-4b-instruct-2507:latest` as recorded earlier).
3. A read-boundary and resource-limit design, or an explicit statement that they are accepted limits for v0.1.
4. The Job Object lifecycle implemented and its zero-orphan behaviour measured.
5. Explicit authorization for M-2.

## Limitations

- The containment evidence comes from one machine, one volume and one token configuration; it does not transfer automatically to another host and must be re-measured rather than assumed.
- The cancellation recommendation is reasoned from the store's commit semantics and the audit's process findings; it has no experiment behind it yet.
- The model-binding contract is a specification of constraints, not a validation of any specific model's ability to drive a tool loop — that remains the open question the original P0 spike was meant to answer.
