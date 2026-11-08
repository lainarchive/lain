/**
 * Check harness — one shape for every verification check.
 *
 * Design rules that matter here:
 *
 *   - A check reports `pass`, `fail`, `skip` or `not-testable`. `skip` is never
 *     rendered as a pass, and a check that did not run says so in the summary.
 *   - `--self-test` makes the check run against a deliberately broken input and
 *     report `pass` only if it *detected* the violation. A check that cannot
 *     fail is not a check, so this is how each one is proven able to fail.
 *   - Nothing here exits 0 on failure: the process exit code is the contract.
 */

/** @typedef {'pass'|'fail'|'skip'|'not-testable'} Status */

import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} Finding
 * @property {string} message what failed, in one line a reader can act on
 * @property {string} [where]  relative path, line or command
 * @property {string} [detail] supporting detail: the observed value, the rule
 */

export class CheckResult {
  /**
   * @param {string} name
   */
  constructor(name) {
    /** @type {string} */
    this.name = name;
    /** @type {Status} */
    this.status = 'pass';
    /** @type {Finding[]} */
    this.findings = [];
    /** @type {string[]} */
    this.notes = [];
    /** @type {Record<string, unknown>} */
    this.evidence = {};
    this.startedAt = Date.now();
    this.finishedAt = 0;
  }

  /**
   * Record a failure.
   *
   * Accepts either a message string or a full finding object, because call sites
   * naturally have one or the other. `where` and `message` are both accepted in
   * the second argument so that either shape type-checks; `message` in the object
   * wins.
   *
   * @param {string | Finding} summary plain message, or a complete finding
   * @param {{ where?: string, detail?: string, message?: string }} [location]
   */
  fail(summary, location = {}) {
    this.status = 'fail';
    const finding = typeof summary === 'string' ? { message: summary } : summary;
    this.findings.push(Object.assign({}, location, finding));
  }

  /**
   * Record a failure that arrives as a finding object, for cases where the
   * location is computed rather than literal.
   *
   * @param {Finding} finding
   */
  addFinding(finding) {
    this.status = 'fail';
    this.findings.push(finding);
  }

  /**
   * @param {string} message
   */
  note(message) {
    this.notes.push(message);
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  record(key, value) {
    this.evidence[key] = value;
  }

  /**
   * @param {string} what
   * @param {string} why
   */
  skip(what, why) {
    if (this.status === 'pass') this.status = 'skip';
    this.notes.push(`SKIPPED: ${what} — ${why}`);
  }

  /**
   * @param {string} what
   * @param {string} why
   */
  notTestable(what, why) {
    if (this.status !== 'fail') this.status = 'not-testable';
    this.notes.push(`NOT-TESTABLE: ${what} — ${why}`);
  }

  finish() {
    this.finishedAt = Date.now();
    return this;
  }

  /** @returns {number} */
  get exitCode() {
    return this.status === 'fail' ? 1 : 0;
  }
}

/**
 * Run one check module's exported `run(options)` and normalise the result.
 *
 * @param {string} name
 * @param {(ctx: { result: CheckResult, selfTest: boolean, root: string, argv: string[] }) => Promise<void>|void} body
 * @param {string[]} [argv]
 * @returns {Promise<CheckResult>}
 */
export async function runCheck(name, body, argv = process.argv.slice(2)) {
  const selfTest = argv.includes('--self-test');
  const result = new CheckResult(name);
  const root = process.cwd();
  try {
    await body({ result, selfTest, root, argv });
  } catch (err) {
    result.fail(err instanceof Error ? err.message : String(err), {
      detail: err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : undefined,
    });
  }
  return result.finish();
}

/**
 * Print a check result in one block.
 *
 * @param {CheckResult} result
 */
export function printResult(result) {
  const badge = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', 'not-testable': 'NOT-TESTABLE' }[result.status];
  const ms = result.finishedAt - result.startedAt;
  process.stdout.write(`[${badge}] ${result.name} (${ms} ms)\n`);
  for (const [key, value] of Object.entries(result.evidence)) {
    process.stdout.write(`        ${key}: ${formatValue(value)}\n`);
  }
  for (const note of result.notes) process.stdout.write(`        ${note}\n`);
  for (const finding of result.findings) {
    process.stdout.write(`        - ${finding.message}${finding.where ? ` @ ${finding.where}` : ''}\n`);
    if (finding.detail) process.stdout.write(`            ${finding.detail}\n`);
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Decide whether this module is the process entry point.
 *
 * A check module must run its check when invoked directly (`node
 * tools/check/<name>.mjs`) and must do nothing when imported by a test or by
 * `tools/verify.mjs`. Without the guard, importing a check module executes it
 * and calls `process.exit` from inside whatever imported it.
 *
 * `process.argv[1]` is the entry-point path as invoked. The comparison is on
 * basename plus "does the entry path end with this file's relative path", which
 * is stable across the three forms Windows produces (drive-letter path, path
 * with backslashes, and an unresolved symlink such as a subst drive).
 *
 * @param {string} moduleUrl this module's `import.meta.url`
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  /** @param {string} value */
  const normalise = (value) => value.replace(/\\/g, '/').toLowerCase();
  const target = normalise(fileURLToPath(moduleUrl));
  const invoked = normalise(entry);
  // Compare the tail below `/tools/` so that a drive-letter form, a backslash
  // form and an unresolved subst/symlink all match the same module.
  const tail = target.slice(target.indexOf('/tools/'));
  if (tail.startsWith('/tools/')) return invoked.endsWith(tail);
  return invoked === target;
}

/**
 * CLI wrapper: run a check module, print it, exit with its code.
 *
 * @param {string} name
 * @param {(ctx: { result: CheckResult, selfTest: boolean, root: string, argv: string[] }) => Promise<void>|void} body
 */
export async function main(name, body) {
  const result = await runCheck(name, body);
  printResult(result);
  process.exit(result.exitCode);
}
