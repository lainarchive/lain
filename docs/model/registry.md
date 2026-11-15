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

(The `requires` list above is the M-3 state; M-7 tightened it to
`['model.invoke.external']` so the stub grant no longer implies the live
grant. The historical text is left as written.)

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

---

# Ledger-backed approval for the model gate (M-8)

A live model invocation normally needs two things the task file must carry:
the `model.invoke.external` capability and a recorded human approval. M-8
connects the second to the first: an approval that a human recorded **for a
named task** can supply that task's capability, so the operator workflow is
one approval instead of a hand-edited task file.

## The rule

`resolveLedgerApproval(decisionId, { ledger, taskId })` (in
`src/model/registry.mjs`) looks the decision id up in a ledger and returns
`{ approved, entry }`:

- `entry` is the raw record when the id is known — any outcome — or `null`.
  The outcome always feeds the policy engine as the approval status
  (`granted` → A5b, `denied` → A1, `timed_out` → A2, `pending` → A5), exactly
  as M-7 shipped. Presenting someone else's denied decision id denies you;
  that is a finding, not a loophole.
- `approved` is true only when the entry's outcome is `granted` **and** the
  entry's `taskId` equals the `taskId` the caller passed. Only then may the
  caller treat the approval as the task's `model.invoke.external` grant.

The binding is load-bearing. An approval recorded for task X must never hand
its capability to task Y, and a task file without an `id` cannot prove it is
the task the approver saw, so it is never augmented. That is how the M-7
invariant — an approval does not substitute for the capability — survives M-8
instead of being rewritten: unbound calls behave exactly as M-7 defined them.

The outcomes are the engine's vocabulary: `pending`, `granted`, `denied`,
`timed_out` (lowercase). There is no `APPROVED`/`REJECTED` spelling anywhere
in the ledger or the engine.

## Where it runs

- `runTask(task, { live: true, approvalId, ledger?, granted_capabilities? })`
  in `src/model/integration.mjs`: with `live`, the request moves to the
  `model.invoke.external` row (effect class `external` → A5). With an
  `approvalId`, the ledger is consulted; a bound `granted` entry augments the
  caller's grants for this invocation. The default ledger is the in-memory
  module ledger (process-scoped); production passes the persistent one's
  `{ list }`.
- `lain model invoke <task.json> <provider> --live --approval-id <decision-id>
  --ledger <db-path>`: the CLI resolves the same way. `--approval-id` is the
  M-8 spelling of `--approval` (both work); it requires `--live` (exit 2
  otherwise) and `--ledger` (exit 2 otherwise).

The task file needs an `id` for the binding to ever fire:

```json
{ "id": "task-m8-1", "prompt": "hello", "granted_capabilities": [] }
```

```powershell
node src/cli/index.mjs model approval-persist store approvals.db 01M8EXAMPLE task-m8-1 gemini granted --by Jaden
node src/cli/index.mjs model invoke task.json gemini --live --approval-id 01M8EXAMPLE --ledger approvals.db
```

## What M-8 does not change

- The stub path (`--live` absent) is byte-identical to M-2: `read_only`, mock
  model, no approval consulted, and `--approval-id` there is a usage error.
- The engine is untouched: A5b already existed (M-7). M-8 only feeds it — the
  augmentation happens before `decide()`, in the caller, driven by a
  ledger record a human with `model.admin` created.
- No network call is required to test any of this: the live *transport* hop
  stays behind the credential and `ALLOW_LIVE` gates (M-7); the gate-level
  tests use the stub answer that follows a permitting decision.

## M-8 tests

`test/model/ledger-registry.test.mjs`: AT-M8-01 no entry → A5, AT-M8-02 bound
`granted` entry → augmented, A5b, stub answer returned, AT-M8-03 denied → A1,
AT-M8-04 pending → A5, AT-M8-05 timed_out → A2, AT-M8-06 an approval for
another task grants nothing (A6b), AT-M8-07 no duplicate augmentation,
AT-M8-08 the stub path is byte-identical to M-2, AT-M8-09 the helper's
`approved`/`entry` split (unbound and id-less callers get the entry but never
the augmentation), AT-M8-10 the persistent ledger answers through the same
helper, AT-M8-11 a malformed task is refused before any ledger is consulted.
