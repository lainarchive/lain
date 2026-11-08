# 07 — Model Binding Contract

**Status:** PROPOSED interface specification. **Not implemented. No model call was made in preparing it; no credential was created or used.**
**Date:** 2026-11-08
**Scope:** the minimum contract between Lain and any model, sufficient for `Lain v0.1.0 — One Bounded Agent` and deliberately not more.
**Verification classification:** VERIFIED (local environment facts measured here) · HISTORICAL (the pinned model digest, from the audit) · PROPOSED · UNRESOLVED.
**Depends on:** [00-model-evaluation-research.md](../phase-7-intelligence-systems/00-model-evaluation-research.md) (cost classes, one adapter per protocol), [08-open-decisions.md](../m1-foundation-readiness/08-open-decisions.md) (OQ-M1.23).

---

## 1. Binding identity — five distinct identities, never collapsed

```
binding {
  binding_id     ULID                       this configuration instance
  provider_id    string                     "local-ollama" | "local-llama-cpp" | ...
  model_id       string                     "qwen3-4b-instruct-2507"
  runtime_id     string                     what actually executes it, incl. version
  digest         sha256 hex                 REQUIRED; of the weights/artifact as served
  protocol       openai_compatible_local | ollama_native | llama_cpp_server | manual_cli
  endpoint       string                     loopback URL or a local path
  location       local | remote             remote requires explicit user authorization
  cost_class     free | local | trial | paid | unknown
  context_window integer                    tokens; part of the binding, not a default
  max_output     integer
  timeout_ms     integer
  cancel         {supported: bool, verified: bool}
  declared_caps  {tools: bool, json_mode: bool, streaming: bool}
  measured       {tool_call_conformance: number|null, evaluated_at: iso|null}
  provenance     {added_at, added_by, source}
}
```

**ESR — why these are separate fields.** The audit's own lesson: one identifier for multiple purposes produces silent mismatches. Here the failure it prevents is concrete — "qwen3-4b-instruct-2507:latest" identifies *a tag*, and a tag can be repointed. The digest identifies *the bytes*, and only the bytes can be re-evaluated.

## 2. Rules

| # | Rule | Reason |
|---|---|---|
| R-1 | **Digest is required.** A binding without one cannot be selected | A tag is a mutable name; a measurement is only valid for the bytes measured |
| R-2 | **Digest mismatch refuses to run**, before any task work | Running a different model than the one evaluated invalidates every prior result |
| R-3 | **`cost_class: unknown` refuses to run** and records the reason | ADR-005; the alternative is a silent paid fallback, which constraint 2 forbids outright |
| R-4 | **`paid` refuses unless the user enabled that exact binding for that task** | No paid route is ever inferred from a previous approval |
| R-5 | **No automatic fallback, ever.** On refusal the task stops with `model.refused` | A fallback is a policy decision, not an engineering convenience |
| R-6 | **Selection is deterministic and never model-chosen** | A model that can choose its own executor can choose a paid one |
| R-7 | **One concurrent model call** | Measured hardware: 4 threads, one GPU with 5 389 MiB free; VRAM churn costs seconds and desktop responsiveness |
| R-8 | **The adapter asks, it never decides.** `call()` is only reachable with a recorded decision | ADR-004: authorization lives outside the model, and outside the adapter |
| R-9 | **Every call is recorded before its result is used** | A crash between "the model answered" and "we recorded it" would leave an unexplainable state |
| R-10 | **Remote execution is off by default** and requires explicit, per-binding authorization | Local-first is a constraint, not a preference |
| R-11 | **`cancel.verified: false` is never treated as cancellable** | Declared capability is not capability; until measured, cancellation must not be promised |

## 3. Local provider discovery — measured environment facts

VERIFIED (2026-11-08, this machine): `ollama` client **0.40.4** is installed, and the **daemon is not listening** on `127.0.0.1:11434` (`could not connect to a running Ollama instance`). `nvidia-smi` is present; the GPU has **6 144 MiB total, ~5 389 MiB free at idle**. Node **24.21.0**; **no** `cargo`/`rustc`; no Docker; no WSL distro.

