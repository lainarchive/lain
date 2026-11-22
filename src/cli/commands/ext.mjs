// `lain ext <validate|inspect|register|approve|activate|revoke|list>` — Phase 6 Extension CLI
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXT_STATES, inspectPermissions, openExtensionRegistry, validateManifest } from '../../ext/contract.mjs';

/** Kept equal to `EXIT` in `../index.mjs` to avoid circular imports. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const VALID_STATES = new Set(EXT_STATES);
const REFUSED_CODES = new Set([
  'EXTENSION_NOT_APPROVED',
  'EXTENSION_REVOKED',
  'INVALID_STATE',
  'EXTENSION_EXISTS',
]);

const USAGE = `lain ext — validate, inspect, and manage native extensions

  lain ext validate <manifest.json> [--json]
  lain ext inspect <manifest.json> [--json]
  lain ext register <manifest.json> --source <s> [--lain-home <dir>] [--json]
  lain ext approve <id> --by <who> [--lain-home <dir>] [--json]
  lain ext activate <id> [--lain-home <dir>] [--json]
  lain ext revoke <id> --by <who> [--reason <r>] [--lain-home <dir>] [--json]
  lain ext list [--state candidate|approved|active|revoked] [--lain-home <dir>] [--json]
`;

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} key
 * @returns {string | undefined}
 */
function stringFlag(flags, key) {
  const value = flags[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string | undefined} dbPath
 * @returns {string | null}
 */
function resolveDbPath(flags, dbPath) {
  if (typeof dbPath === 'string' && dbPath.trim() !== '') return dbPath;
  if (flags['lain-home'] === true || flags['lain-home'] === '') return null;
  const home = stringFlag(flags, 'lain-home') || process.env.LAIN_HOME || join(homedir(), '.lain');
  return join(home, 'extensions.db');
}

/**
 * @param {string} targetPath
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {(reg: ReturnType<typeof openExtensionRegistry>) => number} fn
 * @returns {number}
 */
function withRegistry(targetPath, io, fn) {
  /** @type {ReturnType<typeof openExtensionRegistry> | undefined} */
  let reg;
  try {
    reg = openExtensionRegistry({ path: targetPath });
    return fn(reg);
  } catch (err) {
    return handleExtError(io, err);
  } finally {
    reg?.close();
  }
}

/**
 * @param {string | undefined} manifestPath
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @returns {{ ok: true, raw: unknown } | { ok: false, code: number }}
 */
function readManifestFile(manifestPath, io) {
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
    io.err(USAGE);
    return { ok: false, code: EXIT.usage };
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return { ok: true, raw };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`usage: cannot read manifest file — ${reason}`);
    return { ok: false, code: EXIT.usage };
  }
}

/**
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {unknown} err
 * @returns {number}
 */
function handleExtError(io, err) {
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
 * @param {{
 *   command?: string,
 *   positional?: string[],
 *   flags: Record<string, string|boolean>,
 *   io: { out: (line: string) => void, err: (line: string) => void },
 *   dbPath?: string,
 * }} args
 * @returns {number}
 */
export function extCommand({ command, positional = [], flags, io, dbPath }) {
  const asJson = Boolean(flags.json);

  if (command === 'validate') {
    const loaded = readManifestFile(positional[0], io);
    if (!loaded.ok) return loaded.code;
    const result = validateManifest(loaded.raw);
    if (result.ok) {
      if (asJson) io.out(JSON.stringify(result, null, 2));
      else io.out(`valid ${result.manifest.id} (${result.manifest.kind}, ${result.manifest.effect_class})`);
      return EXIT.ok;
    }
    if (asJson) io.out(JSON.stringify(result, null, 2));
    else io.err(`invalid: ${result.errors.join('; ')}`);
    return EXIT.failed;
  }

  if (command === 'inspect') {
    const loaded = readManifestFile(positional[0], io);
    if (!loaded.ok) return loaded.code;
    try {
      const report = inspectPermissions(loaded.raw);
      if (asJson) {
        io.out(JSON.stringify(report, null, 2));
      } else {
        io.out(`id            ${report.id}`);
        io.out(`kind          ${report.kind}`);
        io.out(`effect_class  ${report.effect_class}`);
        io.out(`risk_level    ${report.risk_level}`);
        io.out(`capabilities  ${report.requested_capabilities.join(', ') || '(none)'}`);
      }
      return EXIT.ok;
    } catch (err) {
      return handleExtError(io, err);
    }
  }

  const targetPath = resolveDbPath(flags, dbPath);
  if (targetPath === null) {
    io.err(USAGE);
    return EXIT.usage;
  }

  if (command === 'register') {
    const source = stringFlag(flags, 'source');
    if (!source) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const loaded = readManifestFile(positional[0], io);
    if (!loaded.ok) return loaded.code;

    return withRegistry(targetPath, io, (reg) => {
      const record = reg.registerCandidate(loaded.raw, { source });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`registered ${record.id} state=${record.state} source=${record.source}`);
      return EXIT.ok;
    });
  }

  if (command === 'approve') {
    const id = typeof positional[0] === 'string' && positional[0].trim() !== '' ? positional[0] : undefined;
    const by = stringFlag(flags, 'by');
    if (!id || !by) {
      io.err(USAGE);
      return EXIT.usage;
    }

    return withRegistry(targetPath, io, (reg) => {
      const record = reg.approve(id, { approvedBy: by });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`approved ${record.id} by=${record.approved_by} state=${record.state}`);
      return EXIT.ok;
    });
  }

  if (command === 'activate') {
    const id = typeof positional[0] === 'string' && positional[0].trim() !== '' ? positional[0] : undefined;
    if (!id) {
      io.err(USAGE);
      return EXIT.usage;
    }

    return withRegistry(targetPath, io, (reg) => {
      const record = reg.activate(id);
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`activated ${record.id} state=${record.state}`);
      return EXIT.ok;
    });
  }

  if (command === 'revoke') {
    const id = typeof positional[0] === 'string' && positional[0].trim() !== '' ? positional[0] : undefined;
    const by = stringFlag(flags, 'by');
    if (!id || !by) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const reason = typeof flags.reason === 'string' ? flags.reason : '';

    return withRegistry(targetPath, io, (reg) => {
      const record = reg.revoke(id, { revokedBy: by, reason });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`revoked ${record.id} by=${record.revoked_by} state=${record.state}`);
      return EXIT.ok;
    });
  }

  if (command === 'list') {
    /** @type {'candidate' | 'approved' | 'active' | 'revoked' | undefined} */
    let state;
    if (flags.state !== undefined) {
      if (typeof flags.state !== 'string' || !VALID_STATES.has(flags.state)) {
        io.err(USAGE);
        return EXIT.usage;
      }
      state = /** @type {'candidate' | 'approved' | 'active' | 'revoked'} */ (flags.state);
    }

    return withRegistry(targetPath, io, (reg) => {
      const rows = reg.list(state ? { state } : {});
      if (asJson) {
        io.out(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        io.out('no extensions found');
      } else {
        for (const r of rows) {
          io.out(`${r.id}  [${r.state}] (${r.kind}, ${r.effect_class}) v${r.version} — ${r.source}`);
        }
      }
      return EXIT.ok;
    });
  }

  io.err(USAGE);
  return EXIT.usage;
}
