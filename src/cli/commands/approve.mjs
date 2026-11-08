/**
 * `lain approve` — ask and answer one bound approval question.
 *
 * The point of this command is that a grant is evidence. It is not a button that
 * makes a refusal go away, so:
 *
 *   - The question is presented whole: action, tool, target, effect class and the
 *     request digest. An approval you cannot read is not an approval you gave.
 *   - An answer must carry the digest of the question it answers. `--answer`
 *     refuses without one, and a digest that belongs to a different question is
 *     refused, not reused (a stale grant is not a grant).
 *   - `--allow` still exists for non-interactive use and is recorded as a
 *     flag-shaped grant (`decided_by: 'flag:...'`), never as a human answer. The
 *     log has to be able to say whether a person agreed or a flag did.
 *   - A window that closed is `deny_indeterminate` and is refused forever. There
 *     is no `--retry` here, because "wait forever" is not an answer either.
 *
 * Exit codes follow the CLI: ok 0, usage 2, refused 3, failed 4. A recorded
 * `denied` is a successful answer and exits 0 — the refusal is the *answer*, not
 * a failure of the command.
 */
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { approvalMsRemaining, createApprovalLedger, decisionSource, TIMEOUT_DECIDED_BY } from '../../policy/approvals.mjs';

/**
 * Kept equal to `EXIT` in `../index.mjs`. Imported rather than redeclared would
 * mean a cycle between the command and the dispatcher that calls it, and the
 * four numbers are part of the CLI's frozen contract, not of this file's design.
 */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain approve — answer one bound approval question

  lain approve <approval_id> [--json]
      Show the question and the time remaining, then answer it interactively.

  lain approve --list [--json]
      List every approval: question, status, and time remaining.

  lain approve <approval_id> --answer granted|denied --by <name> --digest <hex> [--json]
      Answer without a prompt. The digest is required: an answer that does not
      name the question it answers is not an answer.

  lain approve <approval_id> --allow [--by <flag_source>] [--json]
      Grant as a flag, recorded as flag-shaped. This is not a human answer and
      the log will say so.
