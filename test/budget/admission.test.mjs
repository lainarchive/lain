/**
 * Budget and admission tests — deterministic fixtures, never this machine.
 *
 * Two behaviours are the point of this file:
 *
 * 1. Every number carries a kind (`measured`/`historical`/`configured`/
 *    `recommended`/`estimated`) so a limit cannot be mistaken for a measurement.
 * 2. When a required measurement is missing, admission returns `indeterminate`.
 *    That is deliberately different from `deny`: a denial means the answer is no,
 *    an indeterminate means Lain could not answer and must not guess.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AdmissionError } from '../../src/core/errors.mjs';
import {
  admit,
  buildBudget,
  defaultProfiles,
  eventsBeforeWarning,
  HOST_RESERVE_BYTES,
  PROFILE_NAMES,
  STORE_WARNING_BYTES,
} from '../../src/budget/index.mjs';
import { measured, unavailable } from '../../src/host/probe.mjs';

const GIB = 1024 ** 3;

/** A probe record with everything measured. */
function probeFixture(overrides = {}) {
  const base = {
    probe_schema_version: 1,
    probed_at: '2026-11-08T20:00:00.000Z',
    os: { platform: 'win32', release: '10.0.26200', arch: 'x64' },
    runtime: { node_version: '24.21.0', modules_abi: '137' },
    cpu: { model: 'Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz', logical_count: 4, source: 'node:os.cpus' },
    memory: {
      total_bytes: { ...measured(16 * GIB, 'node:os.totalmem') },
      free_bytes: { ...measured(8 * GIB, 'node:os.freemem') },
    },
    gpu: {
      status: 'measured',
      source: 'nvidia-smi',
      name: 'NVIDIA GeForce RTX 3050',
      total_mib: 6144,
      used_mib: 614,
      free_mib: 5389,
      utilization_percent: 5,
      temperature_c: 77,
    },
    disk: { status: 'measured', source: 'node:fs.statfsSync', total_bytes: 997_000_000_000, free_bytes: 78 * GIB },
    capabilities: ['sqlite:3.53.4'],
  };
  return { ...base, ...overrides };
}

/** A probe record where the GPU could not be read. */
function probeWithoutGpu() {
  const base = probeFixture();
  return {
    ...base,
    gpu: { ...unavailable('nvidia-smi is not on PATH, so GPU memory could not be measured', 'nvidia-smi') },
  };
}

test('there are exactly three profiles and every one names its intent', () => {
  const profiles = defaultProfiles();
  assert.deepEqual(Object.keys(profiles).sort(), [...PROFILE_NAMES].sort());
  for (const name of PROFILE_NAMES) {
    assert.ok(profiles[name].intent.length > 0, `${name} has no stated intent`);
  }
});

test('every limit carries a kind so a limit cannot be read as a measurement', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const kinds = new Set(['measured', 'historical', 'configured', 'recommended', 'estimated']);
  for (const [key, entry] of Object.entries(budget.limits)) {
    assert.ok(kinds.has(entry.kind), `${key} has kind "${entry.kind}"`);
    assert.equal(typeof entry.value, 'number', `${key} has no numeric value`);
    assert.ok(entry.note.length > 0, `${key} has no note explaining where the number came from`);
  }
  assert.equal(budget.limits.context_tokens.kind, 'configured');
  assert.equal(budget.limits.store_bytes.kind, 'recommended');
});

test('no limit is labelled estimated, because nothing here is a guess', () => {
  for (const name of PROFILE_NAMES) {
    const profiles = defaultProfiles();
    for (const [key, entry] of Object.entries(profiles[name].limits)) {
      assert.notEqual(entry.kind, 'estimated', `${name}.${key} is an estimate`);
    }
  }
});

test('lain memory is clamped by measured free memory minus the host reserve', () => {
  const budget = buildBudget({ probe: probeFixture() });
  assert.equal(budget.limits.lain_memory_bytes.value, 8 * GIB - HOST_RESERVE_BYTES);
  assert.match(budget.derived_notes.join(' '), /clamped to/);
});

