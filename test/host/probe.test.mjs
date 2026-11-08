/**
 * Probe tests — deterministic fixtures, not this machine.
 *
 * The rule these tests exist to enforce: a value that could not be measured is
 * reported as unavailable with a reason, and is never replaced by a plausible
 * number. Several cases below are written so that a naive implementation would
 * silently produce `0` or `undefined` and pass a weaker test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRecord,
  collect,
  measured,
  parseNvidiaSmiCsv,
  probeDisk,
  probeGpu,
  PROBE_SCHEMA_VERSION,
  unavailable,
  unsupported,
} from '../../src/host/probe.mjs';

/** A complete synthetic probe input. */
function fixtureInput(overrides = {}) {
  return {
    platform: 'win32',
    release: '10.0.26200',
    arch: 'x64',
    node_version: '24.21.0',
    cpu_model_parts: ['Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz'],
    logical_cpu_count: 4,
    total_memory_bytes: 17_043_750_912,
    free_memory_bytes: 8_580_000_000,
    gpu: { ...measured(1, 'nvidia-smi'), detail: { name: 'NVIDIA GeForce RTX 3050', total_mib: 6144, used_mib: 614, free_mib: 5389, utilization_percent: 5, temperature_c: 77 } },
    disk: { ...measured(100, 'node:fs.statfsSync'), detail: { total_bytes: 997_000_000_000, free_bytes: 78_000_000_000 } },
    capabilities: ['sqlite:3.53.4'],
    ...overrides,
  };
}

test('the record carries a schema version and a timestamp', () => {
  const record = buildRecord(fixtureInput());
  assert.equal(record.probe_schema_version, PROBE_SCHEMA_VERSION);
  assert.match(record.probed_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a supported Windows environment is described with its measurements', () => {
  const record = buildRecord(fixtureInput());
  assert.equal(record.os.platform, 'win32');
  assert.equal(record.cpu.logical_count, 4);
  assert.equal(record.memory.total_bytes.status, 'measured');
  assert.equal(record.memory.total_bytes.value, 17_043_750_912);
  assert.equal(record.memory.total_bytes.source, 'node:os.totalmem');
});

test('an unmeasurable total memory is unavailable with a reason, not zero', () => {
  const record = buildRecord(fixtureInput({ total_memory_bytes: null }));
  assert.equal(record.memory.total_bytes.value, null);
  assert.equal(record.memory.total_bytes.status, 'unavailable');
  assert.match(String(record.memory.total_bytes.reason), /could not be read/);
  assert.notEqual(record.memory.total_bytes.value, 0);
});

test('an unmeasurable free memory is unavailable, so it cannot be mistaken for exhausted memory', () => {
  const record = buildRecord(fixtureInput({ free_memory_bytes: null }));
  assert.equal(record.memory.free_bytes.value, null);
  assert.equal(record.memory.free_bytes.status, 'unavailable');
});

test('missing GPU tooling yields unavailable GPU data and the probe still succeeds', () => {
  const record = buildRecord(fixtureInput({
    gpu: unavailable('nvidia-smi is not on PATH, so GPU memory could not be measured', 'nvidia-smi'),
  }));
  assert.equal(record.gpu.status, 'unavailable');
  assert.equal(record.gpu.free_mib, undefined);
  assert.match(String(record.gpu.reason), /not on PATH/);
  assert.equal(record.memory.total_bytes.status, 'measured');
});

test('GPU detail is present exactly when the probe measured it', () => {
  const withGpu = buildRecord(fixtureInput());
  assert.equal(withGpu.gpu.status, 'measured');
  assert.equal(withGpu.gpu.free_mib, 5389);

  const withoutGpu = buildRecord(fixtureInput({ gpu: unavailable('no tool', 'nvidia-smi') }));
  assert.equal(Object.hasOwn(withoutGpu.gpu, 'free_mib'), false);
});

test('unsupported disk measurement is distinguished from an unavailable one', () => {
  const record = buildRecord(fixtureInput({
    disk: unsupported('fs.statfsSync is not available in this Node build', 'node:fs'),
  }));
  assert.equal(record.disk.status, 'unsupported');
  assert.equal(record.disk.total_bytes, null);
  assert.equal(record.disk.free_bytes, null);
});

test('nvidia-smi CSV parsing reads six fields and rejects a short line', () => {
  const parsed = parseNvidiaSmiCsv('NVIDIA GeForce RTX 3050, 6144, 614, 5389, 5, 77\n');
  assert.deepEqual(parsed, {
    name: 'NVIDIA GeForce RTX 3050',
    total_mib: 6144,
    used_mib: 614,
    free_mib: 5389,
    utilization_percent: 5,
    temperature_c: 77,
  });
  assert.equal(parseNvidiaSmiCsv('NVIDIA GeForce RTX 3050, 6144, 614'), null);
  assert.equal(parseNvidiaSmiCsv(''), null);
});

test('a malformed GPU reading is refused rather than parsed as zero', () => {
  const parsed = parseNvidiaSmiCsv('NVIDIA GeForce RTX 3050, [Not Supported], [N/A], 5389, 5, 77');
  assert.equal(parsed, null);

  const probe = probeGpu({ fileExists: () => true, parse: () => null });
  assert.notEqual(probe.status, 'measured');
  assert.match(String(probe.reason), /could not be parsed/);
});

test('the GPU probe reports the absence of the tool without throwing', () => {
  // The opt-out exists so this path can be exercised on a machine that does have
  // nvidia-smi; without it the test would report whatever this host happens to be.
  const previous = process.env.LAIN_DISABLE_GPU_PROBE;
  process.env.LAIN_DISABLE_GPU_PROBE = '1';
  try {
    const probe = probeGpu({ fileExists: () => false });
    assert.equal(probe.value, null);
    assert.ok(probe.status === 'unavailable');
    assert.match(String(probe.reason), /was not measured/);
    assert.notEqual(probe.status, 'measured');
  } finally {
    if (previous === undefined) delete process.env.LAIN_DISABLE_GPU_PROBE;
    else process.env.LAIN_DISABLE_GPU_PROBE = previous;
  }
});

test('disk probing on a path that cannot be read returns unavailable, not a guess', () => {
  const result = probeDisk('\u0000not-a-path');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.value, null);
  assert.match(String(result.reason), /statfs failed/);
});

