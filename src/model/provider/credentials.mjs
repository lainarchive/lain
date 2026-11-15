/**
 * @generated
 * @purpose  M-7 credential loader: env first, .env fallback, masked everywhere, never written
 * @requires Chief-of-Staff
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Where a credential came from. `none` is a status, not an error — the CLI
 * reports it and decides what to refuse; a loader that throws on a missing
 * key makes "check what is configured" impossible to ask politely.
 *
 * @typedef {'env' | 'env-file' | 'none'} CredentialSource
 */

/**
 * @typedef {{ provider: string, source: CredentialSource, apiKey: string | null }} Credentials
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

/**
 * Resolve one provider's credential. Order is the brief's order: the
 * `AGY_ACCOUNT` environment variable first, then a `.env` file at the repo
 * root. The loader only ever reads — there is no code path in this module
 * that writes a file, and the repo-root `.env` is already covered by
 * `.gitignore` (lines 37–39, with `!.env.example` re-included), so no
 * gitignore edit was needed.
 *
 * The default `.env` location is resolved from this module's own URL, not
 * from the current working directory: a CLI invoked from a subdirectory must
 * find the same file, and a test must be able to point the loader anywhere.
 *
 * @param {string} providerId
 * @param {{ env?: Record<string, string | undefined>, envFile?: string }} [options]
 * @returns {Credentials}
 */
export function getCredentials(providerId, options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[CREDENTIAL_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { provider: providerId, source: 'env', apiKey: fromEnv };
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
