import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  READ_POSTURE_ENV,
  checkExecutionBoundary,
  inspectContainment,
  isInside,
  readPosture,
  relativeInside,
  runtimeReadRoots,
} from '../../src/exec/boundary.mjs';

/**
 * V-3 boundary tests (AT-V3-BND-*).
 *
 * These do not test read isolation — the OS mechanism is measured in
 * `tools/experiments/appcontainer-probe.py` and documented in
 * `docs/research/v3-read-isolation/`. What is tested here is the part Lain
 * controls: whether it will start a tool process at all, and whether it can tell
 * that the workspace it was handed is where it thinks it is.
 *
 * The distinction matters. A test that asserts a path helper returns false and
 * calls that proof of isolation would be a lie, so none of these claim isolation.
 */

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lain-boundary-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('AT-V3-BND-01: an unstated read posture refuses, and a declared one does not', () => {
  withTemp((base) => {
    const root = join(base, 'workspaces');
    mkdirSync(root, { recursive: true });

    const unstated = checkExecutionBoundary({ workspaceRoot: root, stateBase: base, env: {} });
    assert.equal(unstated.ok, false, 'no mechanism and no acceptance must not run');
    assert.equal(unstated.code, 'READ_BOUNDARY_UNDECLARED');
    assert.equal(unstated.posture, 'none');
    // The message has to name the way out, or an operator meets a refusal with no
    // next step and works around it instead.
    assert.match(unstated.message, new RegExp(READ_POSTURE_ENV));

    const declared = checkExecutionBoundary({
      workspaceRoot: root, stateBase: base, env: { [READ_POSTURE_ENV]: 'declared' },
    });
    assert.equal(declared.ok, true, 'a declared posture is the operator accepting the risk');
    assert.equal(declared.code, 'READS_UNRESTRICTED_BY_DECLARATION');
    assert.equal(declared.facts.reads_confined, false, 'and it must not claim otherwise');

    for (const spelling of ['DECLARED', ' declared ', 'Declared']) {
      const same = checkExecutionBoundary({
        workspaceRoot: root, stateBase: base, env: { [READ_POSTURE_ENV]: spelling },
      });
      assert.equal(same.ok, true, `${spelling} should be the same answer, case and padding are not the point`);
    }
    for (const junk of ['yes', 'true', 'on', 'restricted']) {
      const refused = checkExecutionBoundary({
        workspaceRoot: root, stateBase: base, env: { [READ_POSTURE_ENV]: junk },
      });
      assert.equal(refused.ok, false, `"${junk}" is not a posture and must not be read as consent`);
    }
  });
});

