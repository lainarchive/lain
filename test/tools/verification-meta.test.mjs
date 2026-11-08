/**
 * Meta-test: the verification checks detect violations.
 *
 * The check modules prove themselves in `--self-test` mode, which the
 * orchestrator runs. These tests do the same thing from the suite's side, so an
 * accidental weakening of a rule — for example a pattern that stops matching —
 * fails the ordinary `npm test` run as well.
 *
 * This is the positive control for the whole verification story: a gate that
 * cannot fail is not a gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText, isOwnedPath } from '../../tools/check/format.mjs';
import { forbiddenMatches } from '../../tools/check/layout.mjs';
import { classifyStatus, unexpectedDependencies } from '../../tools/check/repo-hygiene.mjs';
import { findForbiddenIdentifiers } from '../../tools/check/store-boundary.mjs';
import { parseSpec } from '../../tools/check/tests.mjs';

/**
 * The counter parser is what decides whether a green suite is believable, so it
 * gets a probe of its own shape: a run with no counters must not read as zero
 * failures.
 *
 * This test intentionally does NOT invoke `npm test`. Doing so would recurse
 * into the very suite that is running — `npm test` globs this file — and the
 * run would terminate on the recursion limit rather than on any real failure.
 * The child-process contract is exercised by `npm run check:tests` instead.
 */

test('format: every rule in the policy detects its violation', () => {
  const probes = [
    ['F-1', '\ufeffcontent\n'],
    ['F-2', 'line one\r\nline two\n'],
    ['F-3', '\tindented\n'],
    ['F-4', 'trailing   \n'],
    ['F-5', 'no final newline'],
    ['F-5', 'blank line at end\n\n'],
    ['F-6', `${'x'.repeat(201)}\n`],
  ];
  for (const [rule, text] of probes) {
    const found = checkText(text);
    assert.ok(
      found.some((v) => v.rule.startsWith(rule)),
      `rule ${rule} did not fire for ${JSON.stringify(text.slice(0, 20))}`,
    );
  }
  assert.deepEqual(checkText('const a = 1;\nexport { a };\n'), [], 'clean text must produce no violations');
});

test('format: ownership classification separates owned from legacy paths', () => {
  assert.equal(isOwnedPath('src/core/json.mjs'), true);
  assert.equal(isOwnedPath('tools/verify.mjs'), true);
  assert.equal(isOwnedPath('docs/implementation/build-and-verification.md'), true);
  assert.equal(isOwnedPath('package.json'), true);
  assert.equal(isOwnedPath('ARCHITECTURE.md'), false, 'canonical documents are not owned by the format policy yet');
  assert.equal(isOwnedPath('docs/research/phase-5-agents-orchestration/README.md'), false);
});

test('layout: forbidden artifacts are detected and ordinary files are not', () => {
  for (const bad of ['data/lain.db', 'logs/run.log', 'scratch.tmp', 'Thumbs.db', 'model.gguf', 'config/.env.local']) {
    assert.ok(forbiddenMatches(bad).length > 0, `${bad} must be reported as forbidden`);
  }
  for (const ok of ['src/core/json.mjs', 'docs/implementation/README.md', 'package.json']) {
    assert.equal(forbiddenMatches(ok).length, 0, `${ok} must not be reported as forbidden`);
  }
});

test('repo hygiene: git status parsing separates staged, modified and untracked', () => {
  const { staged, modified, untracked } = classifyStatus([
    'M  src/core/json.mjs',
    ' M docs/implementation/README.md',
    '?? scratch.tmp',
    'A  .lain-audit/tmp-03/fts2_100000.db',
  ]);
  assert.deepEqual(staged, ['src/core/json.mjs', '.lain-audit/tmp-03/fts2_100000.db']);
  assert.deepEqual(modified, ['docs/implementation/README.md']);
  assert.deepEqual(untracked, ['scratch.tmp']);
});

test('repo hygiene: any dependency outside the approved policy is reported', () => {
  assert.deepEqual(unexpectedDependencies(['typescript', '@types/node'], ['typescript', '@types/node']), []);
  assert.deepEqual(unexpectedDependencies(['typescript', 'left-pad'], ['typescript']), ['left-pad']);
  assert.deepEqual(unexpectedDependencies([], []), []);
});

test('store boundary: a real call is a violation, a comment is not', () => {
  const violation = findForbiddenIdentifiers('if (!decide(event)) throw new Error("no");');
  assert.equal(violation.length, 1);
  assert.equal(violation[0]?.identifier, 'decide(');
  assert.deepEqual(findForbiddenIdentifiers('// the store never calls decide() itself'), []);
  assert.deepEqual(findForbiddenIdentifiers(' * decide() belongs to the Policy Engine'), []);
  assert.equal(findForbiddenIdentifiers('const granted = grantPermission(task)').length, 1);
});

test('test-report parsing reads spec output and refuses to guess', () => {
  const spec = 'some output\n\u2139 tests 12\n\u2139 pass 10\n\u2139 fail 2\n';
  assert.deepEqual(parseSpec(spec), { tests: 12, pass: 10, fail: 2 });
  assert.deepEqual(parseSpec('no counters here'), { tests: 0, pass: 0, fail: 0 });
});
