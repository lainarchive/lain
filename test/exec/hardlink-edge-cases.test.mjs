/**
 * The V-3.2 edge cases around the hard-link work: the shapes the V-3.1
 * investigation named as untested, each measured before it was defended
 * (P1–P5 in docs/research/v3-read-isolation/hardlink-investigation.md).
 *
 * Three of them closed without needing new defense: UNC and \\?\GLOBALROOT
 * link targets are refused at creation for the user and the container alike,
 * a junction planted before the grant carries no ACE onto its target and
 * cannot be read through, and a file held open with FILE_SHARE_NONE neither
 * hides its link count from lstat nor blocks the DACL rewrite the cleanup
 * performs. What did need defense is the window after the grant: a link
 * planted there lands no ACE, but it is a second name for an outside object
 * in a directory the container can write, and the run refuses on the broken
 * invariant — checkWorkspaceContainment, wired into the task runner.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { containerSid, runInJob } from '../../src/exec/job.mjs';
import { createWorkspace } from '../../src/exec/workspace.mjs';
import { checkWorkspaceContainment, inspectContainment } from '../../src/exec/boundary.mjs';
import {
  PRE_GRANT, scanForHardLinks, stripContainerAce,
} from '../../src/exec/hardlink-defect-remediation.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-hl-edge-'));
// The trees inside strip inheritance, so they carry no ACE for this process and
// rmSync alone cannot take them back. Give it back first: cleanup that fails
// leaves a red suite behind for the wrong reason.
after(() => {
  spawnSync('icacls', [ROOT, '/reset', '/T', '/C', '/Q'], { encoding: 'utf8' });
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const NODE = process.execPath;
const SID = containerSid();
const skip = SID.ok ? false : SID.detail;
const OWNER = process.env.USERDOMAIN + '\\' + process.env.USERNAME;

function protect(dir) {
  const done = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${OWNER}:(OI)(CI)F`], { encoding: 'utf8' });
  assert.equal(done.status, 0, `could not strip inheritance on ${dir}: ${done.stdout}${done.stderr}`);
}

function grant(dir, sid = SID.sid) {
  const done = spawnSync('icacls', [dir, '/grant', `*${sid}:(OI)(CI)M`], { encoding: 'utf8' });
  assert.equal(done.status, 0, `grant failed for ${dir}: ${done.stdout}${done.stderr}`);
}

function carriesContainerAce(path) {
  return spawnSync('icacls', [path], { encoding: 'utf8' }).stdout
    .toLowerCase().includes(SID.sid.toLowerCase());
}

/** The \\localhost\<drive>$ form of a local absolute path. */
function toUNC(path) {
  return path.replace(/^([A-Za-z]):/, (_, drive) => `\\\\localhost\\${drive.toLowerCase()}$`);
}

/** The \\?\UNC\ device form of the same path. */
function toUNCDevice(path) {
  return `\\\\?\\UNC\\${toUNC(path).slice(2)}`;
}

function readProbe(files) {
  const pairs = Object.entries(files)
    .map(([name, path]) => `  ${JSON.stringify(name)}: ${JSON.stringify(path)},`)
    .join('\n');
  return [
    "const fs = require('node:fs');",
    `const files = {\n${pairs}\n};`,
    'const out = {};',
    'for (const [name, file] of Object.entries(files)) {',
    '  try { out[name] = `READ:${fs.readFileSync(file, "utf8").trim()}`; }',
    '  catch (err) { out[name] = `${err.code}/${err.errno}`; }',
    '}',
    'console.log(`RESULT ${JSON.stringify(out)}`);',
  ].join('\n');
}

async function runContained(script, cwd) {
  return runInJob({
    command: NODE,
    args: ['-e', script],
    cwd,
    env: { LOCALAPPDATA: process.env.LOCALAPPDATA, SystemRoot: process.env.SystemRoot },
    outputBytes: 65_536,
    timeoutMs: 60_000,
    container: SID.sid,
  });
}

