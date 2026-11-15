/**
 * @generated
 * @purpose  M-7 tests: the credential loader reads, masks, and never writes
 * @requires Chief-of-Staff
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_ENV_VAR, getCredentials, maskSecret, parseEnvFile } from '../../src/model/provider/credentials.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'lain-m7-credentials-'));

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test('AT-M7-01: the environment variable is the first source', () => {
  const previous = process.env[CREDENTIAL_ENV_VAR];
  try {
    process.env[CREDENTIAL_ENV_VAR] = 'sk-env-value-9999';
    const found = getCredentials('openai');
    assert.equal(found.source, 'env');
    assert.equal(found.apiKey, 'sk-env-value-9999');
    assert.equal(found.provider, 'openai');
  } finally {
    if (previous === undefined) delete process.env[CREDENTIAL_ENV_VAR];
    else process.env[CREDENTIAL_ENV_VAR] = previous;
  }
});

test('AT-M7-02: the repo .env file is the fallback source', () => {
  const envFile = join(ROOT, 'fallback.env');
  writeFileSync(envFile, '# comment\nAGY_ACCOUNT=sk-file-value-7777\n');
  const previous = process.env[CREDENTIAL_ENV_VAR];
  delete process.env[CREDENTIAL_ENV_VAR];
  try {
    const found = getCredentials('openai', { env: {}, envFile });
    assert.equal(found.source, 'env-file');
    assert.equal(found.apiKey, 'sk-file-value-7777');
  } finally {
    if (previous === undefined) delete process.env[CREDENTIAL_ENV_VAR];
    else process.env[CREDENTIAL_ENV_VAR] = previous;
  }
});

test('AT-M7-03: the environment variable wins over the .env file', () => {
  const envFile = join(ROOT, 'fallback.env');
  const previous = process.env[CREDENTIAL_ENV_VAR];
  try {
    process.env[CREDENTIAL_ENV_VAR] = 'sk-env-wins-1111';
    const found = getCredentials('openai', { envFile });
    assert.equal(found.source, 'env');
    assert.equal(found.apiKey, 'sk-env-wins-1111');
  } finally {
    if (previous === undefined) delete process.env[CREDENTIAL_ENV_VAR];
    else process.env[CREDENTIAL_ENV_VAR] = previous;
  }
});

test('AT-M7-04: no source at all is a status, not an error', () => {
  const envFile = join(ROOT, 'not-there.env');
  const previous = process.env[CREDENTIAL_ENV_VAR];
  delete process.env[CREDENTIAL_ENV_VAR];
  try {
    const found = getCredentials('gemini', { env: {}, envFile });
    assert.equal(found.source, 'none');
    assert.equal(found.apiKey, null);
  } finally {
    if (previous === undefined) delete process.env[CREDENTIAL_ENV_VAR];
    else process.env[CREDENTIAL_ENV_VAR] = previous;
  }
});

test('AT-M7-05: masking keeps only the last four characters', () => {
  assert.equal(maskSecret('sk-abcdef123456'), '****3456');
  assert.equal(maskSecret('abc'), '****', 'a value too short to keep four characters is fully masked');
  assert.equal(maskSecret(null), '(absent)');
  assert.equal(maskSecret(''), '(absent)');
});

test('AT-M7-06: a missing credential file is not created by a lookup', () => {
  const envFile = join(ROOT, 'must-stay-missing.env');
  const previous = process.env[CREDENTIAL_ENV_VAR];
  delete process.env[CREDENTIAL_ENV_VAR];
  try {
    getCredentials('openai', { env: {}, envFile });
    assert.equal(existsSync(envFile), false, 'the loader only ever reads');
  } finally {
    if (previous === undefined) delete process.env[CREDENTIAL_ENV_VAR];
    else process.env[CREDENTIAL_ENV_VAR] = previous;
  }
});

test('AT-M7-07: the .env parser handles comments, blanks, quotes and embedded equals', () => {
  const parsed = parseEnvFile([
    '# a comment',
    '',
    'PLAIN=value',
    'QUOTED="quoted value"',
    "SINGLE='single value'",
    'EMBEDDED=a=b=c',
    '=no key',
    'NOVALUE',
  ].join('\n'));
  assert.deepEqual(parsed, {
    PLAIN: 'value',
    QUOTED: 'quoted value',
    SINGLE: 'single value',
    EMBEDDED: 'a=b=c',
  });
});

test('AT-M7-08: an empty-string env value does not count as a credential', () => {
  const previous = process.env[CREDENTIAL_ENV_VAR];
  try {
    process.env[CREDENTIAL_ENV_VAR] = '';
    const found = getCredentials('openai', { env: process.env, envFile: join(ROOT, 'not-there.env') });
    assert.equal(found.source, 'none');
  } finally {
    if (previous === undefined) delete process.env[CREDENTIAL_ENV_VAR];
    else process.env[CREDENTIAL_ENV_VAR] = previous;
  }
});
