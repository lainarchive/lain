/**
 * Check: the documented formatting policy, over the files this repository owns.
 *
 * Policy (see docs/implementation/build-and-verification.md):
 *   F-1  text files are UTF-8 without a BOM
 *   F-2  line endings are LF in the working tree
 *   F-3  no tab character used for indentation
 *   F-4  no trailing whitespace
 *   F-5  the file ends with exactly one newline
 *   F-6  no line exceeds 200 characters
 *
 * Scope is explicit rather than "everything under the root", for two measured
 * reasons:
 *
 *   1. The canonical documents predate this policy. Several contain lines over
 *      200 characters, and four of them are CRLF in the working tree because
 *      the repository runs with `core.autocrlf=true` and their content was
 *      written by earlier sessions. Failing on them would mean the new build
 *      gate cannot pass until unrelated files are rewritten — which is a
 *      decision for the project owner, not a side effect of adding a check.
 *   2. A check whose result depends on files it does not own trains people to
 *      ignore it.
 *
 * So: files in OWNED_PATHS are checked strictly. Files in LEGACY_PATHS are
 * *reported* with counts, and the report says plainly that they are not
 * enforced. `--strict` turns the legacy report into failures, which is the gate
 * to switch on once the repository has been renormalised (see
 * docs/implementation/open-issues.md, issue 1).
 *
 * Why no formatter dependency: the rules above are the rules that matter for
 * diff quality and tooling here. A formatter would add a third dependency and
 * would rewrite hand-written files wholesale. The planned replacement, once the
 * codebase is larger, is `biome format` — and these rules are the subset it
 * preserves.
 *
 * `--self-test` runs the same rules over synthetic text with one violation of
 * each rule and passes only if every violation is detected.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

/** Paths this repository owns and enforces the policy on. */
export const OWNED_PATHS = [
  'src/',
  'test/',
  'tools/',
  'docs/implementation/',
];

/** Paths whose format is not enforced yet, with the reason. */
export const LEGACY_PATHS = [
  { path: 'docs/research/', reason: 'research documents written before this policy; CRLF in the working tree' },
  { path: 'root-markdown', reason: 'canonical documents written before this policy' },
];

/** Extensions whose contents are checked. */
const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.sql']);

/** Individual files at the repository root that this repository owns. */
const OWNED_ROOT_FILES = new Set([
  'package.json',
  'tsconfig.json',
  '.node-version',
  '.gitattributes',
  'RESOURCE_BUDGET.md',
]);

/** Files exempt from the length rule only, because a generator wrote them. */
const LENGTH_EXEMPT = new Set(['package-lock.json']);

/**
 * @typedef {{ rule: string, line: number, detail: string }} FormatViolation
 */

/**
 * Apply every rule to one text file.
 *
 * @param {string} text
 * @param {{ maxLineLength?: number, checkLineLength?: boolean }} [opts]
 * @returns {FormatViolation[]}
 */
export function checkText(text, opts = {}) {
  const maxLineLength = opts.maxLineLength ?? 200;
  const checkLineLength = opts.checkLineLength ?? true;
  /** @type {FormatViolation[]} */
  const out = [];

  if (text.charCodeAt(0) === 0xfeff) out.push({ rule: 'F-1 BOM', line: 1, detail: 'file starts with a UTF-8 BOM' });
  if (text.includes('\r')) {
    const firstCrlf = text.indexOf('\r');
    const line = text.slice(0, firstCrlf).split('\n').length;
    out.push({ rule: 'F-2 CRLF', line, detail: 'carriage return present: expected LF only' });
  }

  const lines = text.split('\n');
  if (text.length > 0 && !text.endsWith('\n')) {
    out.push({ rule: 'F-5 no final newline', line: lines.length, detail: 'file does not end with a newline' });
  }
  if (text.endsWith('\n\n')) {
    out.push({ rule: 'F-5 extra final newline', line: lines.length, detail: 'file ends with a blank line' });
  }

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/^[ ]*\t/.test(line)) out.push({ rule: 'F-3 tab indentation', line: lineNo, detail: 'tab used for indentation' });
    if (/[ \t]+$/.test(line) && line.trim() !== '') {
      out.push({
        rule: 'F-4 trailing whitespace',
        line: lineNo,
        detail: `${line.length - line.trimEnd().length} trailing space(s)`,
      });
    }
    if (checkLineLength && line.length > maxLineLength) {
      out.push({ rule: 'F-6 long line', line: lineNo, detail: `${line.length} characters (max ${maxLineLength})` });
    }
  });

  return out;
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function isOwnedPath(relPath) {
  if (OWNED_ROOT_FILES.has(relPath)) return true;
  return OWNED_PATHS.some((prefix) => relPath.startsWith(prefix));
}

