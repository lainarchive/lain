import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from '../../src/tools/registry.mjs';
import { createInvoker, ToolError } from '../../src/tools/invoke.mjs';
import { createWorkspace, buildEnv, scrubPath, WorkspaceError } from '../../src/exec/workspace.mjs';
import { createRunScriptTool, RUN_SCRIPT_ID } from '../../src/tools/run-script.mjs';
import { decide } from '../../src/policy/decide.mjs';
import { DEFAULT_RULES, buildContext, validateRuleSet, PolicyConfigError } from '../../src/policy/rules.mjs';

/**
 * V-1 tool and execution tests (AT-V1-TOOL-*).
 *
 * The properties: a tool cannot describe itself as safer than the rules allow,
 * nothing runs without a recorded decision, `denied` is not `error`, and the
 * workspace refuses to write outside itself.
 */

const RULES = validateRuleSet(DEFAULT_RULES);
const NOW = () => 1_700_000_000_000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lain-ws-'));
}

/** A decision that permits execution, produced by the real policy engine. */
function allowedDecision(toolId = 'run_script') {
  const ctx = buildContext({
    rules: RULES,
    tool_id: toolId,
    granted_capabilities: ['workspace.write', 'process.spawn', 'workspace.read'],
    budget: {},
    approval: null,
    complete: true,
  });
  return decide(
    { action: 'tool.invoke', target: toolId, task_id: 'task-1', requested_capabilities: [], effect_class: 'local_reversible' },
    ctx,
    { now: NOW },
  );
}

test('AT-V1-TOOL-01: a tool absent from the rule set cannot be registered', () => {
  const registry = createRegistry({ rules: RULES });
  assert.throws(
    () => registry.register({ tool_id: 'rm_rf', summary: 'x', requires: [], effect_class: 'local_irreversible', spawns_processes: false, run: () => ({}) }),
    (err) => {
      assert.ok(err instanceof PolicyConfigError);
      return true;
    },
  );
  assert.equal(registry.get('rm_rf'), null);
});

test('AT-V1-TOOL-02: a tool may not claim to be safer than the rules allow, nor hold extra authority', () => {
  const registry = createRegistry({ rules: RULES });
  // run_script is local_reversible in the rules; claiming read_only is refused.
  assert.throws(
    () => registry.register({ tool_id: 'run_script', summary: 'x', requires: ['workspace.write', 'process.spawn'], effect_class: 'read_only', spawns_processes: true, run: () => ({}) }),
    /effect class|PolicyConfigError/i,
  );
  // Omitting a capability the rules require is refused too.
  assert.throws(
    () => registry.register({ tool_id: 'run_script', summary: 'x', requires: ['workspace.write'], effect_class: 'local_reversible', spawns_processes: true, run: () => ({}) }),
    /does not require process\.spawn|authority/i,
  );
});

