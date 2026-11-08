import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvalBinding, createApprovalLedger } from '../../src/policy/approvals.mjs';
import { decide } from '../../src/policy/decide.mjs';
import { approveCommand } from '../../src/cli/commands/approve.mjs';

/**
 * V-2 approval acceptance (AT-V2-APR-01..03).
 *
 * The claim is not "a grant is recorded" but "a grant is evidence": it names the
 * question it answers, a grant for a *different* question is refused rather than
 * reused, and the log can tell a person answering from a flag granting.
 *
 * The question is seeded through the real ledger API — the same path the runner
 * would use to ask — and the answer is given by the real CLI, in its own process,
 * with `LAIN_HOME` in a temporary directory. A test that called the functions
 * directly would prove the functions work, not that the command a person types
 * does.
 *
 * Like test/cli/run.test.mjs, this file may import `node:child_process`:
 * tools/check/process-boundary.mjs polices `src/` only, and running the shipped
 * entry point is the point of the test.
 */

const CLI = fileURLToPath(new URL('../../src/cli/index.mjs', import.meta.url));
const TASK_FILE = fileURLToPath(new URL('../../examples/hello-task.json', import.meta.url));

/** The question every test asks unless it says otherwise. */
const QUESTION = {
  action: 'workspace.write',
  tool_id: 'run_script',
  target: 'health.json',
  effect_class: 'local_reversible',
  task_id: 'task-01',
};

/** Run the CLI as a real process against a temporary LAIN_HOME. */
function lain(args, home) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAIN_HOME: home, LAIN_DISABLE_GPU_PROBE: '1' },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'lain-approve-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The same, for a test that awaits: the home must outlive the awaited work. */
async function withHomeAsync(fn) {
  const home = mkdtempSync(join(tmpdir(), 'lain-approve-'));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Ask the question durably, the way the runner would, and return the record. */
function ask(home, options = {}) {
  const ledger = createApprovalLedger({
    path: join(home, 'approvals.json'),
    ...(options.now ? { now: options.now } : {}),
  });
  return ledger.request(options.request ?? QUESTION, options.window_ms ? { window_ms: options.window_ms } : {});
}

/** The ledger as another process would read it. */
function stored(home) {
  return JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf8')).approvals;
}

/** @param {string} home @param {string} id */
function storedOne(home, id) {
  return stored(home).find((row) => row.approval_id === id);
}

function jsonOf(result) {
  return JSON.parse(result.stdout);
}

test('AT-V2-APR-01: an approval that timed out is deny_indeterminate, decided_by timeout, and is never granted', () => {
  withHome((home) => {
    // Asked a minute ago with a one-second window: it closed before this process
    // ever read it, which is what "nobody answered" looks like on disk.
    const asked = ask(home, { now: () => Date.now() - 60_000, window_ms: 1_000 });

    const listing = lain(['approve', '--list', '--json'], home);
    assert.equal(listing.status, 0, listing.stderr);
    const [listed] = jsonOf(listing).approvals;
    assert.equal(listed.status, 'timed_out');
    assert.equal(listed.decided_by, 'timeout');
    assert.equal(listed.decided_source, 'timeout');

    // OD-7: a person arriving late cannot grant it, because the question they
    // would be answering is not the question that was asked.
    const late = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', asked.binding,
    ], home);
    assert.equal(late.status, 3, `a timed-out approval must be refused:\n${late.stdout}\n${late.stderr}`);
    assert.match(late.stderr, /timed out|deny_indeterminate/i);
    assert.match(late.stderr, /not retryable/i);
    assert.equal(storedOne(home, asked.approval_id).status, 'timed_out', 'a refused answer must change nothing');

    // The policy arm that reads this state refuses, and does not offer a retry.
    const decision = decide(
      { action: 'tool.invoke', effect_class: 'local_reversible', target: 'health.json' },
      { approval: { status: 'timed_out' } },
    );
    assert.equal(decision.outcome, 'deny_indeterminate');
    assert.equal(decision.reason_code, 'APPROVAL_TIMED_OUT');
    assert.equal(decision.retryable, false, 'deny_indeterminate is never retryable');

    // Positive control: the same runner, the same command, a window still open —
    // so the refusal above is the timeout and not a broken answer path.
    const fresh = ask(home, { request: { ...QUESTION, target: 'in-window.json' } });
    const granted = lain([
      'approve', fresh.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', fresh.binding, '--json',
    ], home);
    assert.equal(granted.status, 0, granted.stderr);
    assert.equal(jsonOf(granted).status, 'granted');
  });
});

