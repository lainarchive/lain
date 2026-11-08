import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * V-1 end-to-end acceptance (AT-V1-E2E-*).
 *
 * This is the milestone's own claim, exercised as a *process* rather than as a
 * function call: `lain task run` on a task file, with `LAIN_HOME` pointed at a
 * temporary directory so the run cannot touch the user's real state.
 *
 * Note the deliberate asymmetry — this test file is allowed to import
 * `node:child_process`, because `tools/check/process-boundary.mjs` polices
 * `src/` only. The product's rule is that a *shipped* module has one spawn site;
 * a test that runs the shipped entry point is the point of the test.
 */

const CLI = fileURLToPath(new URL('../../src/cli/index.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../examples/hello-task.json', import.meta.url));

/** Run the CLI as a real process against a temporary LAIN_HOME. */
function lain(args, home) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAIN_HOME: home, LAIN_DISABLE_GPU_PROBE: '1' },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'lain-cli-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTask(home, name, body) {
  const path = join(home, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test('AT-V1-E2E-01 (acceptance): `lain task run` completes one authorized task and writes real evidence', () => {
  withHome((home) => {
    const run = lain(['task', 'run', '--task', EXAMPLE, '--keep-workspace', '--json'], home);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);

    // stdout is exactly one JSON document, even though the CLI also prints a
    // human notice — the notice belongs on stderr in JSON mode.
    const outcome = JSON.parse(run.stdout);
    assert.equal(outcome.state, 'completed');
    assert.equal(outcome.invocation.status, 'ok');
    assert.equal(outcome.invocation.executed, true);
    assert.equal(outcome.admission.outcome, 'allow_with_conditions');
    assert.deepEqual(outcome.admission.conditions, ['workspace_only'], 'a reversible write is allowed only inside the workspace');
    assert.deepEqual(outcome.result.checks.map((c) => c.verdict), ['passed', 'passed']);
    assert.deepEqual(outcome.result.not_verified, [], `nothing should be unverified here: ${JSON.stringify(outcome.result.not_verified)}`);
    assert.deepEqual(outcome.result.indeterminate, []);
    assert.ok(outcome.result.evidence.length >= 3, 'evidence must name the decisions, the invocation and the workspace');

    // The evidence is real: the artifact exists on disk, inside the workspace,
    // with the content the script wrote.
    const workspace = join(home, 'workspaces', outcome.task_id);
    const written = join(workspace, 'health.json');
    assert.equal(existsSync(written), true);
    const facts = JSON.parse(readFileSync(written, 'utf8'));
    assert.equal(
      String(facts.cwd).toLowerCase().endsWith(outcome.task_id.toLowerCase()),
      true,
      `the child ran inside its own workspace, cwd was ${facts.cwd}`,
    );

    // Both stores exist, which is what makes the run provable afterwards.
    assert.equal(existsSync(join(home, 'events.db')), true);
    assert.equal(existsSync(join(home, 'tasks.db')), true);
  });
});

test('AT-V1-E2E-02: the run is provable afterwards from the log alone — `task show` and `store verify` agree', () => {
  withHome((home) => {
    const run = lain(['task', 'run', '--task', EXAMPLE, '--json'], home);
    assert.equal(run.status, 0, run.stderr);
    const outcome = JSON.parse(run.stdout);
    // Without --keep-workspace the notice must not have contaminated stdout.
    assert.equal(run.stdout.trimEnd().endsWith('}'), true, 'no trailing notice may follow the JSON document');

    const show = lain(['task', 'show', outcome.task_id, '--json'], home);
    assert.equal(show.status, 0, show.stderr);
    const record = JSON.parse(show.stdout);
    assert.equal(record.task.state, 'completed');
    assert.ok(record.task.result, 'the stored task must carry its result');
    assert.deepEqual(record.task.result.checks.map((c) => c.verdict), ['passed', 'passed']);
    // The history is the proof: a state claim with no transitions behind it is
    // what the verify step exists to catch.
    assert.deepEqual(record.history.map((h) => h.to), ['submitted', 'admitted', 'running', 'completed']);
    assert.equal(record.verification.ok, true);

    const verify = lain(['store', 'verify'], home);
    assert.equal(verify.status, 0, `store verify failed:\n${verify.stdout}\n${verify.stderr}`);
    assert.match(verify.stdout, /ok|verified|clean/i);
  });
});