test('AT-V1-TOOL-03 (positive control): a compliant tool registers and reports the capabilities the rules demand', () => {
  const registry = createRegistry({ rules: RULES });
  const dir = tempDir();
  try {
    const tool = createRunScriptTool({ workspace: createWorkspace({ task_id: 'task-1', root: dir }) });
    registry.register(tool);
    assert.equal(registry.get(RUN_SCRIPT_ID)?.tool_id, 'run_script');
    assert.deepEqual(registry.requiredCapabilities('run_script').sort(), ['process.spawn', 'workspace.write']);
    assert.equal(registry.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-04: an invocation without a decision is refused before anything happens', async () => {
  const registry = createRegistry({ rules: RULES });
  const events = [];
  const dir = tempDir();
  try {
    registry.register(createRunScriptTool({ workspace: createWorkspace({ task_id: 'task-1', root: dir }) }));
    const invoker = createInvoker({
      registry,
      workspace: createWorkspace({ task_id: 'task-1', root: dir }),
      record: (event) => events.push(event),
    });
    await assert.rejects(
      () =>
        invoker.invoke({
          tool_id: 'run_script',
          arguments: { script: 'console.log(1)' },
          decision: /** @type {any} */ (null),
          task_id: 'task-1',
          capabilities: ['workspace.write', 'process.spawn'],
          budget: { remaining_tool_calls: 1, max_output_bytes: 4096, max_wall_ms: 5_000 },
        }),
      (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'NO_DECISION');
        return true;
      },
    );
    assert.deepEqual(events, [], 'nothing may be recorded as decided when there was no decision');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-05: a denial is a `denied` outcome, not an error, and it is recorded first', async () => {
  const registry = createRegistry({ rules: RULES });
  const events = [];
  const dir = tempDir();
  try {
    registry.register(createRunScriptTool({ workspace: createWorkspace({ task_id: 'task-1', root: dir }) }));
    const denied = decide(
      { action: 'tool.invoke', target: 'run_script', task_id: 'task-1', requested_capabilities: [] },
      buildContext({ rules: RULES, tool_id: 'rm_rf', granted_capabilities: [], budget: {}, approval: null, complete: true }),
      { now: NOW },
    );
    const invoker = createInvoker({
      registry,
      workspace: createWorkspace({ task_id: 'task-1', root: dir }),
      record: (event) => events.push(event),
    });
    const outcome = await invoker.invoke({
      tool_id: 'run_script',
      arguments: { script: 'console.log(1)' },
      decision: denied,
      task_id: 'task-1',
      capabilities: ['workspace.write', 'process.spawn'],
      budget: { remaining_tool_calls: 1, max_output_bytes: 4096, max_wall_ms: 5_000 },
    });
    assert.equal(outcome.status, 'denied');
    assert.equal(outcome.executed, false);
    assert.equal(events.length, 1, 'the decision is recorded before the effect is considered');
    assert.equal(events[0].event_type, 'policy.decided');
    assert.equal(events[0].payload.reason_code, 'POLICY_RULE_FORBIDS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-06: the workspace refuses a write outside itself, and allows the one inside (positive control)', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    const workspace = createWorkspace({ task_id: 'task-1', root: dir });
    const sandbox = join(dir, 'task-1');

    // Inside: allowed.
    const inside = workspace.resolve('health.json');
    assert.equal(inside.ok, true);
    workspace.write('health.json', '{"ok":true}\n');
    assert.equal(readFileSync(join(sandbox, 'health.json'), 'utf8'), '{"ok":true}\n');

    // Outside, by three different routes: parent traversal, an absolute path,
    // and a Windows device path.
    for (const attempt of ['../escape.txt', join(outside, 'escape.txt'), '\\\\?\\C:\\Windows\\Temp\\escape.txt']) {
      const verdict = workspace.resolve(attempt);
      assert.equal(verdict.ok, false, `${attempt} must be refused`);
      assert.ok(['OUTSIDE_WORKSPACE', 'DEVICE_PATH', 'FORBIDDEN_PATH'].includes(verdict.code), `unexpected code ${verdict.code} for ${attempt}`);
    }
    assert.equal(existsSync(join(outside, 'escape.txt')), false, 'the refused write must not have happened');

    // The scrub function is the underlying rule, so it is worth exercising
    // directly: a path that resolves outside is refused even when it is inside
    // the string.
    const scrubbed = scrubPath(dir, join(outside, 'escape.txt'));
    assert.equal(scrubbed.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-07: the child environment is constructed, not inherited', () => {
  const env = buildEnv({ workspace: 'C:\\ws', temp: 'C:\\ws\\.tmp' });
  assert.equal(env.TEMP, 'C:\\ws\\.tmp');
  assert.equal(env.TMP, 'C:\\ws\\.tmp');
  for (const forbidden of ['USERPROFILE', 'APPDATA', 'HOME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) {
    assert.equal(forbidden in env, false, `${forbidden} must not reach a child process`);
  }
});

test('AT-V1-TOOL-08 (real execution): run_script runs a real process inside the workspace and its output is captured', async () => {
  const registry = createRegistry({ rules: RULES });
  const events = [];
  const dir = tempDir();
  try {
    const workspace = createWorkspace({ task_id: 'task-1', root: dir });
    registry.register(createRunScriptTool({ workspace }));
    const invoker = createInvoker({ registry, workspace, record: (event) => events.push(event) });
    const outcome = await invoker.invoke({
      tool_id: 'run_script',
      arguments: { script: 'import { writeFileSync } from "node:fs"; writeFileSync("health.json", JSON.stringify({ ok: true })); console.log("done");' },
      decision: allowedDecision('run_script'),
      task_id: 'task-1',
      capabilities: ['workspace.write', 'process.spawn'],
      budget: { remaining_tool_calls: 1, max_output_bytes: 65_536, max_wall_ms: 20_000 },
    });
    assert.equal(outcome.status, 'ok', `expected ok, got ${JSON.stringify(outcome)}`);
    assert.equal(outcome.executed, true);
    assert.match(String(outcome.result?.stdout ?? ''), /done/);
    assert.equal(readFileSync(join(dir, 'task-1', 'health.json'), 'utf8'), '{"ok":true}');
    assert.ok(events.some((e) => e.event_type === 'tool.executed'), `the execution is recorded, got ${JSON.stringify(events.map((e) => e.event_type))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-10: a script may be given as an array of lines, and the array is the same program', () => {
  const dir = tempDir();
  try {
    const workspace = createWorkspace({ task_id: 'task-1', root: dir });
    workspace.create();
    const tool = createRunScriptTool({ workspace });
    const ctx = { budget: { max_wall_ms: 10_000, max_output_bytes: 4096 }, task_id: 'task-1', decision_id: 'd1' };
    const result = tool.run({ script: ['const answer = 6 * 7;', 'console.log(answer);', ''] }, ctx);
    assert.equal(result.exit_code, 0);
    assert.equal(String(result.stdout).trim(), '42');
    assert.match(readFileSync(join(dir, 'task-1', 'task-script.mjs'), 'utf8'), /const answer = 6 \* 7;\nconsole\.log\(answer\);\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-11: an empty or malformed script is refused before anything is written', () => {
  const dir = tempDir();
  try {
    const workspace = createWorkspace({ task_id: 'task-1', root: dir });
    workspace.create();
    const tool = createRunScriptTool({ workspace });
    const ctx = { budget: { max_wall_ms: 10_000, max_output_bytes: 4096 }, task_id: 'task-1', decision_id: 'd1' };
    for (const bad of ['', '   ', [], [1, 2], null]) {
      assert.throws(() => tool.run({ script: bad }, ctx), (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'SCRIPT_EMPTY');
        return true;
      });
    }
    assert.equal(existsSync(join(dir, 'task-1', 'task-script.mjs')), false, 'nothing may be written when the script is refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AT-V1-TOOL-09: a workspace write outside itself is refused, and a filesystem failure is named', () => {
  const dir = tempDir();
  try {
    const workspace = createWorkspace({ task_id: 'task-1', root: dir });
    workspace.create();
    assert.throws(() => workspace.write('../escape.txt', 'x'), (err) => {
      assert.ok(err instanceof WorkspaceError);
      assert.equal(err.code, 'OUTSIDE_WORKSPACE');
      return true;
    });
    // A path that collides with an existing regular file is a real failure, not
    // a silent success: the workspace may not quietly replace a file with a
    // directory to make room for a write.
    writeFileSync(join(dir, 'task-1', 'a-file.txt'), 'x');
    assert.throws(() => workspace.write('a-file.txt/nested.txt', 'y'), WorkspaceError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
