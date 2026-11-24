import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openMemoryStore } from '../../memory/store.mjs';

/** Kept equal to `EXIT` in `../index.mjs` to avoid circular imports. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain memory — local-first memory & knowledge graph

  lain memory add --title <t> --content <c> --source <s> [--kind <k>] [--trust trusted|untrusted] [--id <id>] [--json]
  lain memory search <query> [--include-untrusted] [--limit <n>] [--json]
  lain memory show <id> [--json]
  lain memory supersede <oldId> --title <t> --content <c> --source <s> [--kind <k>] [--trust trusted|untrusted] [--json]
  lain memory link <fromId> <toId> <relation> --source <s> [--trust trusted|untrusted] [--json]
  lain memory pending [--json]
  lain memory approve <id> --approved-by <name> [--json]
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
 * @returns {string}
 */
function resolveDbPath(flags, dbPath) {
  if (typeof dbPath === 'string' && dbPath.trim() !== '') return dbPath;
  const home = stringFlag(flags, 'lain-home') ?? (process.env.LAIN_HOME || join(homedir(), '.lain'));
  return join(home, 'memory.db');
}

/**
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {unknown} err
 * @returns {number}
 */
function handleStoreError(io, err) {
  const e = /** @type {Error & { code?: string }} */ (err);
  const message = e instanceof Error ? e.message : String(err);
  if (e?.code === 'SECRET_REFUSED') {
    io.err(`refused: ${e.code} — ${message}`);
    return EXIT.refused;
  }
  const prefix = e?.code ? `${e.code} — ` : '';
  io.err(`failed: ${prefix}${message}`);
  return EXIT.failed;
}

/**
 * @param {{
 *   command?: string,
 *   positional: string[],
 *   flags: Record<string, string|boolean>,
 *   io: { out: (line: string) => void, err: (line: string) => void },
 *   dbPath?: string,
 * }} args
 * @returns {number}
 */
