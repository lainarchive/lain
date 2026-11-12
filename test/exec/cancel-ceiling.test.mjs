// The phase nothing else reaches: a cancel arriving while the output ceiling is
// already being enforced.
//
// The ceiling path in job_host.py is a 10 ms poll that terminates the job the
// moment the tool has written past the cap, so "cancel during truncation" is a
// window a few milliseconds wide. A test that hoped to land inside it would be a
// timing test that passes for the wrong reason on a fast machine and flakes on a
// slow one. The window is therefore opened deliberately: a spec may carry
// `ceiling_hold_ms`, and when the cap is breached the helper first writes a note
// saying so and then waits - still watching for a natural exit - before it
// terminates anything. The note file is the barrier: the test waits for the
// note, kills the supervisor inside the hold, and asserts the run settled long
// before the hold could have expired on its own.
//
// The helper spec builder in src/exec/job.mjs does not forward `ceiling_hold_ms`
// or `ceiling_note_path` (a test hook has no business on the production path),
// so this test spawns the supervisor the way the seam spawns it - same
// interpreter, same helper, same `--spec`/`--result` arguments - and feeds
// deriveOutcome the evidence itself, rather than inventing a classification.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_HELPER, deriveOutcome, resolvePython } from '../../src/exec/job.mjs';

const PYTHON = resolvePython();
const skip = PYTHON.ok ? false : `no interpreter at ${PYTHON.candidate}`;
const NODE = process.execPath;
const ROOT = mkdtempSync(join(tmpdir(), 'lain-cancel-ceiling-'));

const CAP = 8192;
// The window the cancel test kills inside: long enough that "it settled well
// inside it" cannot be luck, short enough that a wedged run fails the suite
// instead of hanging it.
const HOLD_MS = 10_000;
// The control arm has to wait its hold out on purpose, so it uses a short one.
const CONTROL_HOLD_MS = 1_000;
const SUPERVISOR_MS = 60_000;

const TOOL_PATH = join(ROOT, 'ceiling-tool.cjs');
writeFileSync(TOOL_PATH, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// The tree under the supervisor is what has to be gone afterwards, so the tool
// records its own pid and its child's pid before it writes the output that
// trips the ceiling.
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, descendant: kid.pid }));

