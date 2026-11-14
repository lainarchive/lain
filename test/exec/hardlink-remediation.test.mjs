/**
 * The gate around the grant: does a hard link in the workspace stop the run
 * before it can pull the container ACE onto an outside object?
 *
 * The OS-level behaviour these tests defend against is measured in
 * docs/research/v3-read-isolation/hardlink-investigation.md (E1: the ACE lands
 * through the link; E3: a directory watcher wins the mkdir→grant race 20/20;
 * E5: icacls /remove takes the landed ACE back off). The gate is the code
 * answer: scan before the grant, scan after it, remove what landed, refuse.
 *
 * HL-07 replays the E3 race deterministically — the grant callback plants the
 * link itself — so the test does not depend on winning a real timing race.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createWorkspace } from '../../src/exec/workspace.mjs';
import {
  GRANT_ESCAPED, PRE_GRANT, LinkIsolationError,
  enforceLinkIsolation, scanForHardLinks, stripContainerAce,
} from '../../src/exec/hardlink-defect-remediation.mjs';
import { containerSid, runInJobSync } from '../../src/exec/job.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-hl-gate-'));
// The ungranted directories inside have inheritance stripped, so cleanup that
// cannot read them would leave a red suite behind for the wrong reason.
after(() => {
  spawnSync('icacls', [ROOT, '/reset', '/T', '/C', '/Q'], { encoding: 'utf8' });
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const NODE = process.execPath;
const SID = containerSid();
const skip = SID.ok ? false : `no container profile: ${SID.detail}`;
const OWNER = process.env.USERDOMAIN + '\\' + process.env.USERNAME;

function protect(dir) {
  const done = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${OWNER}:(OI)(CI)F`],
    { encoding: 'utf8' });
  assert.equal(done.status, 0, `could not strip inheritance: ${done.stdout}${done.stderr}`);
}

function grant(dir) {
  const done = spawnSync('icacls', [dir, '/grant', `*${SID.sid}:(OI)(CI)M`], { encoding: 'utf8' });
  assert.equal(done.status, 0, `grant failed for ${dir}: ${done.stdout}${done.stderr}`);
}

function carriesContainerAce(path) {
  return spawnSync('icacls', [path], { encoding: 'utf8' }).stdout
    .toLowerCase().includes(SID.sid.toLowerCase());
}

/** A read attempted inside the container, reported with its exact code. */
function readContained(file, cwd) {
  const script = [
    "const fs = require('node:fs');",
    `try { console.log('RESULT ' + JSON.stringify(fs.readFileSync(${JSON.stringify(file)}, 'utf8').trim())); }`,
    "catch (err) { console.log('RESULT ' + JSON.stringify(err.code + '/' + err.errno)); }",
  ].join('\n');
  const run = runInJobSync({
    command: NODE, args: ['-e', script], cwd,
    env: { LOCALAPPDATA: process.env.LOCALAPPDATA, SystemRoot: process.env.SystemRoot },
    outputBytes: 65_536, timeoutMs: 60_000, container: SID.sid,
  });
  assert.equal(run.status, 'ok', `the run failed: ${JSON.stringify(run.limits_refused)}`);
  const line = String(run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line: ${JSON.stringify(run.stdout)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

// ── Unit shape: the scan, without a container ────────────────────────────────

test('scanForHardLinks finds a link and passes ordinary content', () => {
  const base = join(ROOT, 'scan');
  mkdirSync(join(base, '.tmp'), { recursive: true });
  writeFileSync(join(base, 'normal.txt'), 'NORMAL');
  writeFileSync(join(base, '.tmp', 'scratch.txt'), 'SCRATCH');

  assert.deepEqual(scanForHardLinks(base), []);

  const target = join(base, 'target.txt');
  writeFileSync(target, 'TARGET');
  linkSync(target, join(base, 'hard.txt'));
  const found = scanForHardLinks(base);
  assert.equal(found.length, 2, `both names of the linked file are findings: ${JSON.stringify(found)}`);
  assert.ok(found.every((f) => f.nlink === 2 && f.ino === found[0].ino),
    `both names share one file ID and count: ${JSON.stringify(found)}`);
});

test('scanForHardLinks reports a directory it cannot list instead of skipping it', () => {
  // The same icacls-deny idiom the path-shapes suite uses, aimed at a
  // subdirectory: deny (RX) takes away FILE_LIST_DIRECTORY, readdir turns into
  // EPERM/-4048, and the scan must surface that instead of walking past it.
  // (A deny on a FILE cannot do this — lstat stats through the parent and
  // reports the true link count even on a file the reader cannot open.)
  const base = join(ROOT, 'scan-error');
  const sub = join(base, 'sub');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'x.txt'), 'X');
  const denied = spawnSync('icacls', [sub, '/deny', `${OWNER}:(RX)`], { encoding: 'utf8' });
  assert.equal(denied.status, 0, `could not deny the listing: ${denied.stdout}${denied.stderr}`);
  try {
    const findings = scanForHardLinks(base);
    assert.equal(findings.length, 1, `the unlistable directory is a finding: ${JSON.stringify(findings)}`);
    assert.equal(findings[0].path, sub);
    assert.ok(findings[0].error, 'the finding carries why the path could not be read');
  } finally {
    spawnSync('icacls', [sub, '/remove:d', OWNER], { encoding: 'utf8' });
  }
});

test('stripContainerAce detaches inheritance first, then removes the ACE, through the injected runner', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return { status: 0, out: 'Successfully processed 1 files' }; };
  const done = stripContainerAce('C:\\ws\\hard.txt', 'S-1-15-2-test', { run });
  assert.deepEqual(calls, [
    ['C:\\ws\\hard.txt', '/inheritance:d'],
    ['C:\\ws\\hard.txt', '/remove', '*S-1-15-2-test'],
  ]);
  assert.equal(done.removed, true);

  calls.length = 0;
  const stuck = stripContainerAce('C:\\ws\\hard.txt', 'S-1-15-2-test', {
    run: (args) => (args.includes('/inheritance:d')
      ? { status: 5, out: 'Access is denied.' }
      : { status: 0, out: 'ok' }),
  });
  assert.equal(stuck.removed, false, 'a failed detach must not be reported as removed');
  assert.match(stuck.detail, /\/inheritance:d failed/);
});

