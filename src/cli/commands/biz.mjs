// `lain biz <create|validate|approve|show|list>` — Phase 8 Business Intelligence CLI
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPPORTUNITY_STATUSES, openOpportunityStore } from '../../biz/opportunity.mjs';

/** Kept equal to `EXIT` in `../index.mjs` to avoid circular imports. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const VALID_STATUSES = new Set(OPPORTUNITY_STATUSES);
const REFUSED_CODES = new Set([
  'APPROVAL_REQUIRES_VALIDATION',
  'OPPORTUNITY_REJECTED',
  'INVALID_STATE',
  'OPPORTUNITY_EXISTS',
]);

const USAGE = `lain biz — evaluate, validate, and approve business opportunities

  lain biz create <opportunity.json> [--lain-home <dir>] [--json]
  lain biz validate <id> --evidence <text> --by <who> [--fail] [--lain-home <dir>] [--json]
  lain biz approve <id> --by <who> --max-spend <usd> [--lain-home <dir>] [--json]
  lain biz show <id> [--lain-home <dir>] [--json]
  lain biz list [--status draft|validated|approved|rejected] [--lain-home <dir>] [--json]
`;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} key
 * @returns {string | undefined}
 */
function stringFlag(flags, key) {
  return nonEmpty(flags[key]);
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string | undefined} dbPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function resolveDbPath(flags, dbPath, env = process.env) {
  if (typeof dbPath === 'string' && dbPath.trim() !== '') return dbPath;
  if (flags['lain-home'] === true) return null;
  if (typeof flags['lain-home'] === 'string' && flags['lain-home'].trim() === '') return null;
  const home = stringFlag(flags, 'lain-home') || env.LAIN_HOME || join(homedir(), '.lain');
  return join(home, 'biz.db');
}

/**
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {unknown} err
 * @returns {number}
 */
function handleBizError(io, err) {
  const e = /** @type {Error & { code?: string }} */ (err);
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = e instanceof Error ? e.message : String(err);
  if (REFUSED_CODES.has(code)) {
    io.err(`refused: ${code} — ${message}`);
    return EXIT.refused;
  }
  const prefix = code ? `${code} — ` : '';
  io.err(`failed: ${prefix}${message}`);
  return EXIT.failed;
}

/**
 * @param {string} targetPath
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {(store: ReturnType<typeof openOpportunityStore>) => number} fn
 * @returns {number}
 */
function withStore(targetPath, io, fn) {
  /** @type {ReturnType<typeof openOpportunityStore> | undefined} */
  let store;
  try {
    store = openOpportunityStore({ path: targetPath });
    return fn(store);
  } catch (err) {
    return handleBizError(io, err);
  } finally {
    store?.close();
  }
}

/**
 * @param {string | undefined} filePath
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @returns {{ ok: true, raw: Record<string, unknown> } | { ok: false, code: number }}
 */
function readOpportunityFile(filePath, io) {
  if (!nonEmpty(filePath)) {
    io.err(USAGE);
    return { ok: false, code: EXIT.usage };
  }
  try {
    const raw = JSON.parse(readFileSync(/** @type {string} */ (filePath), 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      io.err('usage: opportunity file must contain a JSON object');
      return { ok: false, code: EXIT.usage };
    }
    return { ok: true, raw };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`usage: cannot read opportunity file — ${reason}`);
    return { ok: false, code: EXIT.usage };
  }
}

/**
 * @param {{
 *   command?: string,
 *   positional?: string[],
 *   flags: Record<string, string|boolean>,
 *   io: { out: (line: string) => void, err: (line: string) => void },
 *   dbPath?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} args
 * @returns {number}
 */
export function bizCommand({ command, positional = [], flags, io, dbPath, env = process.env }) {
  const asJson = Boolean(flags.json);
  const targetPath = resolveDbPath(flags, dbPath, env);
  if (targetPath === null) {
    io.err(USAGE);
    return EXIT.usage;
  }

  if (command === 'create') {
    const loaded = readOpportunityFile(positional[0], io);
    if (!loaded.ok) return loaded.code;

    return withStore(targetPath, io, (store) => {
      const record = store.createOpportunity(/** @type {any} */ (loaded.raw));
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`created ${record.id} status=${record.status} category=${record.category} title=${record.title}`);
      return EXIT.ok;
    });
  }

  if (command === 'validate') {
    const id = nonEmpty(positional[0]);
    const evidence = stringFlag(flags, 'evidence');
    const by = stringFlag(flags, 'by');
    if (!id || !evidence || !by || (flags.fail !== undefined && flags.fail !== true)) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const passed = flags.fail !== true;

    return withStore(targetPath, io, (store) => {
      const record = store.recordValidation(id, { evidence, passed, reviewer: by });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`${record.status} ${record.id} by=${record.validated_by}`);
      return EXIT.ok;
    });
  }

  if (command === 'approve') {
    const id = nonEmpty(positional[0]);
    const by = stringFlag(flags, 'by');
    const rawSpend = flags['max-spend'];
    if (!id || !by || typeof rawSpend !== 'string' || rawSpend.trim() === '') {
      io.err(USAGE);
      return EXIT.usage;
    }
    const maxSpendUsd = Number(rawSpend);
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd < 0) {
      io.err(USAGE);
      return EXIT.usage;
    }

    return withStore(targetPath, io, (store) => {
      const record = store.approveCommitment(id, { approvedBy: by, maxSpendUsd });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`approved ${record.id} by=${record.approved_by} max_spend_usd=${record.approved_spend_usd} status=${record.status}`);
      return EXIT.ok;
    });
  }

  if (command === 'show') {
    const id = nonEmpty(positional[0])?.trim();
    if (!id) {
      io.err(USAGE);
      return EXIT.usage;
    }

    return withStore(targetPath, io, (store) => {
      const record = store.get(id);
      if (!record) {
        io.err(`failed: OPPORTUNITY_NOT_FOUND — opportunity ${id} not found`);
        return EXIT.failed;
      }
      if (asJson) {
        io.out(JSON.stringify(record, null, 2));
      } else {
        io.out(`id                  ${record.id}`);
        io.out(`title               ${record.title}`);
        io.out(`category            ${record.category}`);
        io.out(`status              ${record.status}`);
        io.out(`hypothesis          ${record.hypothesis}`);
        io.out(`approved_spend_usd  ${record.approved_spend_usd}`);
      }
      return EXIT.ok;
    });
  }

  if (command === 'list') {
    /** @type {'draft' | 'validated' | 'approved' | 'rejected' | undefined} */
    let status;
    if (flags.status !== undefined) {
      if (typeof flags.status !== 'string' || !VALID_STATUSES.has(flags.status)) {
        io.err(USAGE);
        return EXIT.usage;
      }
      status = /** @type {'draft' | 'validated' | 'approved' | 'rejected'} */ (flags.status);
    }

    return withStore(targetPath, io, (store) => {
      const rows = store.list(status ? { status } : {});
      if (asJson) {
        io.out(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        io.out('no opportunities found');
      } else {
        for (const r of rows) {
          io.out(`${r.id}  [${r.status}] ${r.title} (${r.category})`);
        }
      }
      return EXIT.ok;
    });
  }

  io.err(USAGE);
  return EXIT.usage;
}