function readResult(result) {
  assert.equal(result.status, 'ok', `the run failed: ${JSON.stringify(result.limits_refused)}`);
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line in stdout: ${JSON.stringify(result.stdout)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

// ── UNC and device-path link targets ─────────────────────────────────────────

test('AT-V3-HL-09 UNC and \\\\?\\GLOBALROOT link targets are refused at creation', () => {
  const base = join(ROOT, 'hl-09');
  const outside = join(base, 'outside');
  const ws = join(base, 'ws');
  mkdirSync(outside, { recursive: true });
  mkdirSync(ws);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'HL09-CANARY');

  // The control: the same call with a local target creates the link, so a
  // refusal below is the target's shape and not a broken probe.
  const local = join(ws, 'local.txt');
  linkSync(secret, local);
  assert.equal(lstatSync(local).nlink, 2, 'the local control link must exist');
  unlinkSync(local);

  const attempts = {
    unc_share: [join(ws, 'unc.txt'), toUNC(secret)],
    unc_device: [join(ws, 'uncd.txt'), toUNCDevice(secret)],
    globalroot: [join(ws, 'gr.txt'), '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Windows\\win.ini'],
  };
  for (const [name, [link, target]] of Object.entries(attempts)) {
    let refused = null;
    try {
      linkSync(target, link);
    } catch (err) {
      refused = `${err.code}/${err.errno}`;
    }
    assert.ok(refused, `${name} must refuse, not create a link`);
    assert.equal(existsSync(link), false, `${name} must leave no link behind`);
  }
  assert.equal(lstatSync(secret).nlink, 1, 'no refused attempt may land a second name');
  assert.deepEqual(inspectContainment(ws).hardLinks, [],
    'and the workspace scans clean after the refusals');
});

// ── The containment walk separates hard links from reparse points ────────────

test('inspectContainment reports a hard-linked file without confusing it with a junction', () => {
  const base = join(ROOT, 'unit-walk');
  const outside = join(base, 'outside');
  const dir = join(base, 'task');
  mkdirSync(outside, { recursive: true });
  mkdirSync(dir);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'WALK-CANARY');
  writeFileSync(join(dir, 'ordinary.txt'), 'PLAIN');
  linkSync(secret, join(dir, 'hard.txt'));
  symlinkSync(outside, join(dir, 'junc'), 'junction');

  const seen = inspectContainment(dir);
  assert.deepEqual(seen.hardLinks, [join(dir, 'hard.txt')],
    'the hard link is the one file carrying a second name');
  assert.ok(seen.links.includes(join(dir, 'junc')), 'the junction is a link');
  assert.ok(seen.escaped.includes(join(dir, 'junc')), 'and it escapes');
  assert.ok(!seen.hardLinks.includes(join(dir, 'ordinary.txt')), 'ordinary content stays out');
});

test('checkWorkspaceContainment refuses a hard link, a junction, and passes clean content', () => {
  const root = join(ROOT, 'unit-cwc');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'CWC-CANARY');

  mkdirSync(join(root, 't-clean'));
  writeFileSync(join(root, 't-clean', 'file.txt'), 'PLAIN');
  const clean = checkWorkspaceContainment({ workspaceRoot: root, taskId: 't-clean' });
  assert.equal(clean.ok, true, 'clean content is contained');
  assert.equal(clean.code, 'WORKSPACE_CONTAINED');

  mkdirSync(join(root, 't-link'));
  linkSync(secret, join(root, 't-link', 'hard.txt'));
  const linked = checkWorkspaceContainment({ workspaceRoot: root, taskId: 't-link' });
  assert.equal(linked.ok, false, 'a hard link breaks the fresh-workspace invariant');
  assert.equal(linked.code, 'WORKSPACE_HARD_LINK_PRESENT');

  mkdirSync(join(root, 't-junc'));
  symlinkSync(outside, join(root, 't-junc', 'junc'), 'junction');
  const junction = checkWorkspaceContainment({ workspaceRoot: root, taskId: 't-junc' });
  assert.equal(junction.ok, false, 'a junction resolving outside is an escape');
  assert.equal(junction.code, 'WORKSPACE_LINK_ESCAPES');
});