test('enforceLinkIsolation refuses before the grant and never grants', () => {
  const grants = [];
  assert.throws(() => enforceLinkIsolation({
    dir: 'D', sid: 'S-1-15-2-test',
    grant: () => grants.push('ran'),
    scan: () => [{ path: 'D\\hard.txt', ino: 7, nlink: 2 }],
  }), (err) => err instanceof LinkIsolationError
    && err.code === PRE_GRANT
    && err.findings.length === 1);
  assert.deepEqual(grants, [], 'the grant must not have run');
});

test('enforceLinkIsolation passes a grant failure through when nothing landed', () => {
  const original = new Error('icacls exploded');
  let thrown = null;
  try {
    enforceLinkIsolation({
      dir: 'D', sid: 'S-1-15-2-test',
      grant: () => { throw original; },
      scan: (dir) => [],
    });
  } catch (err) { thrown = err; }
  // The caller's error contract is the callback's own error object: a thrown
  // message string would slip past every `instanceof WorkspaceError` check
  // upstream (regression measured 2026-11-14 when the caught error was
  // narrowed to its message for the grant_error detail).
  assert.ok(thrown === original, `the original grant error must pass through untouched, got ${thrown}`);
});

test('enforceLinkIsolation cleans up and refuses when a link appears during the grant', () => {
  const removals = [];
  let scans = 0;
  assert.throws(() => enforceLinkIsolation({
    dir: 'D', sid: 'S-1-15-2-test',
    grant: () => { /* the race: the link lands while the grant runs */ },
    scan: () => (++scans === 1 ? [] : [{ path: 'D\\hard.txt', ino: 9, nlink: 2 }]),
    removeAce: (path, sid) => { removals.push([path, sid]); return { attempted: true, removed: true, detail: '' }; },
  }), (err) => err instanceof LinkIsolationError
    && err.code === GRANT_ESCAPED
    && err.cleanup.length === 1
    && err.cleanup[0].removed === true);
  assert.deepEqual(removals, [['D\\hard.txt', 'S-1-15-2-test']]);
});

// ── Contained: the gate against the real grant ───────────────────────────────

test('AT-V3-HL-06 createWorkspace refuses a workspace that already holds a hard link, and the outside object stays untouched', { skip }, () => {
  const base = join(ROOT, 'hl-06');
  const outside = join(base, 'outside');
  const dir = join(base, 'ws');
  mkdirSync(outside, { recursive: true });
  mkdirSync(dir);
  protect(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'CANARY-HL-06\n');
  linkSync(secret, join(dir, 'hard.txt'));

  const ws = createWorkspace({ root: base, task_id: 'ws', container: SID.sid });
  assert.throws(() => ws.create(), (err) => err.code === PRE_GRANT,
    'the gate must refuse before the grant runs');

  assert.equal(carriesContainerAce(secret), false,
    'no ACE may land on the outside object when the grant is refused');
  assert.equal(readContained(secret, dir), 'EPERM/-4048',
    'and the container still cannot read it');
});

test('AT-V3-HL-07 a link planted during the grant is detected, its ACE removed, and the run refused', { skip }, () => {
  const base = join(ROOT, 'hl-07');
  const outside = join(base, 'outside');
  const dir = join(base, 'ws');
  mkdirSync(outside, { recursive: true });
  mkdirSync(dir);
  protect(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'CANARY-HL-07\n');

  // The E3 race, replayed deterministically: the link is planted inside the
  // grant callback, between the pre-scan and the propagation walk, which is
  // exactly where the directory watcher planted it 20 times out of 20.
  assert.throws(() => enforceLinkIsolation({
    dir, sid: SID.sid,
    grant: () => {
      linkSync(secret, join(dir, 'race.txt'));
      grant(dir);
    },
  }), (err) => err instanceof LinkIsolationError && err.code === GRANT_ESCAPED,
  'the post-grant scan must catch the link the race planted');

  assert.equal(carriesContainerAce(secret), false,
    'the cleanup must have taken the container ACE back off the outside object');
  assert.ok(spawnSync('icacls', [secret], { encoding: 'utf8' }).stdout.includes(OWNER),
    'the cleanup must not have replaced the rest of the outside object ACL');
  assert.equal(readContained(secret, dir), 'EPERM/-4048',
    'and the boundary must be closed again');
});

test('AT-V3-HL-08 ordinary workspace content grants normally under the gate', { skip }, () => {
  const base = join(ROOT, 'hl-08');
  const ws = createWorkspace({ root: base, task_id: 'ws', container: SID.sid });
  const dir = ws.create();
  assert.equal(carriesContainerAce(dir), true, 'the grant ran');
  assert.equal(readContained(join(dir, 'missing.txt'), dir), 'ENOENT/-4058',
    'the container runs in the granted workspace, so the gate did not break it');
});
