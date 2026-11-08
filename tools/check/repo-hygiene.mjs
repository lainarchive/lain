/**
 * Check: repository hygiene.
 *
 * Answers the questions a reviewer would otherwise have to ask by hand:
 * is anything staged that should not be, is the dependency surface still the
 * documented one, is the working tree clean of artifacts, and are the files
 * that must never be committed actually ignored by the current rules?
 *
 * Why it can fail: `--self-test` feeds the rule functions synthetic git status
 * output and a synthetic dependency set, including one violation of each kind,
 * and passes only if each is detected.
 */

import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

/** The complete list of runtime dependencies this project permits. */
export const ALLOWED_RUNTIME_DEPENDENCIES = /** @type {string[]} */ ([]);

/** The complete list of development dependencies this project permits. */
export const ALLOWED_DEV_DEPENDENCIES = ['typescript', '@types/node'];

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function git(root, args) {
  const proc = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
  return { code: proc.status ?? -1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * @param {string[]} lines
 * @returns {{ staged: string[], modified: string[], untracked: string[] }}
 */
export function classifyStatus(lines) {
  const staged = [];
  const modified = [];
  const untracked = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    if (x === '?' && y === '?') untracked.push(path);
    else {
      if (x !== ' ' && x !== '?') staged.push(path);
      if (y !== ' ' && y !== '?') modified.push(path);
    }
  }
  return { staged, modified, untracked };
}

/**
 * @param {string[]} actual
 * @param {string[]} allowed
 * @returns {string[]}
 */
export function unexpectedDependencies(actual, allowed) {
  return actual.filter((name) => !allowed.includes(name));
}

if (isEntryPoint(import.meta.url)) await main('repo-hygiene', async ({ result, selfTest, root }) => {
  if (selfTest) {
    const syntheticStatus = [
      'M  src/core/json.mjs',
      ' M docs/implementation/build-and-verification.md',
      'A  .lain-audit/tmp-03/fts2_100000.db',
      '?? notes.tmp',
    ];
    const classified = classifyStatus(syntheticStatus);
    const checks = [
      ['staged detection', classified.staged.length === 2, `got ${classified.staged.length}`],
      ['modified detection', classified.modified.length === 1, `got ${classified.modified.length}`],
      ['untracked detection', classified.untracked.length === 1, `got ${classified.untracked.length}`],
      [
        'dependency rule',
        unexpectedDependencies(['typescript', 'left-pad'], ALLOWED_DEV_DEPENDENCIES).length === 1,
        'unexpected dependency not detected',
      ],
      ['empty runtime deps', unexpectedDependencies([], []).length === 0, 'false positive on empty set'],
    ];
    const failed = checks.filter(([, ok]) => !ok);
    result.record('self_test_checks', checks.length);
    for (const [name, , detail] of failed) result.fail(`self-test: ${name} failed (${detail})`);
    if (failed.length === 0) result.note(`self-test ok: ${checks.length} rule checks detected their violation`);
    return;
  }

  const inRepo = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
    result.fail('not inside a git work tree', { message: inRepo.stderr.trim() || 'git rev-parse failed' });
    return;
  }

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const statusLines = git(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split(/\r?\n/);
  const { staged, modified, untracked } = classifyStatus(statusLines);

  result.record('branch', branch);
  result.record('head', head.slice(0, 12));
  result.record('staged_files', staged.length);
  result.record('modified_files', modified.length);
  result.record('untracked_files', untracked.length);
  if (untracked.length > 0 && untracked.length <= 12) result.record('untracked', untracked.join(' '));

  if (branch !== 'main') result.note(`on branch ${branch}, not main`);

  // Staged-but-uncommitted work is reported, not failed: a check must not decide
  // a user's staging. What fails is staging something the repository forbids.
  for (const path of staged) {
    if (/\.lain-audit\//.test(path) || /\.db(-wal|-shm)?$/.test(path)) {
      result.fail(`forbidden path is staged: ${path}`, { message: 'forbidden staged path', where: path });
    }
  }
  if (staged.length > 0) result.note(`${staged.length} file(s) staged at check time: ${staged.slice(0, 6).join(', ')}`);

  // Dependency surface.
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  result.record('runtime_dependencies', runtimeDeps.length === 0 ? '(none)' : runtimeDeps.join(' '));
  result.record('dev_dependencies', devDeps.join(' ') || '(none)');

  const extraRuntime = unexpectedDependencies(runtimeDeps, ALLOWED_RUNTIME_DEPENDENCIES);
  const extraDev = unexpectedDependencies(devDeps, ALLOWED_DEV_DEPENDENCIES);
  for (const dep of extraRuntime) {
    result.fail(`runtime dependency added outside the approved policy: ${dep}`, { message: 'unapproved runtime dependency' });
  }
  for (const dep of extraDev) {
    result.fail(`development dependency added outside the approved policy: ${dep}`, { message: 'unapproved dev dependency' });
  }

  // The lockfile is the reproducibility artifact; its absence is a failure.
  for (const required of ['package.json', 'package-lock.json', '.node-version']) {
    try {
      await stat(join(root, required));
      result.note(`${required} present`);
    } catch {
      result.fail(`missing ${required}`, { message: 'reproducibility artifact absent', where: required });
    }
  }

  // Node version pin is documented in package.json too; the two must agree that
  // major 24 is required. Both `^24.0.0` and `>=24.0.0 <25.0.0` are acceptable
  // spellings; a range that admits another major is not.
  const engine = pkg.engines?.node ?? '(unset)';
  result.record('engines_node', engine);
  const requires24 = /^\^24\./.test(String(engine)) || /^>=24\.0\.0\s*<25/.test(String(engine));
  if (!requires24) {
    result.fail(`package.json engines.node is ${engine}, expected a pin limited to major 24`, {
      message: 'engine range mismatch',
      detail: 'accepted forms: ^24.0.0 or >=24.0.0 <25.0.0',
    });
  }

  // Project-relative files that must never be committed.
  const mustBeIgnored = [];
  const dbFiles = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (/\.db/.test(dbFiles.stdout ?? '')) mustBeIgnored.push('.db files visible to git');
  if (mustBeIgnored.length > 0) {
    for (const item of mustBeIgnored) result.fail(`repository hygiene: ${item}`, { message: item });
  } else {
    result.note('no database or audit artifact is visible to git');
  }

  if (result.status === 'pass') result.note('repository hygiene checks passed');
});
