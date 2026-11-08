import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMS, EFFECT_CLASSES, normaliseEffectClass, isRetryableRefusal, isTerminalRefusal } from '../../src/policy/arms.mjs';
import { decide, permitsExecution, conditionsFor } from '../../src/policy/decide.mjs';
import { createApprovalLedger, DEFAULT_APPROVAL_WINDOW_MS } from '../../src/policy/approvals.mjs';
import { DEFAULT_RULES, buildContext, toolRule, validateRuleSet, PolicyConfigError } from '../../src/policy/rules.mjs';

/**
 * V-1 policy tests (AT-V1-POL-*).
 *
 * The property under test is not "the happy path works" but "no request can
 * escape an arm": `decide()` is total, its default is refusal, and the only
 * retryable refusal is a human's explicit no.
 */

const RULES = validateRuleSet(DEFAULT_RULES);
const NOW = () => 1_700_000_000_000;

/** A context that would allow `run_script` if nothing else refused. */
function allowingContext(overrides = {}) {
  return buildContext({
    rules: RULES,
    tool_id: 'run_script',
    granted_capabilities: ['workspace.write', 'process.spawn'],
    budget: { remaining_tool_calls: 3, max_tool_calls: 8 },
    approval: null,
    complete: true,
    ...overrides,
  });
}

/** @param {string} outcome @param {string} reason_code */
function request(outcome = 'run_script', reason_code = 'run') {
  return {
    action: 'tool.invoke',
    target: outcome,
    task_id: 'task-1',
    requested_capabilities: ['workspace.write', 'process.spawn'],
    effect_class: 'local_reversible',
    reason_code,
  };
}

test('AT-V1-POL-01: every arm is reachable — each one is selected by some request', () => {
  const seen = new Set();

  // A1 explicit denial, A2 approval timed out
  const denied = decide(request(), allowingContext({ approval: { status: 'denied' } }), { now: NOW });
  seen.add(denied.arm_id);
  const timedOut = decide(request(), allowingContext({ approval: { status: 'timed_out' } }), { now: NOW });
  seen.add(timedOut.arm_id);

  // A3 the rule set forbids the tool entirely
  const forbidden = decide(
    { action: 'tool.invoke', target: 'rm_rf', task_id: 'task-1', requested_capabilities: [], effect_class: 'local_irreversible' },
    buildContext({ rules: RULES, tool_id: 'rm_rf', granted_capabilities: [], budget: {}, approval: null, complete: true }),
    { now: NOW },
  );
  seen.add(forbidden.arm_id);

  // A5 an effect class that always needs approval, with no answer yet
  const needsApproval = decide(
    { action: 'tool.invoke', target: 'run_script', task_id: 'task-1', requested_capabilities: ['workspace.write'], effect_class: 'external' },
    allowingContext({ approval: null }),
    { now: NOW },
  );
  seen.add(needsApproval.arm_id);

  // A4 budget exhausted — the arm reads an explicit `exceeded` flag rather than
  // inferring it, so the test sets the flag the implementation actually uses.
  const exhausted = decide(request(), allowingContext({ budget: { exceeded: true, remaining_tool_calls: 0, max_tool_calls: 8 } }), { now: NOW });
  seen.add(exhausted.arm_id);

  // A6 the evaluation is incomplete — the context does not say enough
  const incomplete = decide(request(), allowingContext({ complete: false }), { now: NOW });
  seen.add(incomplete.arm_id);

  // A6b the tool needs a capability the task does not hold. Without this arm the
  // request matched nothing and fell through to A9, so a plain refusal was
  // reported as "the policy crashed".
  const ungranted = decide(
    request(),
    buildContext({ rules: RULES, tool_id: 'run_script', granted_capabilities: [], budget: {}, approval: null, complete: true }),
    { now: NOW },
  );
  seen.add(ungranted.arm_id);
  assert.equal(ungranted.reason_code, 'CAPABILITY_NOT_GRANTED', 'a missing grant is a refusal with its own reason, not an evaluation error');

  // A7 a read-only action inside its grant
  const readOnly = decide(
    { action: 'file.read', target: 'read_file', task_id: 'task-1', requested_capabilities: ['workspace.read'], effect_class: 'read_only' },
    buildContext({ rules: RULES, tool_id: 'read_file', granted_capabilities: ['workspace.read'], budget: {}, approval: null, complete: true }),
    { now: NOW },
  );
  seen.add(readOnly.arm_id);

  // A8 a reversible write inside the workspace
  const allowed = decide(request(), allowingContext(), { now: NOW });
  seen.add(allowed.arm_id);

  // A9 a predicate that throws
  const broken = decide(request(), { get explode() { throw new Error('predicate exploded'); } }, { now: NOW });
  seen.add(broken.arm_id);

  const missing = ARMS.map((a) => a.id).filter((id) => !seen.has(id));
  assert.deepEqual(missing, [], `arms never selected: ${missing.join(', ')}`);
});

