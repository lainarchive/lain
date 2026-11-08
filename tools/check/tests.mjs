/**
 * Check: the test suite actually runs, and can actually fail.
 *
 * Two things are proven here, and the second is the one that matters:
 *   1. `npm test` exits 0 and reports a non-zero test count.
 *   2. A synthetic failing test, run with the same runner, exits non-zero and
 *      reports failures. Without (2), "tests pass" could mean "no tests ran" or
 *      "the runner always returns 0".
 *
 * The suite is invoked through `npm test` so that the check cannot drift from
 * the command a developer runs. The test files supply their own arguments so
 * the run is independent of the shell.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isEntryPoint, main } from './lib/report.mjs';

/**
 * Run `npm test` in the project root.
 *
 * @param {string} root
 * @returns {{ status: number, output: string }}
 */
function runSuite(root) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const proc = spawnSync(npm, ['test', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: proc.status ?? -1, output: `${proc.stdout ?? ''}${proc.stderr ?? ''}` };
}

/**
 * Extract the test counters from `node --test --test-reporter=spec` output.
 *
 * @param {string} output
 * @returns {{ tests: number, pass: number, fail: number }}
 */
export function parseSpec(output) {
  /** @param {string} label */
  const num = (label) => {
    const m = output.match(new RegExp(`^\\u2139 ${label} (\\d+)$`, 'm')) ?? output.match(new RegExp(`^${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  return { tests: num('tests'), pass: num('pass'), fail: num('fail') };
}

if (isEntryPoint(import.meta.url)) await main('tests', async ({ result, selfTest, root }) => {
  if (selfTest) {
    const dir = await mkdtemp(join(tmpdir(), 'lain-tests-selftest-'));
    try {
      await writeFile(
        join(dir, 'deliberate-failure.test.mjs'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('deliberate failure', () => { assert.equal(1, 2, 'this test must fail'); });",
          '',
        ].join('\n'),
        'utf8',
      );
      const proc = spawnSync(
        process.execPath,
        ['--test', '--test-reporter=spec', join(dir, 'deliberate-failure.test.mjs')],
        { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
      );
      const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
      const counters = parseSpec(output);
      result.record('self_test_exit', proc.status);
      result.record('self_test_counters', `tests=${counters.tests} pass=${counters.pass} fail=${counters.fail}`);
      if (proc.status !== 0 && counters.fail >= 1) {
        result.note('self-test ok: a deliberately failing test produced a non-zero exit and a fail count');
      } else {
        result.fail('self-test: the runner did not report a deliberately failing test', {
          message: `exit ${proc.status}, counters tests=${counters.tests} fail=${counters.fail}`,
          detail: output.split('\n').slice(0, 8).join(' | '),
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }

  const run = runSuite(root);
  const counters = parseSpec(run.output);
  result.record('command', 'npm test');
  result.record('exit_code', run.status);
  result.record('counters', `tests=${counters.tests} pass=${counters.pass} fail=${counters.fail}`);

  if (counters.tests === 0) {
    result.fail('the test run reported zero tests', {
      message: 'no tests discovered',
      detail: 'a green suite with no tests proves nothing',
    });
    return;
  }
  if (run.status !== 0 || counters.fail > 0) {
    const failing = run.output
      .split(/\r?\n/)
      .filter((line) => /^\\s*[\\u2716\\u2717] /.test(line) || /^not ok /.test(line))
      .slice(0, 12);
    for (const line of failing) result.fail(line.trim(), { message: 'failing test' });
    if (failing.length === 0) {
      result.fail(`npm test exited ${run.status} with no parseable failures`, {
        message: run.output.split('\n').slice(-12).join(' | '),
      });
    }
    return;
  }
  result.note(`${counters.pass}/${counters.tests} tests passed`);
});