test('AT-V2-APR-02: an answer with the wrong digest is refused, and the right digest is accepted', () => {
  withHome((home) => {
    const asked = ask(home);
    const other = ask(home, { request: { ...QUESTION, target: 'different.json' } });

    // The digest is the question's identity, not a random token.
    assert.equal(asked.binding, approvalBinding(QUESTION));
    assert.notEqual(asked.binding, other.binding);

    // The digest a person has to read off the prompt must actually be shown,
    // otherwise nothing can bind an answer to a question.
    const shown = lain(['approve', '--list'], home);
    assert.equal(shown.status, 0, shown.stderr);
    assert.ok(shown.stdout.includes(asked.binding), `the digest must be presented:\n${shown.stdout}`);
    assert.match(shown.stdout, /workspace\.write/);
    assert.match(shown.stdout, /local_reversible/);

    // A grant for a different question does not answer this one.
    const wrongQuestion = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', other.binding,
    ], home);
    assert.equal(wrongQuestion.status, 3, `expected the refusal exit code, got ${wrongQuestion.status}`);
    assert.match(wrongQuestion.stderr, /APPROVAL_BINDING_MISMATCH|does not answer/i);
    assert.equal(storedOne(home, asked.approval_id).status, 'pending', 'a refused answer decides nothing');
    assert.equal(storedOne(home, other.approval_id).status, 'pending');

    // A digest that names no question at all is refused the same way.
    const garbage = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', 'f'.repeat(64),
    ], home);
    assert.equal(garbage.status, 3);
    assert.equal(storedOne(home, asked.approval_id).status, 'pending');

    // An answer that carries no digest is not an answer: nothing binds it.
    const noDigest = lain(['approve', asked.approval_id, '--answer', 'granted', '--by', 'alice'], home);
    assert.equal(noDigest.status, 2, 'a digest-free answer is a usage error, not a grant');
    assert.match(noDigest.stderr, /digest/i);

    // Positive control: the digest that names this question is accepted — and the
    // other question is still open afterwards, which is what makes it bound.
    const right = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', asked.binding, '--json',
    ], home);
    assert.equal(right.status, 0, right.stderr);
    const record = jsonOf(right);
    assert.equal(record.status, 'granted');
    assert.equal(record.binding, asked.binding);
    assert.equal(record.digest_verified, true, 'the answer carried the digest it answered');
    assert.equal(storedOne(home, other.approval_id).status, 'pending', 'one question answered is not both');
  });
});

test('AT-V2-APR-03: a --allow grant is recorded flag-shaped, a prompted grant as a human answer', () => {
  withHome((home) => {
    const flagged = ask(home, { request: { ...QUESTION, target: 'flagged.json' } });
    const prompted = ask(home, { request: { ...QUESTION, target: 'prompted.json' } });

    const flag = lain(['approve', flagged.approval_id, '--allow', '--json'], home);
    assert.equal(flag.status, 0, flag.stderr);
    const flagRecord = jsonOf(flag);
    assert.equal(flagRecord.status, 'granted');
    assert.equal(flagRecord.decided_by, 'flag:cli');
    assert.equal(flagRecord.decided_source, 'flag');
    assert.equal(
      flagRecord.decided_by.startsWith('human:'),
      false,
      'a flag granted this; no person is on record as having answered',
    );

    // Positive control: answering the question, rather than pre-authorising it,
    // is recorded as the person who answered.
    const human = lain([
      'approve', prompted.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', prompted.binding, '--json',
    ], home);
    assert.equal(human.status, 0, human.stderr);
    const humanRecord = jsonOf(human);
    assert.equal(humanRecord.decided_by, 'human:alice');
    assert.equal(humanRecord.decided_source, 'prompt');
    assert.equal(humanRecord.digest_verified, true);
    assert.notEqual(flagRecord.decided_by, humanRecord.decided_by, 'the log must distinguish the two');

    // A flag may say which flag it was, and still never claims to be a person.
    const named = ask(home, { request: { ...QUESTION, target: 'named.json' } });
    const namedRun = lain(['approve', named.approval_id, '--allow', '--by', 'preapproved-hook', '--json'], home);
    assert.equal(namedRun.status, 0, namedRun.stderr);
    assert.equal(jsonOf(namedRun).decided_by, 'flag:preapproved-hook');

    // A denial is a human answer too, and answering with it is not a failure of
    // the command: the refusal is the answer.
    const refused = ask(home, { request: { ...QUESTION, target: 'denied.json' } });
    const denied = lain([
      'approve', refused.approval_id, '--answer', 'denied', '--by', 'alice', '--digest', refused.binding, '--json',
    ], home);
    assert.equal(denied.status, 0, denied.stderr);
    const deniedRecord = jsonOf(denied);
    assert.equal(deniedRecord.status, 'denied');
    assert.equal(deniedRecord.decided_by, 'human:alice');
    assert.equal(deniedRecord.decided_source, 'prompt');

    // Everything is still distinguishable in one listing, in whatever order the
    // listing chooses to return it.
    const listing = jsonOf(lain(['approve', '--list', '--json'], home)).approvals;
    assert.deepEqual(
      listing.map((row) => row.decided_source).sort(),
      ['flag', 'flag', 'prompt', 'prompt'],
      'four answers, each still saying where it came from',
    );
    assert.equal(listing.filter((row) => row.decided_by === 'human:alice').length, 2);
    assert.equal(listing.filter((row) => row.decided_by.startsWith('flag:')).length, 2);
    assert.ok(listing.every((row) => (row.decided_source === 'flag') === row.decided_by.startsWith('flag:')));
  });
});