**Consequences (PROPOSED):**
- Discovery is **local-only and non-fatal**: probe loopback ports and known config paths, and treat "nothing found" as an empty binding list, not an error. A discovery failure must never block a task that could run with a binding the user specified explicitly.
- Discovery is **not a network dependency**: it must not query a registry, a catalogue, or the internet. If that changes, it changes as an explicit feature with its own approval.
- The audit H logically pinned `qwen3-4b-instruct-2507` with digest `1a2c1c9c3f3b…` and measured that a ≤ 4 B model at 4 096 context is *the* riskiest assumption of the whole architecture. **That measurement has not been reproduced by this session**, so the binding is HISTORICAL until the P0 spike runs.

## 4. Call semantics

1. **Pre-flight:** binding selected → digest verified → cost class checked → context budget computed → admission checked. Any failure refuses **before** the call.
2. **Construction:** system prompt + tool schemas + objective + last tool result only. No transcript accumulation.
3. **Record:** `model.call.requested` with binding id, digest, prompt token estimate, budget before.
4. **Execute:** one request, `timeout_ms` enforced by the controller, not by the adapter's own promise.
5. **Record:** `model.call.completed | .failed | .timeout` with usage, finish reason, and — for any failure — whether the request may have been received.
6. **Use:** the response is validated against the tool-call schema before anything acts on it. Malformed output is refused, never repaired into something plausible.

**ESR — the timeout subtlety worth writing down:** a local model call that times out may still be generating. The outcome is therefore **unknown**, not failed, and the rule from cancellation applies: an operation with an unknown outcome is never blindly retried. The binding contract states this rather than leaving it to the caller.

## 5. Error handling and retry

| Error | Class | Retry |
|---|---|---|
| Connection refused, daemon absent | `binding.unavailable` | Refuse the task; retry only by explicit user action |
| Digest mismatch | `binding.digest_mismatch` | Never |
| Cost class `unknown`/`paid` without authorization | `binding.refused` | Never automatically |
| Model returned malformed tool-call JSON | `model.malformed_output` | One retry, then fail (the same failure twice is a stopping condition) |
| Timeout | `model.unknown_outcome` | **Never automatic**; the task records `indeterminate` for that step |
| Context over budget | `context.refused` | Never; the caller must reduce scope deliberately |

## 6. Provenance

Every call event carries: `binding_id`, `model_id`, `runtime_id`, `digest`, `cost_class`, `protocol`, and the `decision_id` that authorized it. Recording the digest per call is what makes a later evaluation comparable: a result produced under digest X cannot be attributed to digest Y.

## 7. Acceptance tests

| ID | Test | Positive control |
|---|---|---|
| AT-MB-01 | Binding with no digest cannot be selected | a digest-bearing binding is selectable |
| AT-MB-02 | Digest mismatch refuses before any task work, recorded | a matching digest proceeds |
| AT-MB-03 | `unknown` cost class refuses and records the reason | `local` proceeds without prompting |
| AT-MB-04 | `paid` refuses without explicit per-task authorization | authorization for that binding and task allows it |
| AT-MB-05 | No fallback occurs on refusal | a second binding is used only when explicitly selected |
| AT-MB-06 | Adapter refuses to call without a recorded `decision_id` | a recorded decision permits the call |
| AT-MB-07 | Timeout is recorded as unknown outcome and not retried | a clean failure with a known outcome may be retried once |
| AT-MB-08 | Every call event carries binding id and digest | — |
| AT-MB-09 | Discovery with no daemon yields an empty list and no error | a running daemon yields one binding |

## 8. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-MB-1 | Is `qwen3-4b-instruct-2507` at digest `1a2c1c9c3f3b…` the binding for M-2, and is the P0 spike a precondition? | The first model call |
| OQ-MB-2 | Is `manual_cli` (a human pasting prompts) in scope as a `$0` fallback, or does it belong to a later milestone? | Whether a tool-calling-capable local model is strictly required |
| OQ-MB-3 | Is digest verification of an *Ollama-served* model practical on this machine (does the API expose enough to identify the bytes)? | R-1's feasibility — this must be measured, not assumed |
| OQ-MB-4 | How is "the request may have been received" determined for a loopback provider — is there any signal at all? | Error classification in §5 |
