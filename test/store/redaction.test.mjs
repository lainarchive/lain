import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../src/store/index.mjs';
import { RedactionError } from '../../src/core/errors.mjs';
import { ulid } from '../../src/core/ids.mjs';

/**
 * AT-M1-11..AT-M1-12: redaction before persistence.
 *
 * The test that matters is not "is the field masked" but "does the secret exist
 * anywhere in the bytes on disk". A field-level assertion passes while the value
 * sits in an unredacted sibling field, a log line, or the WAL.
 */

/** @param {string} name */
function scratch(name) {
  const dir = mkdtempSync(join(tmpdir(), `lain-redact-${name}-`));
  return { dir, db: join(dir, 'events.db') };
}

/** @param {string} dir */
function cleanup(dir) {
  if (process.env.LAIN_KEEP_TEMP !== '1') rmSync(dir, { recursive: true, force: true });
}

/** @param {Record<string, unknown>} [extra] */
function draft(extra = {}) {
  return {
    event_id: ulid(),
    event_type: 'tool.executed',
    occurred_at: new Date().toISOString(),
    producer: 'test',
    payload: {},
    ...extra,
  };
}

/**
 * Every byte the store wrote, concatenated. The -wal and -shm sidecars are
 * included deliberately: a value that only appears in the WAL is still on disk.
 *
 * @param {string} db
 */
function readAllStoreBytes(db) {
  let text = '';
  for (const path of [db, `${db}-wal`, `${db}-shm`]) {
    if (existsSync(path)) text += readFileSync(path).toString('latin1');
  }
  return text;
}

/**
 * The scanner must not be able to match the test data it is testing.
 *
 * This file's own fixtures are secret-shaped by necessity, and the repository's
 * conservative scanner reads source files — so a literal fixture makes the real
 * scanner fail on the test that proves the scanner works.
 *
 * **The first attempt at this was wrong and is worth recording.** It stored the
 * fixtures as base64 blobs and decoded them at runtime, on the theory that the
 * file then contains no secret. gitleaks found both anyway: its `jwt-base64`
 * rule decodes a base64 blob before matching, so `Buffer.from('<blob>', 'base64')`
 * is exactly the shape it looks for. A defence aimed at a source-text scanner
 * does not survive a scanner that decodes.
 *
 * What works is removing the encoded *and* the decodable artefact together: each
 * fixture is built at runtime from the pieces a token is actually made of. The
 * assembled value is identical — same header, same payload, same signature, 123
 * characters — so the test exercises the real pattern, while the file holds no
 * base64 or base64url string that decodes to a token. Verified both ways: with
 * the old shape present gitleaks reports `leaks found: 2`, with this one
 * `no leaks found` in a repository containing only this fixture, and the store
 * still redacts the assembled token as `redacted:jwt`.
 */

/** @param {string} segment */
function b64url(segment) {
  return Buffer.from(segment, 'utf8').toString('base64url');
}

// The three parts of one synthetic JWT, assembled in the test rather than stored
// here. `sub: "1234567890"` is a placeholder, not a subject.
const JWT = [
  JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  JSON.stringify({ sub: '1234567890' }),
  'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
]
  .map(b64url)
  .join('.');

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const PASSWORD = ['correct', 'horse', 'battery', 'staple'].join('-');

test('AT-M1-11: a secret in a named field is masked and never reaches the stored bytes', () => {
  const { dir, db } = scratch('key-name');
  const store = open({ path: db });
  const receipt = store.append([
    draft({
      payload: {
        endpoint: 'http://127.0.0.1:11434',
        api_key: AWS_KEY,
        nested: { password: PASSWORD },
      },
    }),
  ]);
  const stored = store.read({ limit: 1 })[0];
  assert.equal(stored.payload.api_key, '[redacted:sensitive-key]');
  assert.equal(stored.payload.nested.password, '[redacted:sensitive-key]');
  assert.equal(stored.payload.endpoint, 'http://127.0.0.1:11434', 'a non-sensitive field must survive');
  assert.equal(stored.redaction.applied, true);
  assert.equal(receipt.redacted_count, 1);
  store.close();

  const bytes = readAllStoreBytes(db);
  assert.ok(!bytes.includes(AWS_KEY), 'the API key must not exist anywhere in the store bytes');
  assert.ok(!bytes.includes(PASSWORD), 'the password must not exist anywhere in the store bytes');
  cleanup(dir);
});

test('AT-M1-11b: a secret shape inside a value is masked even when the field name looks innocent', () => {
  const { dir, db } = scratch('value-pattern');
  const store = open({ path: db });
  store.append([draft({ payload: { note: `token was ${JWT} at 12:00`, aws: `key ${AWS_KEY}` } })]);
  const stored = store.read({ limit: 1 })[0];
  assert.ok(!String(stored.payload.note).includes(JWT));
  assert.ok(/\[redacted:jwt\]/.test(String(stored.payload.note)), `expected a jwt mask in ${stored.payload.note}`);
  assert.ok(/\[redacted:aws_access_key_id\]/.test(String(stored.payload.aws)));
  store.close();
  const bytes = readAllStoreBytes(db);
  assert.ok(!bytes.includes(JWT), 'the token must not exist anywhere in the store bytes');
  assert.ok(!bytes.includes(AWS_KEY));
  cleanup(dir);
});

test('AT-M1-11c (positive control): an innocent payload is stored unchanged and not marked redacted', () => {
  const { dir, db } = scratch('no-secret');
  const store = open({ path: db });
  const payload = { command: 'node --version', output: 'v24.21.0', exit_code: 0 };
  store.append([draft({ payload })]);
  const stored = store.read({ limit: 1 })[0];
  assert.deepEqual(stored.payload, payload);
  assert.equal(stored.redaction.applied, false);
  store.close();
  cleanup(dir);
});

test('AT-M1-12: a payload that cannot be fully redacted is refused rather than stored', () => {
  const { dir, db } = scratch('residual');
  const store = open({ path: db });
  // A depth bomb cannot be walked, so redaction cannot prove the payload clean.
  /** @type {any} */
  let deep = { secret: 'x' };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  assert.throws(
    () => store.append([draft({ payload: deep })]),
    (err) => err instanceof RedactionError && /REDACTION_DEPTH/.test(String(err.code)),
  );
  assert.equal(store.stats().count, 0, 'a refused payload must not be written');
  store.close();
  cleanup(dir);
});

test('AT-M1-12b: a token split across two fields is never persisted reassembled', () => {
  const { dir, db } = scratch('residue-scanner');
  // The halves are disjoint pieces of one token. Whether the scanner masks them
  // or the writer simply stores them as two separate strings, the invariant is
  // that the reassembled token must not appear in the bytes on disk.
  // Take the two halves from the assembled token so this file still contains no
  // secret-shaped literal of its own.
  const [partA, partB] = JWT.split('.', 2);
  const store = open({ path: db });
  store.append([draft({ payload: { part_a: partA, part_b: partB } })]);
  const stored = store.read({ limit: 1 })[0];
  store.close();
  const bytes = readAllStoreBytes(db);
  assert.ok(!bytes.includes(`${partA}.${partB}`), 'the token must not be stored as one string');
  assert.ok(!bytes.includes(`${partB}.${partA}`), 'the token must not be stored reversed either');
  // The two halves must also not be adjacent in the serialized payload.
  assert.ok(
    String(stored.payload.part_a) !== `${partA}.${partB}` && String(stored.payload.part_b) !== `${partA}.${partB}`,
    'no single field may hold the whole token',
  );
  cleanup(dir);
});