test('AT-V1-E2E-03: a task with no acceptance criteria is refused before any store is written', () => {
  withHome((home) => {
    const file = writeTask(home, 'no-criteria.json', {
      objective: 'do something unverifiable',
      acceptance_criteria: [],
      tool_id: 'run_script',
      tool_arguments: { script: 'console.log(1)' },
    });
    const run = lain(['task', 'run', '--task', file], home);
    assert.equal(run.status, 3, `expected the refusal exit code, got ${run.status}`);
    assert.match(run.stderr, /NO_ACCEPTANCE_CRITERIA|criterion/i);
    assert.equal(existsSync(join(home, 'tasks.db')), false, 'a refused task must not leave a task record');
  });
});

test('AT-V1-E2E-04: a task naming an unregistered tool is denied, and no workspace is created', () => {
  withHome((home) => {
    const file = writeTask(home, 'unknown-tool.json', {
      objective: 'ask for a tool that does not exist',
      acceptance_criteria: [{ id: 'c1', statement: 'nothing happens', check: { kind: 'assertion', exit_code: 0 }, required: true }],
      capabilities: ['workspace.write'],
      tool_id: 'rm_rf',
      tool_arguments: {},
    });
    const run = lain(['task', 'run', '--task', file, '--json'], home);
    assert.equal(run.status, 4, `expected the failure exit code, got ${run.status}\n${run.stdout}`);
    const outcome = JSON.parse(run.stdout);
    assert.equal(outcome.state, 'failed', 'a denied admission fails the task');
    assert.equal(outcome.admission.outcome, 'deny');
    assert.equal(outcome.admission.reason_code, 'POLICY_RULE_FORBIDS');
    assert.equal(outcome.invocation, null, 'nothing may be invoked when admission denied it');
    assert.equal(outcome.result, null, 'a failed task records no result rather than an empty one');
    assert.equal(existsSync(join(home, 'workspaces')), false, 'a denied task must not create a workspace');
  });
});

test('AT-V1-E2E-05: a task that does not hold the capabilities its tool needs is refused, and nothing runs', () => {
  withHome((home) => {
    const file = writeTask(home, 'no-capabilities.json', {
      objective: 'try to run a script with no capability grant',
      acceptance_criteria: [{ id: 'c1', statement: 'nothing happens', check: { kind: 'assertion', exit_code: 0 }, required: true }],
      capabilities: [],
      tool_id: 'run_script',
      tool_arguments: { script: 'console.log("should not run")' },
    });
    const run = lain(['task', 'run', '--task', file, '--json'], home);
    assert.notEqual(run.status, 0, 'an ungranted capability must not produce a successful run');
    const outcome = JSON.parse(run.stdout);
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.admission.outcome, 'defer');
    assert.equal(outcome.admission.reason_code, 'CAPABILITY_NOT_GRANTED');
    assert.equal(outcome.invocation, null, 'the tool must not be invoked');
    assert.equal(outcome.result, null);
    assert.equal(existsSync(join(home, 'workspaces')), false, 'a refused task leaves no workspace behind');
  });
});

test('AT-V1-E2E-06: a missing task file is an error, not a crash and not a silent success', () => {
  withHome((home) => {
    const run = lain(['task', 'run', '--task', join(home, 'does-not-exist.json')], home);
    assert.notEqual(run.status, 0, 'a missing task file must not exit 0');
    assert.equal(/eref|SyntaxError|TypeError/.test(run.stderr), false, `the failure must be explained, not a stack trace:\n${run.stderr}`);
  });
});

test('AT-V1-E2E-06b: usage is reported when no command is given', () => {
  withHome((home) => {
    const run = lain([], home);
    assert.equal(run.status, 2, 'no command is a usage error');
  });
});
