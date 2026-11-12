/**
 * What a second name for a file does to the boundary.
 *
 * A hard link is not a path trick: it is another name for one file, and the file
 * carries one security descriptor. A link therefore does not move an object into a
 * directory that was granted -- the grant is on the directory, and the object the
 * link names still carries its own descriptor with its own refusal.
 *
 * Two readings of a refusal are worth telling apart, because both are correct and
 * they mean different things:
 *
 *   EPERM  - the path resolved and the object refused. The boundary is the file's
 *            own ACL.
 *   ENOENT - the path did not resolve, because a directory on the way was not
 *            granted. The object was never reached, so nothing about the object
 *            was tested.
 *
 * The fourth test here is the one that changed a conclusion. A link inside a
 * granted directory is enough for a later `icacls <workspace> /grant *(OI)(CI)M`
 * to write an inheritable ACE **onto the object the link names**, in a directory
 * nobody granted. That is not a read bypass -- the ACE is for the container, and
 * the file still carries it wherever it is opened from -- but it is a write into
 * the ACL of a file outside the workspace, and it is not what "the grant is on the
 * directory" predicts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { containerSid, runInJob } from '../../src/exec/job.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-path-test-'));
// The ungranted directories inside have inheritance stripped, so they carry no ACE
// for this process and the tree cannot simply be deleted. Give it back first:
// cleanup that fails leaves a red suite behind for the wrong reason.
after(() => {
  spawnSync('icacls', [ROOT, '/reset', '/T', '/C', '/Q'], { encoding: 'utf8' });
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const NODE = process.execPath;
const SID = containerSid();
const skip = SID.ok ? false : SID.detail;
const OWNER = process.env.USERDOMAIN + '\\' + process.env.USERNAME;

/**
 * An outer directory the container can traverse, holding one directory it may read
 * and one it may not.
 *
 * The ungranted directory must have inheritance stripped, because the workspace
 * grant is `(OI)(CI)` and would otherwise flow into it -- and `%TEMP%` cannot be
 * used at all for this: it inherits `CodexSandboxUsers:(RX)` on this machine, so an
 * object there is readable by the container and a "denied" assertion would fail for
 * that reason rather than because the boundary was wrong.
 */
function scratch(name) {
  const base = join(ROOT, name);
  const ws = join(base, 'ws');
  const denied = join(ws, 'denied');
  mkdirSync(denied, { recursive: true });
  const stripped = spawnSync('icacls', [denied, '/inheritance:r', '/grant:r', `${OWNER}:(OI)(CI)F`],
    { encoding: 'utf8' });
  assert.equal(stripped.status, 0, `could not strip inheritance: ${stripped.stdout}${stripped.stderr}`);
  return { base, ws, denied };
}

function grant(dir, sid = SID.sid) {
  const done = spawnSync('icacls', [dir, '/grant', `*${sid}:(OI)(CI)M`], { encoding: 'utf8' });
  assert.equal(done.status, 0, `grant failed for ${dir}: ${done.stdout}${done.stderr}`);
}

function mklink(kind, link, target) {
  return spawnSync('cmd', ['/c', 'mklink', kind, link, target], { encoding: 'utf8' });
}

function carriesContainerAce(path) {
  return spawnSync('icacls', [path], { encoding: 'utf8' }).stdout
    .toLowerCase().includes(SID.sid.toLowerCase());
}

/** A read attempted inside the container, reported with its exact code. */
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

test('AT-V3-HL-01 an object outside the granted directory refuses while nothing in the workspace names it', { skip }, async () => {
  const { ws, denied } = scratch('hl-01');
  const hidden = join(denied, 'hidden.txt');
  writeFileSync(hidden, 'DENIED-MARKER');
  writeFileSync(join(ws, 'granted.txt'), 'GRANTED-MARKER');
  grant(ws);

  const seen = readResult(await runContained(readProbe({
    granted: join(ws, 'granted.txt'),
    denied_direct: hidden,
  }), ws));

  // The control: a file in the granted directory reads, so the refusal below is
  // the boundary and not a container that cannot read anything.
  assert.match(seen.granted, /^READ:GRANTED-MARKER$/, 'the granted file must read');
  assert.match(seen.denied_direct, /^(EPERM|ENOENT)\//,
    `an object outside the granted directory must refuse, saw ${seen.denied_direct}`);
  assert.equal(carriesContainerAce(hidden), false,
    'and the grant must not have written an ACE onto it');
});