// ── Contained: the same shapes against the real container ────────────────────

test('AT-V3-HL-10 the container cannot link to UNC or device paths either', { skip }, async () => {
  const base = join(ROOT, 'hl-10');
  const outside = join(base, 'outside');
  const ws = join(base, 'ws');
  mkdirSync(outside, { recursive: true });
  mkdirSync(ws);
  protect(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'HL10-CANARY');
  grant(ws);
  writeFileSync(join(ws, 'marker.txt'), 'HL10-LOCAL');

  const script = [
    "const fs = require('node:fs');",
    `const pairs = {
  unc_share: [${JSON.stringify(join(ws, 'c-unc.txt'))}, ${JSON.stringify(toUNC(secret))}],
  unc_device: [${JSON.stringify(join(ws, 'c-uncd.txt'))}, ${JSON.stringify(toUNCDevice(secret))}],
  globalroot: [${JSON.stringify(join(ws, 'c-gr.txt'))}, '\\\\\\\\?\\\\GLOBALROOT\\\\Device\\\\HarddiskVolume1\\\\Windows\\\\win.ini'],
  local_positive_control: [${JSON.stringify(join(ws, 'c-local.txt'))}, ${JSON.stringify(join(ws, 'marker.txt'))}],
};`,
    'const out = {};',
    'for (const [name, [link, target]] of Object.entries(pairs)) {',
    '  try { fs.linkSync(target, link); out[name] = "LINK-CREATED"; }',
    '  catch (err) { out[name] = `${err.code}/${err.errno}`; }',
    '}',
    'console.log(`RESULT ${JSON.stringify(out)}`);',
  ].join('\n');
  const seen = readResult(await runContained(script, ws));

  assert.equal(seen.local_positive_control, 'LINK-CREATED',
    'the control proves the container can link inside its own workspace');
  for (const name of ['unc_share', 'unc_device', 'globalroot']) {
    assert.notEqual(seen[name], 'LINK-CREATED', `${name} must refuse from inside the container (saw ${seen[name]})`);
    assert.equal(existsSync(join(ws, { unc_share: 'c-unc.txt', unc_device: 'c-uncd.txt', globalroot: 'c-gr.txt' }[name])),
      false, `${name} must leave no link behind`);
  }
  const reads = readResult(await runContained(readProbe({ secret_direct: secret }), ws));
  assert.match(reads.secret_direct, /^EPERM\//,
    'and nothing about the outside object became readable');
  assert.equal(carriesContainerAce(secret), false, 'no ACE may have landed on it');
});

test('AT-V3-HL-11 a junction planted before the grant propagates nothing and is refused at run time', { skip }, async () => {
  const base = join(ROOT, 'hl-11');
  const outside = join(base, 'outside');
  const root = join(base, 'root');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, 'ws'), { recursive: true });
  protect(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'HL11-CANARY');
  const junc = join(root, 'ws', 'junc');
  symlinkSync(outside, junc, 'junction');

  const ws = createWorkspace({ root, task_id: 'ws', container: SID.sid });
  // The grant-time gate scans for hard links; a junction is a reparse point,
  // not a second name, and the measured propagation crosses no junction — so
  // the grant itself proceeds and writes nothing onto the target tree.
  const dir = ws.create();
  assert.equal(carriesContainerAce(dir), true, 'the grant ran');
  assert.equal(carriesContainerAce(outside), false, 'no ACE may reach the junction target directory');
  assert.equal(carriesContainerAce(secret), false, 'and none may reach the file inside it');

  // What the container sees through the junction: nothing.
  const reads = readResult(await runContained(readProbe({
    via_junction: join(dir, 'junc', 'secret.txt'),
    secret_direct: secret,
  }), dir));
  assert.match(reads.via_junction, /^EPERM\//, `the junction must not become a read path (saw ${reads.via_junction})`);
  assert.match(reads.secret_direct, /^EPERM\//, 'the target refuses on its own ACL too');

  // The run-time boundary refuses the workspace outright: the junction
  // resolves outside it. Until V-3.2 this check existed but no caller passed
  // a task id, so the junction would have gone unrefused end to end.
  const containment = checkWorkspaceContainment({ workspaceRoot: root, taskId: 'ws' });
  assert.equal(containment.ok, false, 'the runner must refuse this workspace');
  assert.equal(containment.code, 'WORKSPACE_LINK_ESCAPES');
});