`;

/** @type {Set<string>} */
const ANSWER_WORDS = new Set(['granted', 'denied']);
/** @type {Set<string>} */
const GRANT_WORDS = new Set(['y', 'yes', 'granted', 'grant', 'allow']);
/** @type {Set<string>} */
const DENY_WORDS = new Set(['n', 'no', 'denied', 'deny']);

/**
 * @param {number} ms
 * @returns {string}
 */
function formatRemaining(ms) {
  if (ms <= 0) return 'expired';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The question, as a person needs to read it. Returns lines rather than printing
 * so that `--json` mode can stay exactly one JSON document on stdout.
 *
 * @param {import('../../policy/approvals.mjs').ApprovalRecord} record
 * @param {number} at
 * @returns {string[]}
 */
export function describeApproval(record, at = Date.now()) {
  const remaining = approvalMsRemaining(record, at);
  const lines = [
    `approval   ${record.approval_id}`,
    `status     ${record.status}`,
    `action     ${record.request.action}`,
    `tool       ${record.request.tool_id ?? '-'}`,
    `target     ${record.request.target ?? '-'}`,
    `effect     ${record.request.effect_class}`,
    `task       ${record.request.task_id ?? '-'}`,
    `digest     ${record.binding}`,
    `requested  ${record.requested_at}`,
    `expires    ${record.expires_at}  (${formatRemaining(remaining)})`,
  ];
  if (record.decided_by) {
    const source = decisionSource(record.decided_by);
    const how = source === 'prompt' ? 'a person answered' : source === 'flag' ? 'a flag granted this' : 'nobody answered';
    lines.push(`decided    ${record.decided_by}  (${how}${record.digest_verified ? ', digest verified' : ''})`);
  }
  if (record.status === 'timed_out') {
    lines.push('outcome    deny_indeterminate — the window closed with no answer; not retryable (OD-7)');
  }
  if (record.status === 'pending') {
    lines.push(
      `answer     ${record.approval_id} --answer granted|denied --by <your name> --digest ${record.binding}`,
    );
  }
  return lines;
}

/**
 * @param {import('../../policy/approvals.mjs').ApprovalRecord} record
 * @param {number} at the instant "time remaining" is measured from
 * @returns {object} the record plus the derived fields the JSON view promises
 */
function jsonView(record, at) {
  return {
    ...record,
    decided_source: decisionSource(record.decided_by),
    ms_remaining: approvalMsRemaining(record, at),
  };
}

/**
 * Who is answering at this terminal. An answer that names nobody is not evidence
 * that a person agreed, so an unnameable terminal refuses instead of recording an
 * anonymous grant.
 *
 * @returns {string|null}
 */
function terminalUser() {
  const fromEnv = process.env.USERNAME ?? process.env.USER;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const name = userInfo().username;
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read one line from the terminal. Only reached when stdin is a TTY: a pipe is
 * not a person, and blocking forever on one is how a CLI hangs a test run.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
async function askTerminal(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {unknown} err
 * @returns {string|null} the StoreError code, when there is one
 */
function codeOf(err) {
  return err && typeof err === 'object' && typeof (/** @type {{code?: unknown}} */ (err).code) === 'string'
    ? String(/** @type {{code: string}} */ (err).code)
    : null;
}

/**
 * Which exit code a ledger refusal earns. A question that cannot be answered
 * honestly is a refusal (3); a store that cannot be read is a failure (4), not a
 * refusal, because nothing was decided.
 *
 * @param {string|null} code
 * @returns {number}
 */
function exitForCode(code) {
  switch (code) {
    case 'APPROVAL_NOT_FOUND':
    case 'APPROVAL_ALREADY_ANSWERED':
    case 'APPROVAL_BINDING_MISMATCH':
      return EXIT.refused;
    case 'APPROVAL_STATUS_INVALID':
    case 'APPROVAL_SOURCE_INVALID':
    case 'APPROVAL_UNATTRIBUTED':
      return EXIT.usage;
    default:
      return EXIT.failed;
  }
}

/**
 * @param {{
 *   positional?: string[],
 *   flags?: Record<string, string|boolean>,
 *   io: {out: (line: string) => void, err: (line: string) => void},
 *   approvalsPath: string,
 *   now?: () => number,
 *   ask?: (question: string) => Promise<string>,
 *   isTty?: boolean,
 * }} input
 * @returns {Promise<number>} exit code
 */
export async function approveCommand(input) {
  const { io, approvalsPath } = input;
  const positional = input.positional ?? [];
  const flags = input.flags ?? {};
  const now = input.now ?? Date.now;
  const ask = input.ask ?? askTerminal;
  const isTty = input.isTty ?? Boolean(process.stdin.isTTY);
  const json = Boolean(flags.json);

  if (!approvalsPath) {
    io.err('failed: no approval store path was resolved');
    return EXIT.failed;
  }

  const wantsList = Boolean(flags.list);
  const wantsAllow = Boolean(flags.allow);
  const wantsAnswer = flags.answer !== undefined;
  const id = positional[0];

  if (!wantsList && !id) {
    io.err(USAGE);
    return EXIT.usage;
  }
  if (wantsList && id) {
    io.err('usage: --list does not take an approval id');
    return EXIT.usage;
  }
  if (wantsAllow && wantsAnswer) {
    io.err('usage: --allow and --answer are different claims; pass one');
    return EXIT.usage;
  }
  if (typeof flags.answer === 'string' && !ANSWER_WORDS.has(flags.answer)) {
    io.err(`usage: --answer is granted or denied, not ${flags.answer}`);
    return EXIT.usage;
  }
  if (wantsAnswer && !wantsAllow) {
    if (typeof flags.by !== 'string' || flags.by.length === 0) {
      io.err('usage: --answer must name who gave it (--by <name>); an unattributed grant is not evidence');
      return EXIT.usage;
    }
    if (typeof flags.digest !== 'string' || flags.digest.length === 0) {
      io.err('usage: --answer must carry the digest of the question it answers (--digest <hex>)');
      return EXIT.usage;
    }
  }
  if (wantsAllow && typeof flags.by === 'string' && flags.by.length === 0) {
    io.err('usage: --by with --allow names the flag source, and must not be empty');
    return EXIT.usage;
  }
  /** @type {ReturnType<typeof createApprovalLedger>} */
  let ledger;
  try {
    ledger = createApprovalLedger({ path: approvalsPath, now });
  } catch (err) {
    // A store whose questions no longer match their digests cannot be presented:
    // offering one for answer would be asking about something nobody asked.
    io.err(`failed: ${codeOf(err) ?? 'APPROVAL_STORE_UNREADABLE'} — ${messageOf(err)}`);
    return EXIT.failed;
  }

  try {
    if (wantsList) {
      const records = ledger.list();
      if (json) io.out(JSON.stringify({ approvals: records.map((r) => jsonView(r, now())) }, null, 2));
      else if (records.length === 0) io.out('no approvals have been asked');
      else for (const record of records) for (const line of describeApproval(record, now())) io.out(line);
      return EXIT.ok;
    }

    const record = ledger.get(String(id));
    if (!record) {
      io.err(`refused: no approval ${id}`);
      return EXIT.refused;
    }
    if (record.status === 'timed_out') {
      if (json) io.out(JSON.stringify(jsonView(record, now()), null, 2));
      else for (const line of describeApproval(record, now())) io.out(line);
      io.err(`refused: approval ${id} timed out (${TIMEOUT_DECIDED_BY}); deny_indeterminate is not retryable`);
      return EXIT.refused;
    }
    if (record.status !== 'pending') {
      if (json) io.out(JSON.stringify(jsonView(record, now()), null, 2));
      else for (const line of describeApproval(record, now())) io.out(line);
      io.err(`refused: approval ${id} is already ${record.status} (${record.decided_by})`);
      return EXIT.refused;
    }

    // The question goes on stdout before the answer is read, so a person answers
    // something they were shown rather than something they assumed.
    if (!json) for (const line of describeApproval(record, now())) io.out(line);

    /** @type {'granted'|'denied'} */
    let status;
    /** @type {{by?: string, digest?: string|null, source?: 'prompt'|'flag'}} */
    let meta;

    if (wantsAllow) {
      status = 'granted';
      meta = {
        by: typeof flags.by === 'string' ? flags.by : 'cli',
        digest: typeof flags.digest === 'string' ? flags.digest : null,
        source: 'flag',
      };
    } else if (wantsAnswer) {
      status = /** @type {'granted'|'denied'} */ (flags.answer);
      meta = { by: String(flags.by), digest: String(flags.digest), source: 'prompt' };
    } else {
      // A pipe is not a person, and blocking on one is how a CLI hangs a test run.
      // The question has already been printed, so the digest needed to answer it
      // is on screen even though the answer cannot be read from here.
      if (!isTty) {
        io.err('refused: stdin is not a terminal, so there is nobody to ask.');
        io.err(
          `         answer without a prompt: lain approve ${record.approval_id} ` +
            `--answer granted --by <name> --digest ${record.binding}`,
        );
        return EXIT.usage;
      }
      const by = terminalUser();
      if (!by) {
        io.err('refused: this terminal cannot name who is answering; use --answer granted|denied --by <name>');
        return EXIT.usage;
      }
      const reply = (await ask(`answer ${record.approval_id} [y/n] > `)).trim().toLowerCase();
      if (GRANT_WORDS.has(reply)) status = 'granted';
      else if (DENY_WORDS.has(reply)) status = 'denied';
      else {
        io.err(`refused: ${reply === '' ? 'no answer' : `"${reply}" is not an answer`}; absence of an answer is refusal, not consent`);
        return EXIT.refused;
      }
      // The human answered the question that was just displayed, so the digest of
      // that question is the digest of their answer.
      meta = { by, digest: record.binding, source: 'prompt' };
    }

    const answered = ledger.answer(record.approval_id, status, meta);
    if (json) io.out(JSON.stringify(jsonView(answered, now()), null, 2));
    else {
      io.out(`status     ${answered.status}`);
      io.out(`decided    ${answered.decided_by}`);
      io.out(`digest     ${answered.digest_verified ? `verified against ${answered.binding}` : 'not carried by this answer'}`);
    }
    return EXIT.ok;
  } catch (err) {
    const code = codeOf(err);
    if (code) {
      io.err(`refused: ${code} — ${messageOf(err)}`);
      return exitForCode(code);
    }
    io.err(`failed: ${messageOf(err)}`);
    return EXIT.failed;
  }
}