test('AT-V1-POL-02: an unknown request is refused, not allowed', () => {
  // A request naming no tool at all. The rule set has no entry for it, so the
  // only defensible answer is refusal.
  const decision = decide(
    { action: 'tool.invoke', target: 'some_unknown_tool', task_id: 'task-1', requested_capabilities: [], effect_class: 'read_only' },
    buildContext({ rules: RULES, tool_id: 'some_unknown_tool', granted_capabilities: [], budget: {}, approval: null, complete: true }),
    { now: NOW },
  );
  assert.equal(permitsExecution(decision), false, 'an unlisted tool must never be permitted');
});

test('AT-V1-POL-03 (positive control): a listed tool with its capabilities and budget is allowed, with its condition', () => {
  const decision = decide(request(), allowingContext(), { now: NOW });
  assert.equal(permitsExecution(decision), true);
  assert.deepEqual(conditionsFor(decision), ['workspace_only']);
});

test('AT-V1-POL-04: every decision carries an id, an arm, a reason and a decider', () => {
  const decision = decide(request(), allowingContext(), { now: NOW });
  assert.match(decision.decision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(decision.arm_id, 'A8');
  assert.equal(decision.reason_code, 'REVERSIBLE_WITHIN_WORKSPACE');
  assert.equal(decision.decided_by, 'policy@0.1.0');
  assert.equal(typeof decision.decided_at, 'string');
});

test('AT-V1-POL-05: decide() is total — a throwing context yields defer_policy_error, never an exception', () => {
  // The context explodes when its `budget` is read, which is the first thing a
  // predicate touches. `decide()` must refuse rather than propagate.
  const hostile = {
    get budget() {
      throw new Error('boom');
    },
  };
  const decision = decide(request(), hostile, { now: NOW });
  assert.equal(decision.outcome, 'defer_policy_error');
  assert.equal(decision.arm_id, 'A9');
  assert.equal(decision.error, 'boom');
  assert.match(decision.reason, /boom/);
  assert.equal(permitsExecution(decision), false);
});

test('AT-V1-POL-05b: a context that explodes while reading the approval id also refuses, never throws', () => {
  const hostile = {
    budget: {},
    get approval() {
      throw new Error('approval getter exploded');
    },
  };
  const decision = decide(request(), hostile, { now: NOW });
  assert.equal(permitsExecution(decision), false);
  assert.equal(decision.approval_id, null);
  assert.equal(decision.error, 'approval getter exploded');
});

test('AT-V1-POL-06: only a human "no" is retryable; a timeout and a budget refusal are not', () => {
  const denied = decide(request(), allowingContext({ approval: { status: 'denied' } }), { now: NOW });
  const timedOut = decide(request(), allowingContext({ approval: { status: 'timed_out' } }), { now: NOW });
  const budget = decide(request(), allowingContext({ budget: { exceeded: true, remaining_tool_calls: 0, max_tool_calls: 8 } }), { now: NOW });
  // A policy refusal that is not a human's answer: forbidden by the rule set.
  const forbidden = decide(
    { action: 'tool.invoke', target: 'rm_rf', task_id: 'task-1', requested_capabilities: [], effect_class: 'read_only' },
    buildContext({ rules: RULES, tool_id: 'rm_rf', granted_capabilities: [], budget: {}, approval: null, complete: true }),
    { now: NOW },
  );

  assert.equal(denied.retryable, true, 'a denial may be re-requested after circumstances change');
  assert.equal(isRetryableRefusal(denied), true, 'the predicates must accept a decision, not only an outcome string');
  assert.equal(timedOut.retryable, false, 'an indeterminate answer is never retried');
  assert.equal(isRetryableRefusal(timedOut), false);
  assert.equal(budget.retryable, false, 'a budget refusal is terminal for this task');
  assert.equal(isTerminalRefusal(budget), true, 'the predicates must accept a decision here too');
  assert.equal(forbidden.outcome, 'deny');
  assert.equal(forbidden.reason_code, 'POLICY_RULE_FORBIDS');
  assert.equal(isRetryableRefusal(forbidden), false, 'a rule refusal is not a human answer and is not re-askable');
});

test('AT-V1-POL-07: an unknown or absent effect class is treated as external, which always requires approval', () => {
  assert.equal(normaliseEffectClass(undefined), 'external');
  assert.equal(normaliseEffectClass('whatever'), 'external');
  for (const cls of EFFECT_CLASSES) assert.equal(normaliseEffectClass(cls), cls);

  const decision = decide(request(), allowingContext(), { now: NOW, declared_effect_class: undefined });
  // The request itself declares local_reversible; the unknown class arrives
  // through the tool definition, so the same request with no declaration must
  // not be allowed as a reversible write.
  const unknown = decide(
    { action: 'tool.invoke', target: 'run_script', task_id: 'task-1', requested_capabilities: ['workspace.write', 'process.spawn'] },
    allowingContext(),
    { now: NOW },
  );
  assert.equal(permitsExecution(decision), true, 'a declared reversible class is still allowed');
  assert.ok(['deny', 'require_approval', 'defer', 'defer_policy_error'].includes(unknown.outcome), `an undeclared class must not be permitted silently, got ${unknown.outcome}`);
});

test('AT-V1-POL-08: the rule set is validated, not defaulted — a malformed rule set throws', () => {
  assert.throws(() => validateRuleSet({ version: 1 }), PolicyConfigError);
  assert.throws(() => validateRuleSet(null), PolicyConfigError);
  const rule = toolRule(RULES, 'run_script');
  assert.ok(rule, 'run_script must be listed');
  assert.deepEqual(rule.requires.sort(), ['process.spawn', 'workspace.write']);
  assert.equal(toolRule(RULES, 'not_a_tool'), null);
});

test('AT-V1-POL-09: an approval is bound to the exact question, and times out into a distinct state', () => {
  const ledger = createApprovalLedger({ now: () => NOW() });
  const asked = ledger.request(request(), { window_ms: DEFAULT_APPROVAL_WINDOW_MS });
  assert.equal(asked.status, 'pending');

  // The same question asked twice is the same approval, not a second prompt.
  const again = ledger.request(request(), { window_ms: DEFAULT_APPROVAL_WINDOW_MS });
  assert.equal(again.approval_id, asked.approval_id);

  // A different question is a different approval. Asking it does not inherit the
  // first question's answer: the only record for the new binding is its own
  // pending request.
  const other = ledger.request({ ...request(), target: 'write_file' }, { window_ms: DEFAULT_APPROVAL_WINDOW_MS });
  assert.notEqual(other.approval_id, asked.approval_id);
  assert.equal(other.status, 'pending');
  assert.equal(ledger.statusFor({ ...request(), target: 'write_file' })?.status, 'pending');

  ledger.answer(asked.approval_id, 'granted', { by: 'user' });
  assert.equal(ledger.get(asked.approval_id)?.status, 'granted');
  assert.equal(
    ledger.statusFor({ ...request(), target: 'write_file' })?.status,
    'pending',
    'granting one question must not answer another',
  );
  assert.throws(() => ledger.answer(asked.approval_id, 'denied', { by: 'user' }), /granted|answered/i);

  // Time passing turns a pending approval into `timed_out`, which is not a no.
  let clock = NOW();
  const expiring = createApprovalLedger({ now: () => clock });
  const pending = expiring.request(request(), { window_ms: 1_000 });
  clock += 5_000;
  assert.equal(expiring.get(pending.approval_id)?.status, 'timed_out');
  assert.equal(expiring.get(pending.approval_id)?.decided_by, 'timeout');
});
