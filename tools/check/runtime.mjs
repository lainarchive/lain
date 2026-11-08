/**
 * Check: the runtime is the pinned major version.
 *
 * Why it can fail: the whole verification story assumes one Node major. An
 * unpinned runtime is how "works on my machine" enters a project, and the
 * event store depends on `node:sqlite`, which is version-specific.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isEntryPoint, main } from './lib/report.mjs';

const PIN_FILE = '.node-version';
const EXPECTED_MAJOR = '24';

if (isEntryPoint(import.meta.url)) await main('runtime', async ({ result, root }) => {
  const actual = process.versions.node;
  const actualMajor = actual.split('.')[0];

  let pinned = '(no .node-version file)';
  try {
    // The pin file may name the runtime (`node 24.21.0`) or just give the
    // version (`24.21.0`). Anything non-numeric is a label, not a version part.
    const raw = (await readFile(join(root, PIN_FILE), 'utf8')).trim();
    const version = raw.split(/\s+/).find((part) => /^\d/.test(part)) ?? raw;
    pinned = version;
  } catch {
    result.fail(`missing ${PIN_FILE}: the runtime is not pinned`, { message: 'runtime pin file absent', where: PIN_FILE });
  }

  const pinnedMajor = pinned.split('.')[0];

  result.record('node', actual);
  result.record('pin', pinned);
  result.record('modules_abi', process.versions.modules);
  if (process.versions.v8) result.record('v8', process.versions.v8);

  if (pinnedMajor !== EXPECTED_MAJOR) {
    result.fail(`pin file says major ${pinnedMajor}, this project requires ${EXPECTED_MAJOR}`, {
      message: 'runtime pin does not match the required major',
      where: PIN_FILE,
    });
  }
  if (actualMajor !== pinnedMajor) {
    result.fail(`running Node ${actual} but ${PIN_FILE} pins ${pinned}`, {
      message: 'runtime major mismatch',
      where: PIN_FILE,
      detail: 'run the check with the pinned runtime, or update the pin deliberately',
    });
  }

  // node:sqlite must be present. Its absence or instability changes Step 2.
  let sqliteNote = 'node:sqlite present';
  try {
    const sqlite = await import('node:sqlite');
    const exports = Object.keys(sqlite).sort();
    result.record('node_sqlite_exports', exports.join(','));
    for (const required of ['DatabaseSync', 'StatementSync', 'backup']) {
      if (!exports.includes(required)) {
        result.fail(`node:sqlite is missing the required export ${required}`, {
          message: 'node:sqlite API surface changed',
          detail: `exports: ${exports.join(',')}`,
        });
      }
    }
    const probe = new sqlite.DatabaseSync(':memory:');
    const version = probe.prepare('select sqlite_version() as v').get();
    probe.close();
    result.record('sqlite_version', version?.v ?? 'unknown');
    sqliteNote = `node:sqlite ${version?.v} (no experimental warning observed)`;
  } catch (err) {
    result.fail('node:sqlite is unavailable in this runtime', {
      message: err instanceof Error ? err.message : String(err),
      detail: 'the event store depends on node:sqlite; see docs/implementation/build-and-verification.md',
    });
  }

  result.note(sqliteNote);
  if (result.status === 'pass') result.note(`runtime ok: Node ${actual}, pin ${pinned}`);
});