const chunk = 'x'.repeat(4095) + '\\n';
for (let i = 0; i < 64; i += 1) process.stdout.write(chunk);
// Stay alive: the ceiling is what stops this run, not its own exit.
setInterval(() => {}, 1000);
`);

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * @param {number} pid
 */
function pidAlive(pid) {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
    { encoding: 'utf8', windowsHide: true });
  return (out.stdout ?? '').includes(String(pid));
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return predicate();
}

/**
 * Drive one supervisor by hand, optionally killing it inside the ceiling hold.
 *
 * @param {string} label
 * @param {boolean} killDuringHold
 * @param {number} holdMs
 */
async function drive(label, killDuringHold, holdMs) {
  const dir = join(ROOT, label);
  const specPath = join(dir, 'spec.json');
  const resultPath = join(dir, 'result.json');
  const notePath = join(dir, 'ceiling-note.json');
  const pidPath = join(dir, 'pids.json');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(specPath, JSON.stringify({
    command: NODE,
    args: [TOOL_PATH, pidPath],
    cwd: ROOT,
    output_bytes: CAP,
    supervisor_ms: SUPERVISOR_MS,
    ceiling_hold_ms: holdMs,
    ceiling_note_path: notePath,
  }, null, 2));

  const startedAt = Date.now();
  const child = spawn(PYTHON.candidate, [DEFAULT_HELPER, '--spec', specPath, '--result', resultPath],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let supervisorStderr = '';
  child.stderr.on('data', (chunk) => { supervisorStderr += chunk.toString('utf8'); });
  child.stdout.resume();
  const closed = new Promise((done) => { child.on('close', (code) => done(code)); });

  let noteAt = null;
  let killed = false;
  if (killDuringHold) {
    const appeared = await waitFor(() => existsSync(notePath), 30_000);
    assert.equal(appeared, true, `${label}: the ceiling note never appeared, so the hold was never entered`);
    noteAt = Date.now();
    // Only a kill that lands counts: if the supervisor had already exited,
    // child.kill() returns false and this run is not a cancellation.
    killed = child.kill();
  }

  const supervisorExit = await closed;
  const settledAt = Date.now();
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const note = existsSync(notePath) ? JSON.parse(readFileSync(notePath, 'utf8')) : null;
  const outcome = deriveOutcome({ result, supervisorExit, killedByCaller: killed, timedOut: false });
  const pids = existsSync(pidPath) ? JSON.parse(readFileSync(pidPath, 'utf8')) : null;
  return {
    note, noteAt, result, outcome, pids, killed, supervisorStderr, holdMs,
    supervisorPid: child.pid,
    settledMs: settledAt - startedAt,
    afterNoteMs: noteAt === null ? null : settledAt - noteAt,
  };
}

test('a cancel inside the output ceiling hold is a cancellation, and the tree is gone', { skip }, async () => {
  const run = await drive('cancel', true, HOLD_MS);

  // (a) The note is proof that the run reached the ceiling and entered the hold
  // - not merely that it ended with a status this test was willing to accept.
  assert.equal(run.note.at, 'ceiling_breached');
  assert.equal(run.note.cap, CAP);
  assert.equal(run.note.hold_ms, HOLD_MS);
  assert.equal(run.note.stdout_bytes > CAP, true,
    `the note says the cap was breached: ${JSON.stringify(run.note)}`);

  // (b) It settled inside the hold, so the cancel interrupted the run. A run
  // that let the hold expire on its own takes at least HOLD_MS.
  assert.equal(run.killed, true, 'the supervisor was still alive when the kill was sent');
  assert.equal(run.settledMs < HOLD_MS, true,
    `the run must not have taken the full hold: ${run.settledMs} ms of ${HOLD_MS}`);
  assert.equal(run.afterNoteMs < HOLD_MS / 2, true,
    `the kill must land well inside the hold: ${run.afterNoteMs} ms after the note`);

  // (c) The contract's own classification, from the evidence: a kill that landed
  // outranks the helper's account of itself, and the helper never got to write
  // one - it died in the hold, before any result file existed.
  assert.equal(run.result, null);
  assert.deepEqual(run.outcome,
    { status: 'killed_by_supervisor', killed_by: 'cancel', kill_reason: 'cancel' });
  // The seam reports truncation only when the helper's account says so, and on
  // this arm there is no account. That absence is the measured limitation
  // recorded in docs/research/v3-read-isolation/cancellation-phases.md.
  assert.equal(run.result?.output_truncated ?? false, false);

  // No process survives the cancel: supervisor, tool, and the tool's child.
  assert.notEqual(run.pids, null, 'the tool recorded its tree before producing output');
  assert.equal(typeof run.pids.pid, 'number');
  assert.equal(typeof run.pids.descendant, 'number');
  assert.equal(await waitFor(() => !pidAlive(run.supervisorPid), 5_000), true,
    `the supervisor ${run.supervisorPid} is still alive`);
  assert.equal(await waitFor(() => !pidAlive(run.pids.pid), 5_000), true,
    `the tool ${run.pids.pid} is still alive`);
  assert.equal(await waitFor(() => !pidAlive(run.pids.descendant), 5_000), true,
    `the tool's child ${run.pids.descendant} is still alive`);
});

test('control: the same run without a cancel truncates, and the hold really holds', { skip }, async () => {
  const run = await drive('truncate', false, CONTROL_HOLD_MS);

  assert.equal(run.note.at, 'ceiling_breached');
  assert.equal(run.note.hold_ms, CONTROL_HOLD_MS);
  assert.equal(run.note.stdout_bytes > CAP, true);

  // The positive control for the phase above: the same tool under the same
  // ceiling, left alone, reports that it truncated. Without this, the cancelled
  // arm would only prove that some run ended.
  assert.equal(run.result.ok, true);
  assert.equal(run.result.output_truncated, true);
  assert.equal(run.result.kill_reason, 'output_ceiling');
  assert.equal(run.result.exit_code, 0xc0000044);
  assert.deepEqual(run.outcome,
    { status: 'killed_by_supervisor', killed_by: null, kill_reason: 'output_ceiling' });

  // And the window the other test kills inside is real: no cancel, no early exit.
  assert.equal(run.settledMs >= CONTROL_HOLD_MS, true,
    `the hold must actually hold: ${run.settledMs} ms of ${CONTROL_HOLD_MS}`);

  // The ceiling kill reaps the tree as well, which is why killing the supervisor
  // is the whole of the cancel path.
  assert.notEqual(run.pids, null);
  assert.equal(await waitFor(() => !pidAlive(run.supervisorPid), 5_000), true);
  assert.equal(await waitFor(() => !pidAlive(run.pids.pid), 5_000), true);
  assert.equal(await waitFor(() => !pidAlive(run.pids.descendant), 5_000), true);
});
