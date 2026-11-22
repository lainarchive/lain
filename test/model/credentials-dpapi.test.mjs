// Windows DPAPI credential store, precedence, validation, and CLI set/list/delete
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL_ENV_VAR,
  defaultCredentialDir,
  deleteStoredCredential,
  getCredentials,
  getStoredCredential,
  setStoredCredential,
} from '../../src/model/provider/credentials.mjs';
import { modelCredentialsCommand } from '../../src/cli/commands/model-credentials.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-m12-dpapi-'));

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** @param {string} plaintext */
function fakeProtect(plaintext) {
  return `dpapi:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
}

/** @param {string} blob */
function fakeUnprotect(blob) {
  assert.ok(blob.startsWith('dpapi:'), 'expected dpapi-prefixed blob');
  return Buffer.from(blob.slice('dpapi:'.length), 'base64').toString('utf8');
}

/**
 * @param {Record<string, unknown>} invocation
 * @returns {{ exit: number, stdout: string, stderr: string }}
 */
function runCmd(invocation) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const exit = modelCredentialsCommand({
    command: 'credentials',
    positional: [],
    flags: {},
    ...invocation,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
  });
  return { exit, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('AT-M12-01: defaultCredentialDir respects LAIN_HOME and falls back to ~/.lain/credentials', () => {
  assert.equal(defaultCredentialDir({ LAIN_HOME: join(ROOT, 'home') }), join(ROOT, 'home', 'credentials'));
  assert.equal(defaultCredentialDir({}), join(homedir(), '.lain', 'credentials'));
});

test('AT-M12-02: setStoredCredential, getStoredCredential, and deleteStoredCredential roundtrip', () => {
  const credentialDir = join(ROOT, 'store-roundtrip');
  const opts = { credentialDir, protect: fakeProtect, unprotect: fakeUnprotect };

  assert.equal(getStoredCredential('openai', opts), null);
  assert.deepEqual(deleteStoredCredential('openai', opts), { deleted: false });

  setStoredCredential('openai', 'sk-dpapi-secret-4321', opts);
  const blobPath = join(credentialDir, 'openai.dpapi');
  assert.equal(existsSync(blobPath), true);
  assert.equal(readFileSync(blobPath, 'utf8').trim().startsWith('dpapi:'), true);
  assert.equal(getStoredCredential('openai', opts), 'sk-dpapi-secret-4321');

  assert.deepEqual(deleteStoredCredential('openai', opts), { deleted: true });
  assert.equal(existsSync(blobPath), false);
  assert.equal(getStoredCredential('openai', opts), null);
  assert.deepEqual(deleteStoredCredential('openai', opts), { deleted: false });
});

test('AT-M12-03: getCredentials precedence is env > os-dpapi > env-file > none', () => {
  const credentialDir = join(ROOT, 'store-precedence');
  const envFile = join(ROOT, 'precedence.env');
  writeFileSync(envFile, `${CREDENTIAL_ENV_VAR}=sk-from-env-file-0001\n`);
  const baseOpts = { credentialDir, envFile, protect: fakeProtect, unprotect: fakeUnprotect };

  assert.deepEqual(getCredentials('openai', { ...baseOpts, env: {} }), {
    provider: 'openai',
    source: 'env-file',
    apiKey: 'sk-from-env-file-0001',
  });

  const dpapiSecret = ['sk', 'from-dpapi-0002'].join('-');
  setStoredCredential('openai', dpapiSecret, baseOpts);
  assert.deepEqual(getCredentials('openai', { ...baseOpts, env: {} }), {
    provider: 'openai',
    source: 'os-dpapi',
    apiKey: dpapiSecret,
  });

  assert.deepEqual(getCredentials('openai', { ...baseOpts, env: { [CREDENTIAL_ENV_VAR]: 'sk-from-env-0003' } }), {
    provider: 'openai',
    source: 'env',
    apiKey: 'sk-from-env-0003',
  });

  deleteStoredCredential('openai', baseOpts);
  assert.deepEqual(getCredentials('openai', { ...baseOpts, envFile: join(ROOT, 'missing.env'), env: {} }), {
    provider: 'openai',
    source: 'none',
    apiKey: null,
  });
});

test('AT-M12-04: invalid providerId and empty secret are rejected', () => {
  const credentialDir = join(ROOT, 'store-validation');
  const opts = { credentialDir, protect: fakeProtect, unprotect: fakeUnprotect };

  for (const badId of ['', '../escape', 'OPENAI', 'a/b', 'bad id', 'a.b']) {
    assert.throws(() => setStoredCredential(badId, 'sk-1234', opts), RangeError);
    assert.throws(() => getStoredCredential(badId, opts), RangeError);
    assert.throws(() => deleteStoredCredential(badId, opts), RangeError);
  }
  assert.throws(() => setStoredCredential('openai', '', opts), RangeError);
});

test('AT-M12-05: modelCredentialsCommand supports set (--value and --from-stdin), list, and delete', () => {
  const credentialDir = join(ROOT, 'cli-store');
  const envFile = join(ROOT, 'cli-missing.env');
  const options = { credentialDir, envFile, env: {}, protect: fakeProtect, unprotect: fakeUnprotect };

  const setRes = runCmd({
    positional: ['set', 'openai'],
    flags: { value: 'sk-cli-value-9876' },
    options,
  });
  assert.equal(setRes.exit, 0);
  assert.equal(setRes.stdout.includes('sk-cli-value-9876'), false, 'secret must never be printed');
  assert.deepEqual(JSON.parse(setRes.stdout), { provider: 'openai', source: 'os-dpapi', apiKey: '****9876' });

  const stdinRes = runCmd({
    positional: ['set', 'gemini'],
    flags: { 'from-stdin': true },
    options,
    readStdin: () => 'gm-stdin-secret-5432\n',
  });
  assert.equal(stdinRes.exit, 0);
  assert.equal(stdinRes.stdout.includes('gm-stdin-secret-5432'), false, 'secret must never be printed');
  assert.deepEqual(JSON.parse(stdinRes.stdout), { provider: 'gemini', source: 'os-dpapi', apiKey: '****5432' });

  const listRes = runCmd({ positional: ['list'], options });
  assert.equal(listRes.exit, 0);
  assert.deepEqual(JSON.parse(listRes.stdout), {
    credentials: [
      { provider: 'openai', source: 'os-dpapi', apiKey: '****9876' },
      { provider: 'gemini', source: 'os-dpapi', apiKey: '****5432' },
    ],
  });

  const delRes = runCmd({ positional: ['delete', 'openai'], options });
  assert.equal(delRes.exit, 0);
  assert.deepEqual(JSON.parse(delRes.stdout), { provider: 'openai', deleted: true });

  const delAgain = runCmd({ positional: ['delete', 'openai'], options });
  assert.equal(delAgain.exit, 0);
  assert.deepEqual(JSON.parse(delAgain.stdout), { provider: 'openai', deleted: false });

  const badBoth = runCmd({
    positional: ['set', 'openai'],
    flags: { value: 'abc', 'from-stdin': true },
    options,
  });
  assert.equal(badBoth.exit, 2);

  const badProvider = runCmd({
    positional: ['set', 'BAD/ID'],
    flags: { value: 'abc' },
    options,
  });
  assert.equal(badProvider.exit, 2);
});