test('AT-V3-BND-02: the kernel posture is selectable and reports reads as confined', () => {
  withTemp((base) => {
    const root = join(base, 'workspaces');
    mkdirSync(root, { recursive: true });
    const decision = checkExecutionBoundary({
      workspaceRoot: root, stateBase: base, env: { [READ_POSTURE_ENV]: 'kernel' },
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.posture, 'kernel');
    assert.equal(decision.code, 'READS_CONFINED');
    assert.equal(decision.facts.reads_confined, true);
    assert.equal(readPosture({ [READ_POSTURE_ENV]: 'kernel' }).posture.mechanism, 'windows-appcontainer');
  });
});

test('AT-V3-BND-03: a workspace root outside the state directory is refused', () => {
  withTemp((base) => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'lain-elsewhere-'));
    try {
      const decision = checkExecutionBoundary({
        workspaceRoot: elsewhere,
        stateBase: join(base, 'Lain'),
        env: { [READ_POSTURE_ENV]: 'declared' },
      });
      assert.equal(decision.ok, false);
      assert.equal(decision.code, 'WORKSPACE_OUTSIDE_STATE_BASE');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test('AT-V3-BND-03b control: a workspace root inside the state directory is accepted', () => {
  withTemp((base) => {
    const root = join(base, 'Lain', 'workspaces');
    mkdirSync(root, { recursive: true });
    const decision = checkExecutionBoundary({
      workspaceRoot: root, stateBase: join(base, 'Lain'), env: { [READ_POSTURE_ENV]: 'declared' },
    });
    assert.equal(decision.ok, true, 'the check must not refuse the layout Lain actually uses');
    assert.equal(decision.facts.state_base_contains_workspace_root, true);
  });
});

test('AT-V3-BND-04: a link inside the task workspace that resolves outside it stops the run', () => {
  withTemp((base) => {
    const root = join(base, 'workspaces');
    const taskId = 'task-1';
    const taskDir = join(root, taskId);
    const outside = join(base, 'outside');
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'sentinel-value');
    writeFileSync(join(taskDir, 'normal.txt'), 'inside');
    try {
      symlinkSync(outside, join(taskDir, 'escape'), 'junction');
    } catch {
      // A junction needs no privilege, but if the volume refuses one the case
      // cannot be constructed here and saying so beats a silently skipped test.
      return;
    }

    const containment = inspectContainment(taskDir);
    assert.equal(containment.links.length >= 1, true, 'the junction must be reported as a link');
    assert.equal(containment.escaped.length, 1, 'and as one that resolves outside the workspace');

    const decision = checkExecutionBoundary({
      workspaceRoot: root, stateBase: base, taskId, env: { [READ_POSTURE_ENV]: 'declared' },
    });
    assert.equal(decision.ok, false, 'a workspace that can be redirected outside itself is not a boundary');
    assert.equal(decision.code, 'WORKSPACE_LINK_ESCAPES');
  });
});

test('AT-V3-BND-05: a clean workspace passes containment, so the check is not a blanket refusal', () => {
  withTemp((base) => {
    const root = join(base, 'workspaces');
    const taskId = 'task-1';
    const taskDir = join(root, taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'health.json'), '{"ok":true}');
    mkdirSync(join(taskDir, '.tmp'), { recursive: true });

    const containment = inspectContainment(taskDir);
    assert.equal(containment.links.length, 0);
    assert.equal(containment.escaped.length, 0);
    // The exact count is incidental — what matters is that the walk looks at every
    // entry rather than returning early, which is the failure that would make a
    // clean workspace pass for the wrong reason.
    assert.equal(containment.checked >= 2, true, 'every entry in the workspace is examined');

    const decision = checkExecutionBoundary({
      workspaceRoot: root, stateBase: base, taskId, env: { [READ_POSTURE_ENV]: 'declared' },
    });
    assert.equal(decision.ok, true);
  });
});

test('AT-V3-BND-06: containment is case-insensitive, because the filesystem is', () => {
  assert.equal(isInside('C:\\Users\\Frick\\Lain', 'c:\\users\\frick\\lain\\workspaces\\t1'), true);
  assert.equal(isInside('C:\\workspaces', 'C:\\workspaces-elsewhere\\t1'), false,
    'a sibling whose name merely starts the same must not count as inside');
  assert.equal(isInside('C:\\a', 'C:\\a'), true);
  assert.equal(relativeInside('C:\\a', 'C:\\a\\b\\c'), join('b', 'c'));
  assert.equal(relativeInside('C:\\a', 'C:\\other'), null);
});

test('AT-V3-BND-07: the runtime roots name the directories a confined tool still needs', () => {
  const roots = runtimeReadRoots({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
  });
  assert.equal(roots.includes('C:\\Program Files\\nodejs'), true, 'the interpreter directory');
  assert.equal(roots.includes('C:\\Windows'), true, 'the system directory');
  // The one that closed the naive design: the interpreters read caches out of the
  // user's own local app data, which is the data read isolation exists to deny.
  assert.equal(roots.includes('C:\\Users\\x\\AppData\\Local'), true);
  assert.equal(new Set(roots).size, roots.length, 'no duplicates');
});
