/**
 * Lain verification orchestrator.
 *
 *   npm run check    — every check, with the secret-scan gate in advisory mode
 *   npm run verify   — every check, with the secret-scan gate REQUIRED (fails
 *                      closed when the scanner is unavailable)
 *   npm run check:self — runs each check against a deliberately broken input
 *                      and fails unless the check detects it
 *
 * Checks run as child processes, one at a time: a check that shares a process
 * with another cannot prove where a failure came from, and several of these
 * checks measure process-level behaviour (exit codes, subprocesses).
 *
 * Exit code: 0 only when no check reported `fail`, and `skip` is never counted
 * as a pass in the summary.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * @typedef {object} CheckSpec
 * @property {string} name
 * @property {string} file
 * @property {string[]} [extraArgs]
 * @property {boolean} [security]
 */

/** @type {CheckSpec[]} */
const CHECKS = [
  { name: 'runtime', file: 'check/runtime.mjs' },
  { name: 'layout', file: 'check/layout.mjs' },
  { name: 'format', file: 'check/format.mjs' },
  { name: 'types', file: 'check/types.mjs' },
  { name: 'tests', file: 'check/tests.mjs' },
  { name: 'store-boundary', file: 'check/store-boundary.mjs' },
  { name: 'repo-hygiene', file: 'check/repo-hygiene.mjs' },
  { name: 'secrets', file: 'check/secrets.mjs', security: true },
];

const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const requireSecurity = argv.includes('--require-security') || process.env.LAIN_REQUIRE_SECURITY === '1';
const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/**
 * @param {CheckSpec} spec
 * @returns {{ name: string, status: string, ms: number, output: string, exitCode: number }}
 */
function runOne(spec) {
  const args = [join(here, spec.file)];
  if (selfTest) args.push('--self-test');
  if (spec.security && requireSecurity) args.push('--require-security');

  const started = Date.now();
  const proc = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const ms = Date.now() - started;
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const statusLine = output.match(/^\[(PASS|FAIL|SKIP|NOT-TESTABLE)\] /m);
  /** @type {string} */
  let status;
  if (statusLine?.[1]) status = statusLine[1];
  else if (proc.status === 0) status = 'PASS';
  else status = 'FAIL';
  return { name: spec.name, status, ms, output, exitCode: proc.status ?? -1 };
}

const results = [];
process.stdout.write(`lain verify${selfTest ? ' (self-test mode: each check must detect a deliberate violation)' : ''}\n`);
process.stdout.write(`node ${process.versions.node} · cwd ${process.cwd()}\n`);
process.stdout.write(`${'-'.repeat(72)}\n`);

for (const spec of CHECKS) {
  if (only && spec.name !== only) continue;
  const r = runOne(spec);
  results.push(r);
  process.stdout.write(r.output.endsWith('\n') ? r.output : `${r.output}\n`);
}

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIP' || r.status === 'NOT-TESTABLE');
const passed = results.filter((r) => r.status === 'PASS');

process.stdout.write(`${'-'.repeat(72)}\n`);
process.stdout.write(
  `SUMMARY  checks=${results.length}  pass=${passed.length}  fail=${failed.length}  ` +
    `skipped_or_untestable=${skipped.length}\n`,
);
if (skipped.length > 0) {
  process.stdout.write(`         not verified: ${skipped.map((r) => `${r.name}(${r.status})`).join(', ')}\n`);
}
if (failed.length > 0) {
  process.stdout.write(`         FAILED: ${failed.map((r) => r.name).join(', ')}\n`);
}
if (requireSecurity) process.stdout.write('         security gate: REQUIRED\n');

const evidenceDir = join(process.cwd(), 'artifacts', 'verify');
await mkdir(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidencePath = join(evidenceDir, `${selfTest ? 'self-test' : 'check'}-${stamp}.log`);
const header = [
  `mode: ${selfTest ? 'self-test' : requireSecurity ? 'verify (security required)' : 'check'}`,
  `node: ${process.versions.node}`,
  `cwd: ${process.cwd()}`,
  `when: ${new Date().toISOString()}`,
  `result: pass=${passed.length} fail=${failed.length} skipped=${skipped.length}`,
  '',
].join('\n');
await writeFile(evidencePath, `${header}${results.map((r) => r.output).join('\n')}\n`, 'utf8');
process.stdout.write(`         evidence: artifacts/verify/${evidencePath.split(/[\\/]/).pop()}\n`);

process.exit(failed.length === 0 ? 0 : 1);
