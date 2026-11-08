/**
 * Check: the event store's ownership boundary holds in the source tree.
 *
 * Why this exists: `06-one-bounded-agent-specification.md` §3.2 and
 * `02-security-and-containment.md` §1.3 both state that the store persists and
 * orders events while the Policy Engine alone decides authorization. A boundary
 * that is only documented erodes; this check makes it mechanical.
 *
 * The rule: nothing under `src/store/` may reference authorization concepts.
 * A store that can answer "may this happen?" has become an authority, and the
 * architecture's whole security argument depends on it not being one.
 *
 * `--self-test` runs the same rule over synthetic sources containing one
 * violation and one legitimate match, and passes only if it tells them apart.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

/** Identifiers that must not appear in the store's source. */
export const FORBIDDEN_IN_STORE = [
  'decide(',
  'policyDecide',
  'authorize(',
  'isAuthorized',
  'grantPermission',
  'approve(',
  'checkPermission',
  'evaluatePolicy',
];

/**
 * @param {string} source
 * @returns {{ identifier: string, line: number }[]}
 */
export function findForbiddenIdentifiers(source) {
  /** @type {{ identifier: string, line: number }[]} */
  const hits = [];
  source.split('\n').forEach((line, index) => {
    // Strip comments before matching: a comment that names the boundary is
    // documentation, not a call. Three forms matter — a trailing `//` comment, a
    // whole `//` comment line, and a `*` continuation line inside a block
    // comment (which begins with optional whitespace, then the asterisk).
    const code = line
      .replace(/\/\/.*$/, '')
      .replace(/^\s*\*.*$/, '')
      .replace(/^\s*\/\*.*$/, '');
    for (const identifier of FORBIDDEN_IN_STORE) {
      if (code.includes(identifier)) hits.push({ identifier, line: index + 1 });
    }
  });
  return hits;
}

/**
 * @param {string} dir
 * @param {string} root
 * @param {string[]} out
 */
async function walk(dir, root, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.name.endsWith('.mjs')) out.push(relative(root, full).split(sep).join('/'));
  }
}

if (isEntryPoint(import.meta.url)) await main('store-boundary', async ({ result, selfTest, root }) => {
  if (selfTest) {
    const bad = [
      'export function append(event) {',
      '  if (!decide(event)) throw new Error("denied");',
      '  return event;',
      '}',
    ].join('\n');
    const good = [
      '// The store deliberately never calls decide(); authorization is external.',
      'export function append(event) {',
      '  /** decide( ) is documented above, not called */',
      '  return event;',
      '}',
    ].join('\n');
    const badHits = findForbiddenIdentifiers(bad);
    const goodHits = findForbiddenIdentifiers(good);
    result.record('violation_detected', badHits.length);
    result.record('comment_false_positives', goodHits.length);
    result.record('comment_false_positive_lines', goodHits.map((h) => `${h.identifier}@${h.line}`).join(' ') || 'none');
    if (badHits.length === 0) {
      result.fail('self-test: a call to decide() inside the store was not detected', { detail: 'rule failed to match' });
    }
    if (goodHits.length > 0) {
      result.fail(`self-test: a comment mentioning the boundary was flagged as a violation (line ${goodHits.map((h) => h.line).join(',')})`, {
        detail: `matched ${goodHits.map((h) => h.identifier).join(',')}`,
      });
    }
    if (badHits.length > 0 && goodHits.length === 0) {
      result.note('self-test ok: real call detected, comment-only mention ignored');
    }
    return;
  }

  /** @type {string[]} */
  const files = [];
  await walk(join(root, 'src', 'store'), root, files);
  result.record('store_files', files.length === 0 ? '(store not implemented yet)' : files.join(' '));

  let violations = 0;
  for (const rel of files) {
    const source = await readFile(join(root, rel), 'utf8');
    for (const hit of findForbiddenIdentifiers(source)) {
      violations += 1;
      result.fail(`authorization identifier "${hit.identifier}" in store source`, {
        message: 'the store must not make authorization decisions',
        where: `${rel}:${hit.line}`,
      });
    }
  }

  if (files.length === 0) {
    result.note('the store does not exist yet, so the boundary holds vacuously (reported as such, not as a pass of the rule)');
  } else if (violations === 0) {
    result.note(`no authorization identifiers in ${files.length} store file(s)`);
  }
});