export function memoryCommand({ command, positional, flags, io, dbPath }) {
  const asJson = Boolean(flags.json);
  const targetPath = resolveDbPath(flags, dbPath);

  if (command === 'add') {
    const title = stringFlag(flags, 'title');
    const content = stringFlag(flags, 'content');
    const source = stringFlag(flags, 'source');
    if (!title || !content || !source) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const id = stringFlag(flags, 'id');
    const kind = /** @type {import('../../memory/store.mjs').MemoryKind | undefined} */ (stringFlag(flags, 'kind'));
    const trust = /** @type {'trusted' | 'untrusted'} */ (stringFlag(flags, 'trust') ?? 'untrusted');

    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const record = store.remember({
        ...(id ? { id } : {}),
        title,
        content,
        source,
        ...(kind ? { kind } : {}),
        trust,
      });
      if (asJson) {
        io.out(JSON.stringify(record, null, 2));
      } else {
        io.out(`added ${record.id} (${record.kind}, ${record.trust})`);
        io.out(`title   ${record.title}`);
        io.out(`source  ${record.source}`);
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  if (command === 'search') {
    const query = positional[0];
    if (typeof query !== 'string' || query.trim() === '') {
      io.err(USAGE);
      return EXIT.usage;
    }
    const includeUntrusted = Boolean(flags['include-untrusted']);
    const rawLimit = flags.limit;
    /** @type {number | undefined} */
    let limit;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) <= 0) {
        io.err(USAGE);
        return EXIT.usage;
      }
      limit = Number(rawLimit);
    }

    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const results = store.search(query, {
        includeUntrusted,
        ...(limit !== undefined ? { limit } : {}),
      });
      if (asJson) {
        io.out(JSON.stringify(results, null, 2));
      } else if (results.length === 0) {
        io.out('no memories found');
      } else {
        for (const r of results) {
          io.out(`${r.id}  [${r.trust}] (${r.kind}) ${r.title} — ${r.source} (${r.created_at})`);
        }
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  if (command === 'show') {
    const id = positional[0];
    if (typeof id !== 'string' || id.trim() === '') {
      io.err(USAGE);
      return EXIT.usage;
    }

    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const record = store.get(id);
      if (!record) {
        io.err(`failed: memory '${id}' not found`);
        return EXIT.failed;
      }
      const provenance = store.provenance(id);
      const neighbors = store.neighbors(id);
      if (asJson) {
        io.out(JSON.stringify({ record, provenance, neighbors }, null, 2));
      } else {
        io.out(`id          ${record.id}`);
        io.out(`title       ${record.title}`);
        io.out(`kind        ${record.kind}`);
        io.out(`trust       ${record.trust}`);
        io.out(`source      ${record.source}`);
        io.out(`created_at  ${record.created_at}`);
        if (record.superseded_by) io.out(`superseded  ${record.superseded_by}`);
        io.out(`content     ${record.content}`);
        if (provenance?.supersedes?.length) {
          io.out(`supersedes  ${provenance.supersedes.join(', ')}`);
        }
        const edgeCount = neighbors?.edges?.length ?? 0;
        io.out(`neighbors   ${edgeCount} edge(s)`);
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  if (command === 'supersede') {
    const oldId = positional[0];
    const title = stringFlag(flags, 'title');
    const content = stringFlag(flags, 'content');
    const source = stringFlag(flags, 'source');
    if (typeof oldId !== 'string' || oldId.trim() === '' || !title || !content || !source) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const kind = /** @type {import('../../memory/store.mjs').MemoryKind | undefined} */ (stringFlag(flags, 'kind'));
    const trust = /** @type {'trusted' | 'untrusted'} */ (stringFlag(flags, 'trust') ?? 'untrusted');

    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const result = store.supersede(oldId, {
        title,
        content,
        source,
        ...(kind ? { kind } : {}),
        trust,
      });
      if (asJson) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(`superseded ${result.superseded} -> ${result.current.id} (${result.current.trust})`);
        io.out(`title      ${result.current.title}`);
        io.out(`source     ${result.current.source}`);
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  if (command === 'link') {
    const [fromId, toId, relation] = positional;
    const source = stringFlag(flags, 'source');
    if (
      typeof fromId !== 'string' ||
      fromId.trim() === '' ||
      typeof toId !== 'string' ||
      toId.trim() === '' ||
      typeof relation !== 'string' ||
      relation.trim() === '' ||
      !source
    ) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const trust = /** @type {'trusted' | 'untrusted'} */ (stringFlag(flags, 'trust') ?? 'untrusted');

    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const edge = store.link(fromId, toId, relation, { source, trust });
      if (asJson) {
        io.out(JSON.stringify(edge, null, 2));
      } else {
        io.out(`linked ${fromId} -[${relation}]-> ${toId} (${trust}, ${source})`);
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  if (command === 'pending') {
    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const results = store.pending();
      if (asJson) {
        io.out(JSON.stringify(results, null, 2));
      } else if (results.length === 0) {
        io.out('no memories pending review');
      } else {
        for (const r of results) {
          io.out(`${r.id}  (${r.kind}) ${r.title} — ${r.source} (${r.created_at})`);
        }
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  if (command === 'approve') {
    const id = positional[0];
    const approvedBy = stringFlag(flags, 'approved-by');
    if (typeof id !== 'string' || id.trim() === '' || !approvedBy) {
      io.err(USAGE);
      return EXIT.usage;
    }

    if (targetPath !== ':memory:') mkdirSync(dirname(targetPath), { recursive: true });
    const store = openMemoryStore({ path: targetPath });
    try {
      const record = store.promote(id, { approvedBy });
      if (asJson) {
        io.out(JSON.stringify(record, null, 2));
      } else {
        io.out(`approved ${record.id} (${record.trust})`);
        io.out(`title      ${record.title}`);
      }
      return EXIT.ok;
    } catch (err) {
      return handleStoreError(io, err);
    } finally {
      store.close();
    }
  }

  io.err(USAGE);
  return EXIT.usage;
}