test('a grant that names no question is refused, and a grant that answers one is recorded once', () => {
  withHome((home) => {
    const asked = ask(home);

    // An answer that names nobody is not evidence that anyone agreed.
    const anonymous = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--digest', asked.binding,
    ], home);
    assert.equal(anonymous.status, 2);
    assert.match(anonymous.stderr, /--by|attribut/i);

    const once = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', asked.binding,
    ], home);
    assert.equal(once.status, 0, once.stderr);

    // The same question cannot be answered twice: a second grant that appears to
    // succeed would mean the first one was not the record of a decision.
    const twice = lain([
      'approve', asked.approval_id, '--answer', 'denied', '--by', 'mallory', '--digest', asked.binding,
    ], home);
    assert.equal(twice.status, 3);
    assert.match(twice.stderr, /already granted/i);
    assert.equal(storedOne(home, asked.approval_id).decided_by, 'human:alice');

    // An unknown id is a refusal, not a crash.
    const missing = lain(['approve', 'no-such-approval', '--answer', 'granted', '--by', 'a', '--digest', asked.binding], home);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /no approval/i);
    assert.equal(/eref|SyntaxError|TypeError/.test(missing.stderr), false, 'explained, not a stack trace');
  });
});

test('a pending question is never answered by a pipe, and saying "y" is the interactive path', async () => {
  await withHomeAsync(async (home) => {
    const asked = ask(home);

    // Non-interactive stdin must not block: the question is shown, the exit is
    // immediate, and the refusal names the flag that would answer it. A hang here
    // would time out the spawn rather than fail an assertion.
    const piped = lain(['approve', asked.approval_id], home);
    assert.equal(piped.status, 2, `expected a usage exit, got ${piped.status}`);
    assert.match(piped.stderr, /not a terminal/i);
    assert.ok(piped.stdout.includes(asked.binding), 'the digest to answer with must still be shown');
    assert.equal(storedOne(home, asked.approval_id).status, 'pending', 'a pipe answered nothing');

    // The interactive path is exercised against the command itself rather than a
    // terminal: 'y' grants, and the answer is attributed to the OS user who owns
    // the terminal, with the digest of the question that was displayed.
    const lines = [];
    const code = await approveCommand({
      positional: [asked.approval_id],
      flags: {},
      io: { out: (line) => lines.push(line), err: (line) => lines.push(`! ${line}`) },
      approvalsPath: join(home, 'approvals.json'),
      isTty: true,
      ask: async () => 'y',
    });
    assert.equal(code, 0, lines.join('\n'));
    const answered = storedOne(home, asked.approval_id);
    assert.equal(answered.status, 'granted');
    assert.equal(answered.decided_by, `human:${process.env.USERNAME ?? process.env.USER ?? ''}`);
    assert.equal(answered.digest_verified, true);
    assert.ok(lines.some((line) => line.includes(asked.binding)), 'the question was displayed before it was answered');

    // Positive control for the refusal above: the same question, answered "n",
    // is denied rather than ignored — and a non-answer is refused, not treated as
    // consent.
    const second = ask(home, { request: { ...QUESTION, target: 'second.json' } });
    const noLines = [];
    const denied = await approveCommand({
      positional: [second.approval_id],
      flags: {},
      io: { out: (line) => noLines.push(line), err: (line) => noLines.push(`! ${line}`) },
      approvalsPath: join(home, 'approvals.json'),
      isTty: true,
      ask: async () => 'n',
    });
    assert.equal(denied, 0, noLines.join('\n'));
    assert.equal(storedOne(home, second.approval_id).status, 'denied');

    const third = ask(home, { request: { ...QUESTION, target: 'third.json' } });
    const empty = await approveCommand({
      positional: [third.approval_id],
      flags: {},
      io: { out: () => {}, err: (line) => noLines.push(`! ${line}`) },
      approvalsPath: join(home, 'approvals.json'),
      isTty: true,
      ask: async () => '',
    });
    assert.equal(empty, 3, 'an empty answer is refusal, not consent');
    assert.equal(storedOne(home, third.approval_id).status, 'pending');
  });
});

