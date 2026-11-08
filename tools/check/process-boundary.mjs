#!/usr/bin/env node
/**
 * Process boundary.
 *
 * One rule, mechanically checked: **`child_process` is imported only inside
 * `src/exec/`.** Every other module that wants to run a program must go through
 * the workspace, which is what applies the environment allow-list, the timeout,
 * the output ceiling and the workspace scrub. A second import site would be a
 * code path that runs a process without any of those, and it would not be
 * obvious in review.
 *
 * The check reports NOT-TESTABLE when it finds no import sites at all, because
 * "no violations" and "nothing to inspect" are different results.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

const ALLOWED_DIRS = ['src/exec/'];
const IMPORT_RE = /(?:from\s+['"]node:child_process['"]|require\(\s*['"]node:child_process['"]\s*\)|from\s+['"]child_process['"])/;
// A bare call, or a destructured import call — but NOT a method call.
//
// The `(?<![.\w])` guard is load-bearing: without it this matched
// `db.exec('PRAGMA busy_timeout = 0')` inside the event store and reported the
// store as launching a process. A check that cries wolf on a string method is a
// check people learn to ignore, which is worse than not having it.
const SPAWN_RE = /(?<![.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

/** @param {string} dir @param {string[]} [out] */
export function walkSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Scan one source text. Pure, so the self-test exercises the same rule the real
 * walk does — a self-test with its own copy of the regex would prove nothing
 * about the regex that actually runs.
 *
 * @param {string} text
 * @param {{allowed?: boolean}} [options]
 * @returns {{violations: {line: number, text: string}[], imports: number}}
 */
export function scanSource(text, options = {}) {
  const allowed = options.allowed === true;
  /** @type {{line: number, text: string}[]} */
  const violations = [];
  let imports = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    const isImport = IMPORT_RE.test(line);
    const isSpawn = SPAWN_RE.test(line) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//');
    if (isImport || isSpawn) {
      imports += isImport ? 1 : 0;
      if (!allowed) violations.push({ line: index + 1, text: line.trim().slice(0, 120) });
    }
  });
  return { violations, imports };
}

/**
 * @param {string} root
 * @returns {{violations: {file: string, line: number, text: string}[], imports: number, files: number}}
 */
export function findProcessBoundaryViolations(root) {
  const srcDir = join(root, 'src');
  if (!statSync(srcDir, { throwIfNoEntry: false })) return { violations: [], imports: 0, files: 0 };
  const files = walkSources(srcDir);
  /** @type {{file: string, line: number, text: string}[]} */
  const violations = [];
  let imports = 0;
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const allowed = ALLOWED_DIRS.some((prefix) => rel.startsWith(prefix));
    const scanned = scanSource(readFileSync(file, 'utf8'), { allowed });
    imports += scanned.imports;
    for (const v of scanned.violations) violations.push({ file: rel, line: v.line, text: v.text });
  }
  return { violations, imports, files: files.length };
}

export const INTERNALS = { ALLOWED_DIRS, IMPORT_RE, SPAWN_RE };

if (isEntryPoint(import.meta.url)) {
  await main('process-boundary', (ctx) => {
    if (ctx.selfTest) {
      // Two ways to be wrong: missing a real spawn outside the allow-list, and
      // flagging something that is not a spawn at all. The second is the one
      // that gets a check switched off.
      const violating = [
        "import { execFileSync } from 'node:child_process';",
        'export function probe() {',
        "  return execFileSync('nvidia-smi', ['--query-gpu=name']);",
        '}',
      ].join('\n');
      const clean = [
        '// This module never spawns a process; db.exec( ) below is a string method.',
        'export function read(db) {',
        "  db.exec('PRAGMA busy_timeout = 0');",
        '  return true;',
        '}',
      ].join('\n');
      const badHits = scanSource(violating).violations.length;
      const goodHits = scanSource(clean).violations.length;
      ctx.result.record('violation_detected', badHits);
      ctx.result.record('false_positives_on_clean_source', goodHits);
      if (badHits < 2) ctx.result.fail('self-test: child_process use outside the allow-list was not detected', { detail: `hits=${badHits}` });
      if (goodHits > 0) ctx.result.fail('self-test: a string method call was mistaken for a process launch', { detail: `hits=${goodHits}` });
      if (badHits >= 2 && goodHits === 0) ctx.result.note('self-test ok: a real spawn is caught, a string method is not');
      return;
    }

    const root = process.cwd();
    const { violations, imports, files } = findProcessBoundaryViolations(root);
    ctx.result.record('boundary', { files_scanned: files, import_sites_inside_exec: imports, allowlist: ALLOWED_DIRS });
    if (files === 0) {
      ctx.result.notTestable(
        'the process boundary could not be checked',
        'no .mjs/.js/.cjs files were found under src/, so there was nothing to inspect',
      );
      return;
    }
    if (violations.length === 0) {
      ctx.result.note(`no child_process use outside ${ALLOWED_DIRS.join(', ')}`);
      return;
    }
    for (const v of violations) {
      ctx.result.fail(`${v.file}:${v.line} uses child_process outside ${ALLOWED_DIRS.join(', ')}`, {
        where: `${v.file}:${v.line}`,
        detail: v.text,
      });
    }
  });
}
