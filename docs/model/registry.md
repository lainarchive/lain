# Model registry and the human-approval gate (M-3)

The registry is the single place a model's invocation channel is declared, and
the gate is the single place a model invocation meets the policy engine's
human-decision arm. Neither approves anything by itself.

## Registry format

`src/model/registry.mjs` holds one frozen descriptor per model id:

```js
'local-mock': {
  id: 'local-mock',
  provider: 'local',
  name: 'mock-model',
  cost: 0,
  effect_class: 'external',
}
```

`effect_class` describes the invocation channel's worst case, not the model's
intent. A real provider reaches the network, so it is `external`. The mock is
marked `external` too, deliberately: fail-closed is the rule, and a gate that
no registered entry can trigger is decoration, not defense. Reclassing the
mock to `read_only` is M-4 work and requires evidence that its channel is
local — the same way every other containment claim in this repository is
treated.

The registry is in-memory and frozen. Persistence, remote registries, and
cost accounting are out of scope here (M-4).

## The external effect class and arm A5

`src/policy/rules.mjs` carries the rule row the gate decides under:

```js
'model.invoke.external': { tool_effect_class: 'external', requires: ['model.invoke'] }
```

The engine evaluates A1/A2/A3 (explicit denials) first, then A5: an `external`
request lands in A5 with outcome `require_approval` — a human decides before
anything runs, and a forbidden action never reaches a human. This is the same
ordering the tool path has always had; the gate adds no new arm and no new
exception.

## The approval workflow

`requireHumanApproval(task, modelId)` in `src/model/approval.mjs`:

1. Resolves the model. An unknown id is a caller error
   (`StoreError INVALID_SHAPE`), not an approval need.
2. Builds the policy context (`tool_id: 'model.invoke.external'`, the task's
   granted capabilities) and calls `decide()`.
3. `require_approval` → throws `HumanApprovalNeeded`
   (`code: 'HUMAN_APPROVAL_REQUIRED'`) carrying `{taskId, modelId, decision,
   decision_id}` — the human's answer can be traced to the exact decision
   that asked for it.
4. Any other refusal → `ModelPolicyError` with the decision attached.
5. A permitted decision returns `{required: false, taskId, modelId,
   decision_id}`.

Recording the human's answer is the existing `lain approve <approval_id>
--answer granted|denied …` flow; wiring a thrown `HumanApprovalNeeded` into
an approval-ledger request is the milestone's remaining work, not this
scaffold's.

## CLI probe

```
lain model approve <task.json> <model-id>
```

Prints one JSON document to stdout and exits 0 when no human is needed, or
prints the denial record and exits 3 when the decision belongs to a human
(A5) or the policy refused. The command never approves anything — it asks the
gate and reports, so a human can see what would be demanded before wiring it
into a run.

## Tests

`test/model/registry.test.mjs`: AT-M3-01 descriptor lookup, AT-M3-02 unknown
id → undefined, AT-M3-03 external model → `HumanApprovalNeeded` with arm A5
and a ULID decision id, AT-M3-04 injected `read_only` registry → `required:
false` (the path a proven-local model takes), plus the unknown-model refusal.
The gate tests run against the real engine — no mock policy.