test('the ledger refuses to present a question that disagrees with its own digest', () => {
  withHome((home) => {
    const asked = ask(home);

    // Positive control: the untouched store answers.
    assert.equal(lain(['approve', '--list', '--json'], home).status, 0);

    // Tamper with the question while leaving the digest alone: the record now
    // claims to be a grant for something it was never asked about. Presenting it
    // would invite a person to answer the wrong question.
    const path = join(home, 'approvals.json');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.approvals[0].request.target = 'somewhere-else.json';
    writeFileSync(path, JSON.stringify(file, null, 2));

    const tampered = lain(['approve', '--list', '--json'], home);
    assert.equal(tampered.status, 4, `a tampered record is a failure, not a refusal:\n${tampered.stdout}${tampered.stderr}`);
    assert.match(tampered.stderr, /APPROVAL_STORE_TAMPERED|does not match its digest/i);
    assert.equal(/eref|SyntaxError|TypeError/.test(tampered.stderr), false, 'explained, not a stack trace');

    // And the id cannot be answered through the tampered store either.
    const answer = lain([
      'approve', asked.approval_id, '--answer', 'granted', '--by', 'alice', '--digest', asked.binding,
    ], home);
    assert.equal(answer.status, 4);
  });
});

test('AT-V2-APR-03 (task run --allow): the flag leaves a ledger record that names the flag, not a person', () => {
  withHome((home) => {
    const run = lain(['task', 'run', '--task', TASK_FILE, '--allow', 'run_script', '--json'], home);
    assert.equal(run.status, 0, run.stderr);
    const outcome = jsonOf(run);
    assert.equal(outcome.state, 'completed', `the flagged tool must still run: ${JSON.stringify(outcome.admission)}`);
    assert.equal(outcome.invocation.executed, true);

    // The grant is on disk, bound to the question it answered. Before this
    // change no record existed at all: the runner synthesised a granted approval
    // with the id "cli-allow", which nothing could look up and nothing could audit.
    const store = JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf8'));
    assert.equal(store.approvals.length, 1, 'a --allow run must leave exactly one approval record');
    const [record] = store.approvals;
    assert.equal(record.status, 'granted');
    assert.equal(record.decided_by, 'flag:cli');
    assert.equal(record.decided_source, 'flag');
    assert.equal(record.request.action, 'tool.run_script');
    assert.equal(record.request.tool_id, 'run_script');
    assert.equal(record.request.task_id, outcome.task_id, 'the question names the task it was asked for');
    assert.equal(record.binding, approvalBinding(record.request), 'the record is bound to the question it shows');

    // Not the shape of a human grant: nobody answered, and no digest was carried.
    assert.equal(record.decided_by.startsWith('human:'), false);
    assert.notEqual(record.decided_source, 'prompt');
    assert.notEqual(record.digest_verified, true, 'a flag carries no answer to verify');

    // The record is readable through the command a person would actually use,
    // which is what makes it evidence rather than a file that happens to exist.
    const listed = lain(['approve', '--list', '--json'], home);
    assert.equal(listed.status, 0, listed.stderr);
    const [shown] = jsonOf(listed).approvals;
    assert.equal(shown.approval_id, record.approval_id);
    assert.equal(shown.decided_by, 'flag:cli');

    // A named flag says which flag it was, and still claims no person.
    const named = lain([
      'task', 'run', '--task', TASK_FILE, '--allow', 'run_script', '--by', 'preapproved-hook', '--json',
    ], home);
    assert.equal(named.status, 0, named.stderr);
    assert.equal(jsonOf(named).state, 'completed');
    const after = JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf8')).approvals;
    assert.equal(after.length, 2, 'a second run is a second question, not a reuse of the first');
    assert.equal(after.filter((row) => row.decided_by === 'flag:preapproved-hook').length, 1);
    assert.equal(after.filter((row) => row.decided_by.startsWith('human:')).length, 0);
  });
});
