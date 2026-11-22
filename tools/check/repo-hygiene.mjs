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

/**
 * The complete list of runtime dependencies this project permits. @opentui/core
 * joined it by owner decision on 2026-11-14 (M-9 dashboard renderer) — the
 * first and, so far, only runtime dependency; every other need so far is
 * satisfied by the Node standard library.
 */
export const ALLOWED_RUNTIME_DEPENDENCIES = /** @type {string[]} */ (['@opentui/core']);

/** The complete list of development dependencies this project permits. */
export const ALLOWED_DEV_DEPENDENCIES = ['typescript', '@types/node'];

export const ALLOWED_RUST_DEPENDENCIES = [
  'axum', 'futures-util', 'getrandom', 'tower-http', 'ts-rs',
  'async-stream', 'async-trait', 'cap-std', 'crossterm', 'futures', 'jsonschema', 'lain-agent', 'lain-context', 'lain-core', 'lain-harness', 'lain-ipc',
  'lain-memory', 'lain-plugin', 'regex', 'reqwest', 'rusqlite', 'serde', 'serde_json', 'serde_yaml_ng', 'sha2', 'tempfile', 'thiserror', 'tiktoken-rs', 'tokio',
  'tree-sitter', 'tree-sitter-rust', 'tree-sitter-typescript',
];
export const ALLOWED_RUST_DEV_DEPENDENCIES = ['async-trait', 'futures', 'tempfile'];

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
      ['rust dependency rule', unexpectedDependencies(['rusqlite', 'unapproved-crate'], ALLOWED_RUST_DEPENDENCIES).length === 1, 'unapproved Rust dependency missed'],
      ['core dependency rule', unexpectedDependencies(['tokio', 'lain-memory', 'jsonschema', 'getrandom'], ALLOWED_RUST_DEPENDENCIES).length === 0, 'approved Core dependency rejected'],
      ['rust dev dependency rule', unexpectedDependencies(['tempfile', 'anyhow'], ALLOWED_RUST_DEV_DEPENDENCIES).length === 1, 'unapproved Rust dev dependency missed'],
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
  const cargo = spawnSync('cargo', ['metadata', '--format-version=1', '--locked'], {
    cwd: root, encoding: 'utf8', windowsHide: true, shell: false,
    // I keep the full graph for lock validation; lain-core exceeds Node's 1 MiB default.
    maxBuffer: 16 * 1024 * 1024,
  });
  if (cargo.status !== 0) {
    result.fail('Cargo workspace metadata unavailable', { message: cargo.error?.message ?? cargo.stderr.trim() });
  } else {
    const metadata = JSON.parse(cargo.stdout);
    for (const pkg of metadata.packages) {
      if (!metadata.workspace_members.includes(pkg.id)) continue;
      for (const dep of pkg.dependencies) {
        const allowed = dep.kind === 'dev' ? ALLOWED_RUST_DEV_DEPENDENCIES : ALLOWED_RUST_DEPENDENCIES;
        if (dep.kind === 'build' || !allowed.includes(dep.name)) {
          result.fail(`unapproved Rust dependency: ${pkg.name}/${dep.name}`, { message: 'unapproved Rust dependency' });
        }
      }
    }
  }

  for (const required of ['package.json', 'package-lock.json', '.node-version', 'Cargo.toml', 'Cargo.lock']) {
    try {
      await stat(join(root, required));
      result.note(`${required} present`);
    } catch {
      result.fail(`missing ${required}`, { message: 'reproducibility artifact absent', where: required });
    }
  }

  // Node version pin is documented in package.json too; the two must agree that
  // major 26 is required. Both `^26.4.0` and `>=26.4.0 <27.0.0` are acceptable
  // spellings; a range that admits another major is not. (Major 26 became the
  // floor by owner decision on 2026-11-14: the M-9 dashboard renderer
  // @opentui/core needs node >= 26.4.)
  const engine = pkg.engines?.node ?? '(unset)';
  result.record('engines_node', engine);
  const requires26 = /^\^26\./.test(String(engine)) || /^>=26\.4\.0\s*<27/.test(String(engine));
  if (!requires26) {
    result.fail(`package.json engines.node is ${engine}, expected a pin limited to major 26`, {
      message: 'engine range mismatch',
      detail: 'accepted forms: ^26.4.0 or >=26.4.0 <27.0.0',
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
