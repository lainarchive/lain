/**
 * The filesystem matrix the brief asks for, measured rather than assumed.
 *
 * Builds one scratch tree as the unconfined parent - a granted workspace plus a
 * secret directory that is not granted - then plants inside the workspace every
 * shape that could reach the secret: a traversal, an absolute path, a hard link,
 * a junction, a symlink, an alternate data stream, a case variant, a path handed
 * over through an environment variable, and a write. One containerised run tries
 * all of them, so every answer comes from the same process as the control.
 *
 * A shape that is NOT prevented is a result. It is printed as one.
 *
 *   node tools/experiments/appcontainer-filesystem-matrix.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_HELPER, DEFAULT_PYTHON, buildHelperSpec } from '../../src/exec/job.mjs';

const TOOL = `
const fs = require('node:fs');
const ws = process.argv[1];
const base = process.argv[2];
const rows = [];
function read(label, path) {
  try { rows.push(label + '=READ:' + fs.readFileSync(path, 'utf8').trim()); }
  catch (e) { rows.push(label + '=' + e.code + '/' + e.errno); }
}
function write(label, path) {
  try { fs.writeFileSync(path, 'ESCAPED'); rows.push(label + '=WROTE'); }
  catch (e) { rows.push(label + '=' + e.code + '/' + e.errno); }
}
read('granted', ws + '\\\\plain.txt');
read('traversal', ws + '\\\\..\\\\secret\\\\secret.txt');
read('absolute', base + '\\\\secret\\\\secret.txt');
read('hardlink', ws + '\\\\hard.txt');
read('junction', ws + '\\\\junction\\\\secret.txt');
read('symlink', ws + '\\\\symlink.txt');
read('ads_outside', base + '\\\\secret\\\\secret.txt:ads');
read('ads_granted', ws + '\\\\plain.txt:ads');
read('case_upper', (base + '\\\\secret\\\\secret.txt').toUpperCase());
read('env_escape', process.env.ESCAPE || 'no-escape-set');
write('write_outside', base + '\\\\secret\\\\planted.txt');
console.log('MATRIX-MARKER');
console.log(rows.join(' | '));
`;

/** @param {string} dir @param {string} sid */
function grant(dir, sid) {
  return spawnSync('icacls', [dir, '/grant', `*${sid}:(OI)(CI)M`], { encoding: 'utf8', windowsHide: true });
}

/** @param {string[]} args */
function mklink(args) {
  return spawnSync('cmd', ['/c', 'mklink', ...args], { encoding: 'utf8', windowsHide: true });
}

const sid = spawnSync(DEFAULT_PYTHON, [DEFAULT_HELPER, '--print-container-sid'],
  { encoding: 'utf8', windowsHide: true }).stdout.trim();
const base = mkdtempSync(join(tmpdir(), 'lain-fsmatrix-'));
const ws = join(base, 'ws');
const secret = join(base, 'secret');
mkdirSync(ws, { recursive: true });
mkdirSync(secret, { recursive: true });

writeFileSync(join(secret, 'secret.txt'), 'SECRET-MARKER');
writeFileSync(join(ws, 'plain.txt'), 'GRANTED-MARKER');
writeFileSync(join(secret, 'secret.txt') + ':ads', 'ADS-MARKER');
writeFileSync(join(ws, 'plain.txt') + ':ads', 'ADS-GRANTED');
grant(ws, sid);

const planted = {
  hardlink: mklink(['/H', join(ws, 'hard.txt'), join(secret, 'secret.txt')]).status,
  junction: mklink(['/J', join(ws, 'junction'), secret]).status,
  symlink: mklink([join(ws, 'symlink.txt'), join(secret, 'secret.txt')]).status,
};

const spec = {
  command: process.execPath,
  args: ['-e', TOOL, ws, base],
  cwd: ws,
  outputBytes: 65_536,
  supervisorMs: 30_000,
  expect_marker: 'MATRIX-MARKER',
  container: 'lain.tool.runner',
  env: {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    COMSPEC: process.env.COMSPEC ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
    TEMP: ws,
    TMP: ws,
    LAIN_WORKSPACE: ws,
    LOCALAPPDATA: join(ws, '.localappdata'),
    ESCAPE: join(secret, 'secret.txt'),
  },
  limits: { job_ms: 30_000 },
};

const specPath = join(base, 'spec.json');
const resultPath = join(base, 'result.json');
writeFileSync(specPath, JSON.stringify(buildHelperSpec(spec, 30_000), null, 2));
spawnSync(DEFAULT_PYTHON, [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
  { encoding: 'utf8', windowsHide: true });

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
console.log(`container sid ${sid}`);
console.log(`planted: ${JSON.stringify(planted)} (0 = created)`);
console.log(`run: ok=${result.ok} exit=${result.exit_code} fatal=${result.fatal ?? ''}`);
console.log(`stdout: ${JSON.stringify((result.stdout ?? '').trim())}`);
console.log(`stderr: ${JSON.stringify((result.stderr ?? '').slice(0, 300))}`);
if (!(result.stdout ?? '').includes('MATRIX-MARKER')) {
  console.log('MARKER MISSING: this run says nothing about the matrix');
}
console.log(`planted file exists after the run: ${spawnSync('cmd',
  ['/c', 'if', 'exist', join(secret, 'planted.txt'), 'echo', 'PLANTED'], { encoding: 'utf8' }).stdout.trim()}`);
console.log(`base: ${base}`);