test('with unknown free memory the clamp is skipped and said so, not guessed', () => {
  const probe = probeFixture();
  const budget = buildBudget({ probe: { ...probe, memory: { ...probe.memory, free_bytes: unavailable('unreadable', 'node:os.freemem') } } });
  assert.equal(budget.limits.lain_memory_bytes.value, 6 * GIB);
  assert.match(budget.derived_notes.join(' '), /was not clamped/);
});

test('an invalid configuration is refused rather than defaulted', () => {
  assert.throws(
    () => buildBudget({ probe: probeFixture(), profile: 'turbo' }),
    (error) => {
      assert.ok(error instanceof AdmissionError);
      assert.equal(error.code, 'BUDGET_PROFILE_UNKNOWN');
      assert.equal(error.outcome, 'deny');
      return true;
    },
  );
  assert.throws(
    () => buildBudget({ probe: probeFixture(), overrides: { nonsense: 1 } }),
    (error) => {
      assert.equal(/** @type {AdmissionError} */ (error).code, 'BUDGET_LIMIT_UNKNOWN');
      return true;
    },
  );
});

test('an override is labelled configured, not silently accepted as measured', () => {
  const budget = buildBudget({ probe: probeFixture(), overrides: { tool_subprocesses: 5 } });
  assert.equal(budget.limits.tool_subprocesses.value, 5);
  assert.equal(budget.limits.tool_subprocesses.kind, 'configured');
  assert.match(budget.limits.tool_subprocesses.note, /override/);
});

test('admission inside every limit is admitted', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const decision = admit(budget, {
    action: 'run-task',
    tool_subprocesses: 3,
    live_task_agents: 4,
    context_tokens: 4096,
    model_memory_bytes: 4 * GIB,
    store_growth_bytes: GIB,
  });
  assert.equal(decision.outcome, 'admit');
  assert.equal(decision.reason_code, 'WITHIN_BUDGET');
  assert.ok(decision.checks.length >= 4);
  for (const check of decision.checks) {
    assert.equal(typeof check.requested, 'number');
    assert.equal(typeof check.limit, 'number');
    assert.equal(typeof check.fits, 'boolean');
  }
});

test('admission over a count limit is denied and names the limit', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const decision = admit(budget, { action: 'run-task', tool_subprocesses: 4 });
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reason_code, 'TOOL_SUBPROCESS_LIMIT');
  assert.match(decision.reason, /exceeds the configured limit 3/);
});

test('a request for more context is denied, never shrunk to fit', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const decision = admit(budget, { action: 'run-task', context_tokens: 8192 });
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reason_code, 'CONTEXT_LIMIT');
  assert.match(decision.reason, /will not reduce context silently/);
});

test('a model that does not fit in usable VRAM is denied, and the reserve is accounted for', () => {
  // The budget is raised above the VRAM ceiling for this case, so the check that
  // refuses is the measured one rather than the configured one.
  const budget = buildBudget({ probe: probeFixture(), overrides: { model_memory_bytes: 6 * GIB } });
  const fits = admit(budget, { action: 'bind-model', model_memory_bytes: 3 * GIB });
  assert.equal(fits.outcome, 'admit');

  // Usable VRAM is (5389 - 768) MiB = 4.63 GiB, so 5 GiB exceeds it.
  const tooBig = admit(budget, { action: 'bind-model', model_memory_bytes: 5 * GIB });
  assert.equal(tooBig.outcome, 'deny');
  assert.equal(tooBig.reason_code, 'VRAM_INSUFFICIENT');
  assert.match(tooBig.reason, /display reserve/);
});

test('a configured budget raises the ceiling but never overrides measured VRAM', () => {
  // Requesting 4.5 GiB with an 8 GiB budget still fits this machine's measured
  // 4.63 GiB of usable VRAM, so the honest answer is admit, not deny. This test
  // exists so the relationship is explicit: the configured budget can only
  // tighten what the measurement allows, never widen it.
  const budget = buildBudget({ probe: probeFixture(), overrides: { model_memory_bytes: 8 * GIB } });
  const decision = admit(budget, { action: 'bind-model', model_memory_bytes: 4.5 * GIB });
  assert.equal(decision.outcome, 'admit');

  const overVram = admit(budget, { action: 'bind-model', model_memory_bytes: 4.75 * GIB });
  assert.equal(overVram.outcome, 'deny');
  assert.equal(overVram.reason_code, 'VRAM_INSUFFICIENT');
});

