/**
 * Check: static type checking over JSDoc-annotated JavaScript.
 *
 * Why it can fail: with `--self-test` the check writes a file that contains a
 * deliberate type error into a temporary directory, runs the same type checker
 * over it, and passes only if the checker reports the error. That is the
 * positive control for "our types are being checked at all".
 *
 * The checker is the single approved development dependency (typescript). It is
 * never used at runtime.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isEntryPoint, main } from './lib/report.mjs';

/**
 * Run the project's TypeScript compiler.
 *
 * Invoked through Node with an explicit path so the check does not depend on
 * PATH, on a shell, or on `.bin` shims.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {{ status: number|null, failed: boolean, exitEvidence: string, stdout: string, stderr: string, command: string, error?: string, signal?: string|null }}
 */
export function runTsc(root, args) {
  const tscJs = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const command = `node ${tscJs} ${args.join(' ')}`;
  if (!existsSync(tscJs)) {
    return { status: null, failed: true, exitEvidence: 'typescript not installed', stdout: '', stderr: `typescript is not installed at ${tscJs}`, command };
  }
  const proc = spawnSync(process.execPath, [tscJs, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const diagnostics = /error TS\d+/.test(`${stdout}${stderr}`);
  // TypeScript 7's `lib/tsc.js` is a shim that delegates to a native compiler and
  // returns 0 even when compilation failed, so the exit code alone is not a
  // verdict. Diagnostics on either stream are treated as failure and the reason
  // is recorded, because a check that reports success on a failed compile is
  // worse than no check.
  const failed = proc.status !== 0 || proc.status === null || diagnostics;
  const exitEvidence =
    proc.status !== 0
      ? `exit ${proc.status}`
      : diagnostics
        ? 'exit 0 but diagnostics were emitted'
        : 'exit 0, no diagnostics';
  return {
    status: proc.status,
    failed,
    exitEvidence,
    stdout,
    stderr,
    command,
    error: proc.error ? `${proc.error.name}: ${proc.error.message}` : undefined,
    signal: proc.signal ?? null,
  };
}

if (isEntryPoint(import.meta.url)) await main('types', async ({ result, selfTest, root }) => {
  const tscJs = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!existsSync(tscJs)) {
    result.fail('the type checker is not installed', {
      message: `expected ${tscJs}`,
      detail: 'run `npm install` — typescript is the single approved development dependency',
    });
    return;
  }

  if (selfTest) {
    const dir = await mkdtemp(join(tmpdir(), 'lain-types-selftest-'));
    try {
      await writeFile(
        join(dir, 'bad.mjs'),
        [
          '/** @param {number} n */',
          'export function double(n) {',
          "  const wrong = 'not a number';",
          '  return n * wrong;',
          '}',
          'double("string instead of number");',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2024', lib: ['ES2024'], module: 'nodenext', moduleResolution: 'nodenext',
              allowJs: true, checkJs: true, noEmit: true, strict: true, skipLibCheck: true,
            },
            include: ['bad.mjs'],
          },
          null,
          2,
        ),
        'utf8',
      );
      // The compiler is resolved from THIS project (`root`); only the source under
      // test lives in the temp directory. Passing the temp directory as the
      // compiler root would look for a TypeScript install that is not there.
      const proc = runTsc(root, ['--project', join(dir, 'tsconfig.json')]);
      const output = `${proc.stdout}${proc.stderr}`;
      const detected = proc.failed && /error TS\d+/.test(output);
      result.record('self_test_tsc_exit', proc.status);
      result.record('self_test_verdict', proc.exitEvidence);
      result.record('self_test_errors', (output.match(/error TS\d+/g) ?? []).join(',') || 'none');
      result.record('self_test_output_bytes', output.length);
      if (detected) {
        result.note(`self-test ok: a deliberate type error was detected (${proc.exitEvidence})`);
      } else {
        result.fail(`self-test: the type checker did NOT detect a deliberate type error (${proc.exitEvidence})`, {
          detail: `spawn error: ${proc.error ?? 'none'}; signal: ${proc.signal ?? 'none'}; output bytes: ${output.length}`,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }

  const proc = runTsc(root, ['--project', join(root, 'tsconfig.json')]);
  const output = `${proc.stdout}${proc.stderr}`.trim();
  result.record('command', proc.command);
  result.record('exit_code', proc.status);
  result.record('verdict', proc.exitEvidence);
  const errorCount = (output.match(/error TS\d+/g) ?? []).length;
  result.record('type_errors', errorCount);

  if (proc.failed) {
    const lines = output.split(/\r?\n/).filter((l) => l.trim() !== '');
    for (const line of lines.slice(0, 15)) {
      result.fail(`type error: ${line}`);
    }
    if (lines.length > 15) result.note(`${lines.length - 15} further lines suppressed`);
  } else if (output !== '') {
    result.note(output.split(/\r?\n/)[0] ?? '');
  } else {
    result.note('tsc reported no diagnostics');
  }

  // Report the configured scope, so "clean" cannot hide "nothing was checked".
  const tsconfig = JSON.parse(await readFileText(join(root, 'tsconfig.json')));
  result.record('include', (tsconfig.include ?? []).join(' '));
  result.record('strict', String(tsconfig.compilerOptions?.strict ?? false));
});

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readFileText(path) {
  return readFile(path, 'utf8');
}