test('AT-V3-HL-05 DEFECT: a link inside the granted directory lands the inherited ACE on the object it names, which then reads', { skip }, async () => {
  // The finding. A link inside the workspace is enough for `icacls <ws>
  // /grant *(OI)(CI)M` to write the container's ACE onto the object the link names,
  // in a directory that is protected from inheritance and was never granted. Once
  // the ACE is there the container reads the object -- directly, by its own path,
  // not only through the link.
  //
  // This test asserts the behaviour that exists so the defect cannot regress
  // silently into a claim. It is not an endorsement: the correct boundary is the
  // one the other tests describe, and the mechanism is recorded in
  // docs/research/v3-read-isolation/appcontainer-feasibility.md.
  const { ws, denied } = scratch('hl-05');
  const hidden = join(denied, 'hidden.txt');
  const link = join(ws, 'link.txt');
  writeFileSync(hidden, 'DENIED-MARKER');
  writeFileSync(join(ws, 'granted.txt'), 'GRANTED-MARKER');
  assert.equal(mklink('/H', link, hidden).status, 0);
  assert.equal(carriesContainerAce(hidden), false, 'before the grant, the object is untouched');

  grant(ws);

  assert.equal(carriesContainerAce(hidden), true,
    'the grant lands on the object the link names');
  assert.equal(carriesContainerAce(link), true, 'and the link reports it, being the same file');

  const seen = readResult(await runContained(readProbe({
    granted: join(ws, 'granted.txt'),
    denied_direct: hidden,
    denied_via_link: link,
  }), ws));
  assert.match(seen.granted, /^READ:GRANTED-MARKER$/);
  assert.equal(seen.denied_direct, 'READ:DENIED-MARKER',
    'the object reads by its own path, so the boundary followed the link rather than the directory');
  assert.equal(seen.denied_via_link, 'READ:DENIED-MARKER');
});

test('AT-V3-HL-02 a link to an object the container already holds stays reachable, so a grant is not path-shaped', { skip }, async () => {
  const { ws } = scratch('hl-02');
  const readable = join(ws, 'readable.txt');
  const shared = join(ws, 'shared.txt');
  writeFileSync(readable, 'GRANTED-MARKER');
  assert.equal(mklink('/H', shared, readable).status, 0);
  grant(ws);

  const seen = readResult(await runContained(readProbe({ readable, shared }), ws));

  // Both names reach one object in the granted directory, so both read. A boundary
  // that refused the link would be refusing the object, which would make the grant
  // a list of names rather than a permission.
  assert.match(seen.readable, /^READ:GRANTED-MARKER$/);
  assert.match(seen.shared, /^READ:GRANTED-MARKER$/,
    'a second name for a granted object is still the granted object');
});

test('AT-V3-HL-03 a link and its target are one file with one record, measured', async () => {
  const { ws } = scratch('hl-03');
  const target = join(ws, 'target.txt');
  const link = join(ws, 'link.txt');
  const other = join(ws, 'other.txt');
  writeFileSync(target, 'TARGET');
  writeFileSync(other, 'OTHER');
  assert.equal(mklink('/H', link, target).status, 0);

  // Identity is a fact about the file, and it is the only evidence that says two
  // names are one object: ino is the file index, dev the volume, nlink the number
  // of names that reach it.
  const a = statSync(target);
  const b = statSync(link);
  const c = statSync(other);
  assert.equal(a.ino, b.ino, 'the link and its target are one file');
  assert.equal(a.dev, b.dev, 'and it is one volume');
  assert.equal(b.nlink, 2, 'two names reach it');
  assert.notEqual(a.ino, c.ino, 'a neighbouring file is a different file');
  assert.equal(c.nlink, 1, 'with one name');

  // One record, not two that agree. An attribute lives in the file record, in the
  // same place the security descriptor does, so a change made through one name is
  // visible through the other while a neighbouring file is untouched.
  const beforeOther = statSync(other).mode;
  chmodSync(target, 0o444);
  assert.equal(statSync(target).mode & constants.S_IWUSR, 0, 'the target became read-only');
  assert.equal(statSync(link).mode & constants.S_IWUSR, 0, 'and the link reports it');
  assert.equal(statSync(other).mode, beforeOther, 'a neighbouring file is untouched');

  // What this cannot show, and why tools/experiments/hardlink-containment-probe.py
  // exists: a security descriptor is in that same record, and the probe changes one
  // through a name and reads the changed bytes back through the other.
});

test('AT-V3-HL-04 a contained tool cannot create a link to an object it cannot read', { skip }, async () => {
  const { ws, denied } = scratch('hl-04');
  const hidden = join(denied, 'hidden.txt');
  writeFileSync(hidden, 'DENIED-MARKER');
  writeFileSync(join(ws, 'granted.txt'), 'GRANTED-MARKER');
  grant(ws);

  const script = [
    "const fs = require('node:fs');",
    `for (const target of [${JSON.stringify(hidden)}, ${JSON.stringify(join(ws, 'granted.txt'))}]) {`,
    "  const name = 'planted-' + target.split(/[\\\\/]/).pop();",
    '  try { fs.linkSync(target, name); console.log(`LINK-CREATED ${name}`); }',
    '  catch (err) { console.log(`LINK-REFUSED ${name} ${err.code}/${err.errno}`); }',
    '}',
  ].join('\n');
  const result = await runContained(script, ws);
  assert.equal(result.status, 'ok');

  // Linking to an object it may not read is refused, and the refusal comes from
  // the object rather than from a check the runner performs.
  assert.match(result.stdout, /LINK-REFUSED planted-hidden\.txt (EPERM|ENOENT)\//,
    `a tool must not be able to name an object it cannot read: ${result.stdout}`);
  assert.ok(!existsSync(join(ws, 'planted-hidden.txt')), 'and no link may remain');
  // The positive control: linking to an object it does hold succeeds, so the
  // refusal above is about the target and not about link creation being impossible
  // inside the container.
  assert.match(result.stdout, /LINK-CREATED planted-granted\.txt/,
    `link creation itself must work: ${result.stdout}`);
});