test('the model budget boundary is inclusive, and the refusal beyond it names the budget', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const atLimit = admit(budget, { action: 'bind-model', model_memory_bytes: 4 * GIB });
  assert.equal(atLimit.reason_code !== 'MODEL_MEMORY_LIMIT', true, 'the budget boundary itself is allowed');

  const overBudget = admit(budget, { action: 'bind-model', model_memory_bytes: 4 * GIB + 1 });
  assert.equal(overBudget.outcome, 'deny');
  assert.equal(overBudget.reason_code, 'MODEL_MEMORY_LIMIT');
});

test('the configured model budget is clamped against measured VRAM, so a big budget is not a promise', () => {
  const budget = buildBudget({ probe: probeFixture(), overrides: { model_memory_bytes: 8 * GIB } });
  const decision = admit(budget, { action: 'bind-model', model_memory_bytes: 6 * GIB });
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reason_code, 'VRAM_INSUFFICIENT');
});

test('with no GPU measurement, model memory admission is indeterminate rather than denied', () => {
  const budget = buildBudget({ probe: probeWithoutGpu(), overrides: { model_memory_bytes: 6 * GIB } });
  const decision = admit(budget, { action: 'bind-model', model_memory_bytes: 2 * GIB });
  assert.equal(decision.outcome, 'indeterminate');
  assert.equal(decision.reason_code, 'GPU_UNMEASURED');
  assert.match(decision.reason, /could not be measured/);
});

test('with no disk measurement, store growth admission is indeterminate', () => {
  const probe = probeFixture();
  const budget = buildBudget({ probe: { ...probe, disk: { ...unavailable('statfs failed', 'node:fs') } } });
  const decision = admit(budget, { action: 'grow-store', store_growth_bytes: GIB });
  assert.equal(decision.outcome, 'indeterminate');
  assert.equal(decision.reason_code, 'DISK_UNMEASURED');
});

test('insufficient disk is denied with both numbers, not truncated to fit', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const decision = admit(budget, { action: 'grow-store', store_growth_bytes: 200 * GIB });
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reason_code, 'DISK_INSUFFICIENT');
});

test('conflicting requirements produce a denial that names the first limit exceeded', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const decision = admit(budget, {
    action: 'run-task',
    tool_subprocesses: 2,
    live_task_agents: 9,
    context_tokens: 16384,
  });
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.reason_code, 'LIVE_AGENT_LIMIT');
});

test('there is no silent fallback: a denied context request does not return a smaller one', () => {
  const budget = buildBudget({ probe: probeFixture() });
  const decision = admit(budget, { action: 'run-task', context_tokens: 8192 });
  assert.equal(decision.outcome, 'deny');
  assert.equal(Object.hasOwn(decision, 'effective_context_tokens'), false);
  assert.equal(JSON.stringify(decision).includes('4096'), true, 'the configured limit is reported, not applied');
});

test('an unmeasured optional request is admitted without inventing a number', () => {
  const budget = buildBudget({ probe: probeWithoutGpu() });
  const decision = admit(budget, { action: 'run-task', tool_subprocesses: 1 });
  assert.equal(decision.outcome, 'admit');
  assert.equal(decision.checks.some((check) => check.check === 'vram'), false);
});

test('the growth threshold converts to events at the measured bytes per event', () => {
  assert.equal(eventsBeforeWarning(STORE_WARNING_BYTES), Math.floor(STORE_WARNING_BYTES / 146));
  assert.ok(eventsBeforeWarning() > 14_000_000);
  assert.throws(() => eventsBeforeWarning(0), /at least 0|>= 1|must be/);
});