/**
 * @param {string} dir
 * @param {string} root
 * @param {string[]} out
 */
async function walk(dir, root, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', '.lain-audit', 'artifacts'].includes(rel)) continue;
      await walk(full, root, out);
    } else if (TEXT_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(rel);
    }
  }
}

if (isEntryPoint(import.meta.url)) await main('format', async ({ result, selfTest, root, argv }) => {
  const strict = argv.includes('--strict');

  if (selfTest) {
    const probes = [
      { name: 'BOM', text: '\ufeffhello\n', rule: 'F-1' },
      { name: 'CRLF', text: 'a\r\nb\n', rule: 'F-2' },
      { name: 'tab indent', text: '\tindented\n', rule: 'F-3' },
      { name: 'trailing space', text: 'value = 1  \n', rule: 'F-4' },
      { name: 'no final newline', text: 'no newline', rule: 'F-5' },
      { name: 'extra final newline', text: 'text\n\n', rule: 'F-5' },
      { name: 'long line', text: `${'x'.repeat(220)}\n`, rule: 'F-6' },
    ];
    const missed = [];
    for (const probe of probes) {
      const found = checkText(probe.text);
      if (!found.some((v) => v.rule.startsWith(probe.rule))) missed.push(`${probe.name} (${probe.rule})`);
    }
    const clean = checkText('const a = 1;\nexport { a };\n');
    if (clean.length !== 0) missed.push(`clean text produced ${clean.length} false violation(s)`);
    // The ownership rule itself must classify correctly.
    if (!isOwnedPath('src/core/json.mjs')) missed.push('isOwnedPath: src file not owned');
    if (isOwnedPath('ARCHITECTURE.md')) missed.push('isOwnedPath: legacy root doc reported as owned');
    result.record('probes', probes.length);
    if (missed.length > 0) {
      result.fail(`self-test: ${missed.join(', ')}`, { message: missed.join('; ') });
    } else {
      result.note(`self-test ok: ${probes.length} violations detected, clean input produced none, ownership classified`);
    }
    return;
  }

  /** @type {string[]} */
  const files = [];
  await walk(root, root, files);

  const owned = [];
  const legacy = [];
  let violations = 0;
  let legacyViolations = 0;

  for (const rel of files) {
    const text = await readFile(join(root, rel), 'utf8');
    const found = checkText(text, { checkLineLength: !LENGTH_EXEMPT.has(rel.split('/').pop() ?? '') });
    if (isOwnedPath(rel)) {
      owned.push(rel);
      violations += found.length;
      for (const v of found.slice(0, 5)) {
        result.fail(`${rel}:${v.line} ${v.rule} — ${v.detail}`, { message: v.rule, where: `${rel}:${v.line}` });
      }
      if (found.length > 5) result.note(`${rel}: ${found.length - 5} further violations suppressed`);
    } else {
      legacy.push(rel);
      legacyViolations += found.length;
      if (strict && found.length > 0) {
        for (const v of found.slice(0, 3)) {
          result.fail(`${rel}:${v.line} ${v.rule} — ${v.detail} (legacy path, --strict)`, {
            message: v.rule,
            where: `${rel}:${v.line}`,
          });
        }
      }
    }
  }

  result.record('files_checked', files.length);
  result.record('owned_files_enforced', owned.length);
  result.record('owned_violations', violations);
  result.record('legacy_files_reported_not_enforced', legacy.length);
  result.record('legacy_violations_not_enforced', legacyViolations);
  result.record('mode', strict ? 'strict (legacy paths enforced)' : 'advisory for legacy paths');

  if (violations === 0) result.note(`formatting policy satisfied by ${owned.length} owned file(s)`);
  if (legacyViolations > 0 && !strict) {
    result.note(
      `NOT ENFORCED: ${legacyViolations} violation(s) in ${legacy.length} pre-existing file(s) ` +
        `(${LEGACY_PATHS.map((l) => l.path).join(', ')}). Run \`npm run check:format-strict\` to see them as failures.`,
    );
  }
});
