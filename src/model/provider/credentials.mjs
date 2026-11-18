/**
 * @generated
 * @purpose  M-7/M-12 credential loader: env, Windows DPAPI store, .env fallback, masked everywhere
 * @requires Chief-of-Staff
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a credential came from. `none` is a status, not an error — the CLI
 * reports it and decides what to refuse; a loader that throws on a missing
 * key makes "check what is configured" impossible to ask politely.
 *
 * @typedef {'env' | 'os-dpapi' | 'env-file' | 'none'} CredentialSource
 */

/**
 * @typedef {{ provider: string, source: CredentialSource, apiKey: string | null }} Credentials
 */

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   envFile?: string,
 *   credentialDir?: string,
 *   protect?: (plaintext: string) => string,
 *   unprotect?: (blob: string) => string,
 * }} CredentialOptions
 */

/**
 * The variable the brief named. One global credential variable is unusual —
 * provider-specific names (`OPENAI_API_KEY`, …) are the usual shape — but it
 * is what was asked for, it is one name to audit, and provider-specific
 * lookup is a milestone-proper refinement that slots in behind this seam
 * without changing any caller.
 *
 * @type {string}
 */
export const CREDENTIAL_ENV_VAR = 'AGY_ACCOUNT';

/**
 * Parse the small `.env` subset this loader needs: `KEY=VALUE` lines, blank
 * lines and `#` comments skipped, one level of surrounding quotes stripped.
 * Deliberately not a dotenv dependency — the format is three rules, and a
 * dependency that reads arbitrary shell syntax is more attack surface than
 * feature for a file this repo only ever reads.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== '') values[key] = value;
  }
  return values;
}

/**
 * Mask a secret for any human-readable surface. Only the last four characters
 * survive — enough to tell two keys apart, not enough to be a key. Absent
 * stays absent; there is nothing to mask and pretending otherwise would
 * invent a value.
 *
 * @param {string | null} apiKey
 * @returns {string}
 */
export function maskSecret(apiKey) {
  if (apiKey === null || apiKey === '') return '(absent)';
  if (apiKey.length <= 4) return '****';
  return `****${apiKey.slice(-4)}`;
}

const PROVIDER_ID_RE = /^[a-z0-9_-]+$/;

const PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($protected)',
].join('; ');

const UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($bytes)',
].join('; ');

/** @param {string} providerId */
function assertValidProviderId(providerId) {
  if (typeof providerId !== 'string' || !PROVIDER_ID_RE.test(providerId)) {
    throw new RangeError(`Invalid provider id: ${String(providerId)}`);
  }
}

/**
 * Pass base64 over stdin rather than interpolating secrets into `-Command`,
 * so quotes, `$()`, and console codepage differences never corrupt or execute
 * a credential. Fails closed on non-win32 when no test stub is injected.
 *
 * @param {string} script
 * @param {string} input
 * @returns {string}
 */
function runDpapiPowerShell(script, input) {
  if (process.platform !== 'win32') {
    throw new Error('Windows DPAPI is only available on win32');
  }
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { shell: false, windowsHide: true, encoding: 'utf8', input },
  );
  if (result.error) {
    throw new Error(`DPAPI invocation failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new Error(detail !== '' ? `DPAPI failed: ${detail}` : `DPAPI failed with exit code ${result.status}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultCredentialDir(env = process.env) {
  return join(env.LAIN_HOME || join(homedir(), '.lain'), 'credentials');
}

/**
 * @param {string} providerId
 * @param {CredentialOptions} [options]
 * @returns {string}
 */
function credentialFilePath(providerId, options = {}) {
  assertValidProviderId(providerId);
  const dir = options.credentialDir ?? defaultCredentialDir(options.env);
  return join(dir, `${providerId}.dpapi`);
}

/**
 * @param {string} providerId
 * @param {string} secret
 * @param {CredentialOptions} [options]
 * @returns {{ provider: string, path: string }}
 */
export function setStoredCredential(providerId, secret, options = {}) {
  assertValidProviderId(providerId);
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new RangeError('Credential secret must be a non-empty string');
  }
  const blob = typeof options.protect === 'function'
    ? options.protect(secret)
    : runDpapiPowerShell(PROTECT_SCRIPT, Buffer.from(secret, 'utf8').toString('base64'));
  const dir = options.credentialDir ?? defaultCredentialDir(options.env);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${providerId}.dpapi`);
  writeFileSync(filePath, `${blob.trim()}\n`, 'utf8');
  return { provider: providerId, path: filePath };
}

/**
 * @param {string} providerId
 * @param {CredentialOptions} [options]
 * @returns {string | null}
 */
export function getStoredCredential(providerId, options = {}) {
  const filePath = credentialFilePath(providerId, options);
  if (!existsSync(filePath)) return null;
  const blob = readFileSync(filePath, 'utf8').trim();
  if (blob === '') return null;
  const plaintext = typeof options.unprotect === 'function'
    ? options.unprotect(blob)
    : Buffer.from(runDpapiPowerShell(UNPROTECT_SCRIPT, blob), 'base64').toString('utf8');
  return plaintext === '' ? null : plaintext;
}

/**
 * @param {string} providerId
 * @param {CredentialOptions} [options]
 * @returns {{ deleted: boolean }}
 */
export function deleteStoredCredential(providerId, options = {}) {
  const filePath = credentialFilePath(providerId, options);
  if (!existsSync(filePath)) return { deleted: false };
  unlinkSync(filePath);
  return { deleted: true };
}

/**
 * Resolve one provider's credential in order: `AGY_ACCOUNT` env var,
 * Windows DPAPI store (`<dir>/<providerId>.dpapi`), `.env` file, then `none`.
 *
 * The default `.env` location is resolved from this module's own URL, not
 * from the current working directory: a CLI invoked from a subdirectory must
 * find the same file, and a test must be able to point the loader anywhere.
 *
 * @param {string} providerId
 * @param {CredentialOptions} [options]
 * @returns {Credentials}
 */
export function getCredentials(providerId, options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[CREDENTIAL_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { provider: providerId, source: 'env', apiKey: fromEnv };
  }
  const fromDpapi = getStoredCredential(providerId, options);
  if (typeof fromDpapi === 'string' && fromDpapi !== '') {
    return { provider: providerId, source: 'os-dpapi', apiKey: fromDpapi };
  }
  const envFile = options.envFile ?? new URL('../../../.env', import.meta.url);
  if (typeof envFile === 'string' && existsSync(envFile)) {
    const parsed = parseEnvFile(readFileSync(envFile, 'utf8'));
    const fromFile = parsed[CREDENTIAL_ENV_VAR];
    if (typeof fromFile === 'string' && fromFile !== '') {
      return { provider: providerId, source: 'env-file', apiKey: fromFile };
    }
  }
  return { provider: providerId, source: 'none', apiKey: null };
}