test('AT-V3-HL-12 a link planted after the grant lands no ACE and the run refuses on the invariant', { skip }, async () => {
  const base = join(ROOT, 'hl-12');
  const outside = join(base, 'outside');
  const root = join(base, 'root');
  mkdirSync(outside, { recursive: true });
  protect(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'HL12-CANARY');

  const ws = createWorkspace({ root, task_id: 'ws', container: SID.sid });
  const dir = ws.create();
  // The window this test is about: the grant has run, no tool has run yet.
  const late = join(dir, 'late.txt');
  linkSync(secret, late);

  assert.equal(carriesContainerAce(secret), false,
    'a link planted after the grant collects no ACE — the gate already ran');
  const reads = readResult(await runContained(readProbe({
    via_link: late,
    secret_direct: secret,
  }), dir));
  assert.match(reads.via_link, /^EPERM\//, `the link must not read (saw ${reads.via_link})`);
  assert.match(reads.secret_direct, /^EPERM\//, 'and the object refuses by its own name too');

  // Not exploitable today, refused anyway: a second name for an outside
  // object in a container-writable directory is a broken invariant, and the
  // next grant or mechanism that touches the workspace would light it up.
  const containment = checkWorkspaceContainment({ workspaceRoot: root, taskId: 'ws' });
  assert.equal(containment.ok, false, 'the runner must refuse the tampered workspace');
  assert.equal(containment.code, 'WORKSPACE_HARD_LINK_PRESENT');
});

test('AT-V3-HL-13 a locked outside file neither hides the link nor blocks the cleanup', { skip }, async () => {
  const base = join(ROOT, 'hl-13');
  const outside = join(base, 'outside');
  const root = join(base, 'root');
  mkdirSync(outside, { recursive: true });
  protect(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'HL13-CANARY');

  const lockScript = `$fs=[System.IO.File]::Open('${secret.replace(/'/g, "''")}','Open','Read','None'); Start-Sleep -Seconds 120; $fs.Close()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', lockScript], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Prove the lock is real: a second open of the file must fail.
    assert.throws(() => openSync(secret, 'r+'), 'the FILE_SHARE_NONE lock must hold');
    const link = join(root, 'ws', 'locked.txt');
    mkdirSync(join(root, 'ws'), { recursive: true });
    linkSync(secret, link);

    // The scan sees the link count through the lock, because lstat reads
    // through the parent directory and never opens the file.
    assert.equal(lstatSync(link).nlink, 2, 'lstat must see the true link count under the lock');
    const findings = scanForHardLinks(join(root, 'ws'));
    assert.equal(findings.length, 1, 'the gate scan must report the link');

    const ws = createWorkspace({ root, task_id: 'ws', container: SID.sid });
    assert.throws(() => ws.create(), (err) => err.code === PRE_GRANT,
      'the gate refuses with the file locked, exactly as it does without one');
    assert.equal(carriesContainerAce(secret), false, 'and the grant never ran, so no ACE moved');

    // The cleanup half, now with a real ACE to remove and the lock still held:
    // grant the outside object directly, then strip it through the link. The
    // DACL rewrite is the operation a sharing violation could have blocked,
    // and the measured answer is that it does not block.
    const direct = spawnSync('icacls', [secret, '/grant', `*${SID.sid}:(M)`], { encoding: 'utf8' });
    assert.equal(direct.status, 0, `direct grant failed: ${direct.stdout}${direct.stderr}`);
    assert.equal(carriesContainerAce(secret), true, 'the ACE is on the outside object');
    const strip = stripContainerAce(link, SID.sid);
    assert.equal(strip.removed, true, `the strip must work under the lock: ${strip.detail}`);
    assert.equal(carriesContainerAce(secret), false, 'and the ACE is gone');
  } finally {
    holder.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