test('collect() produces a record with every declared section', () => {
  const record = collect({
    volume: process.cwd(),
    gpuProbe: () => unavailable('fixture', 'nvidia-smi'),
    diskProbe: (path) => ({ ...measured(0, 'fixture'), detail: { total_bytes: 1, free_bytes: 1 } }),
  });
  for (const key of ['probe_schema_version', 'probed_at', 'os', 'runtime', 'cpu', 'memory', 'gpu', 'disk', 'capabilities']) {
    assert.ok(Object.hasOwn(record, key), `record is missing ${key}`);
  }
  assert.ok(Array.isArray(record.capabilities));
  assert.equal(record.disk.free_bytes, 1);
});

test('the probe record does not contain usernames or home paths', () => {
  const serialized = JSON.stringify(collect({
    volume: process.cwd(),
    gpuProbe: () => unavailable('fixture', 'nvidia-smi'),
    diskProbe: () => unavailable('fixture', 'node:fs'),
  }));
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const user = process.env.USERNAME ?? process.env.USER ?? '';
  if (home !== '') assert.equal(serialized.includes(home), false, 'the probe record leaked a home path');
  if (user.length > 2) assert.equal(serialized.includes(user), false, 'the probe record leaked a user name');
});

test('a fixture-driven probe record is deterministic apart from its timestamp', () => {
  const first = buildRecord(fixtureInput());
  const second = buildRecord(fixtureInput());
  assert.equal(JSON.stringify({ ...first, probed_at: null }), JSON.stringify({ ...second, probed_at: null }));
});
