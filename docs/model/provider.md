# Provider integration (M-4 design note)

**Status:** scaffold design — the loader and the override mechanism exist and are
tested; the approval gate does not consume the effective descriptor yet. That
wiring is the milestone proper and must land with evidence that a re-classed
channel is actually local.

## What exists

- `src/model/provider.mjs` — `loadProvider(modelId)` resolves a registered
  model to its invocation function. One loader per provider kind in
  `PROVIDER_LOADERS`; `local` is a static specifier today, a future remote
  kind adds its own entry and stays behind the same seam. Loading is lazy:
  nothing is imported until a model is actually resolved. Resolution is **not
  authorization** — the loader knows nothing about capabilities; the policy
  engine still decides whether the invocation may run.
- `src/model/reclassify.mjs` — `reclassifyModel(modelId, newEffectClass)`
  asks the real engine under the `model.reclassify` rule row (requires
  `model.admin`, effect class `local_reversible`), then records an in-memory
  override and a log entry carrying the authorizing `decision_id`.
  `effectiveDescriptor(modelId)` is the post-override view;
  `getReclassificationLog()` returns the audit trail as a copy.

## Why the registry stays frozen

`MODEL_REGISTRY` is the audited default: every entry in it was reviewed, and
its `effect_class` describes the channel's worst case. A reclassification
must never be able to *edit* that record silently — it layers an override
that is (a) authorized by the engine, (b) session-scoped, and (c) logged
with the decision id that permitted it. The shipped value remains readable
through `MODEL_REGISTRY` itself, so an auditor can always ask "what did this
deploy ship with?" and "what has been changed since, by whom (which
decision)?".

## The not-yet-wired seam

The approval gate (`requireHumanApproval`) still reads the frozen registry.
Until it consults `effectiveDescriptor`, a reclassification is recorded but
not gate-effective: re-classing `local-mock` to `read_only` does not yet
change what the gate asks. This is deliberate for the scaffold — wiring it
without proving the channel local would turn the override into a
policy-bypass lever. The milestone-proper sequence is:

1. Prove a channel local with evidence (what the provider reaches, measured).
2. Wire the gate to `effectiveDescriptor`.
3. Only then does a re-classed model run without A5.

## CLI

`lain model reclassify <model-id> <new-effect>` carries `model.admin`
because the CLI *is* the human operator acting directly. A task-driven path
passes the task's granted capabilities instead and is refused without them
(A6b, `CAPABILITY_NOT_GRANTED`). Exit codes: 0 success, 3 policy refusal,
4 unknown model, 2 usage.
