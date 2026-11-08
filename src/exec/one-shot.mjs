/**
 * One-shot process execution.
 *
 * This module exists because of a mechanical rule: `child_process` may be
 * imported only inside `src/exec/`, and `tools/check/process-boundary.mjs`
 * enforces it. The host probe needs to ask `nvidia-smi` a question, and the
 * first version of that probe imported `execFileSync` directly — which the check
 * caught, correctly.
 *
 * The answer is not to widen the allow-list, because then the next module with a
 * reasonable excuse would widen it again. The answer is one function here, with
 * the same properties every other process launch in Lain gets: a minimal
 * environment rather than an inherited one, a hard timeout, an output ceiling,
 * `shell: false` so nothing is interpreted, and a result that says whether the
 * thing ran at all rather than throwing where a caller might not look.
 */
import { spawnSync } from 'node:child_process';

/**
 * @param {object} spec
 * @param {string} spec.command      fully qualified path, or a name resolved by PATH
 * @param {string[]} [spec.args]
 * @param {number} [spec.timeoutMs]
 * @param {number} [spec.maxOutputBytes]
 * @param {Record<string, string>} [spec.env]  a constructed environment, not process.env
 * @returns {{ran: boolean, status: number|null, stdout: string, stderr: string, error_code: string|null}}
 */
export function runOneShot(spec) {
  const maxOutputBytes = spec.maxOutputBytes ?? 65_536;
  const result = spawnSync(spec.command, spec.args ?? [], {
    // Only PATH and SystemRoot by default: a probe needs to find a binary, not
    // to inherit whatever credentials the parent shell happens to hold.
    env: spec.env ?? { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
    encoding: 'utf8',
    timeout: spec.timeoutMs ?? 3_000,
    windowsHide: true,
    shell: false,
    maxBuffer: Math.max(maxOutputBytes * 2, 1_048_576),
  });
  return {
    ran: !result.error,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: (result.stdout ?? '').slice(0, maxOutputBytes),
    stderr: (result.stderr ?? '').slice(0, maxOutputBytes),
    error_code: result.error ? /** @type {NodeJS.ErrnoException} */ (result.error).code ?? 'SPAWN_FAILED' : null,
  };
}
