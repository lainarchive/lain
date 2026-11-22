// `lain model credentials list|set|delete` — manage and report provider credentials (M-7/M-12)
import { readFileSync } from 'node:fs';
import {
  deleteStoredCredential,
  getCredentials,
  maskSecret,
  setStoredCredential,
} from '../../model/provider/credentials.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model credentials — provider credential store and status (M-7/M-12)

  lain model credentials list
      Report, for every provider that would need a key, where its credential
      came from (env, os-dpapi, env-file, none) and a MASKED value.
  lain model credentials set <provider> --value <secret>
  lain model credentials set <provider> --from-stdin
      Encrypt and store <provider> in the Windows DPAPI credential store.
  lain model credentials delete <provider>
      Remove <provider> from the Windows DPAPI credential store.
`;

/**
 * The providers that would need a credential once real transports exist.
 * `local` is a mock and needs none, so it is not listed.
 *
 * @type {string[]}
 */
const PROVIDERS = ['openai', 'gemini'];

/**
 * @param {Record<string, string|boolean>} flags
 * @param {() => string} readStdin
 * @returns {string | null}
 */
function resolveSecretInput(flags, readStdin) {
  const hasValue = typeof flags.value === 'string';
  const fromStdin = flags['from-stdin'] === true;
  if (hasValue === fromStdin) return null;
  const raw = hasValue ? /** @type {string} */ (flags.value) : readStdin().replace(/\r?\n$/, '');
  return raw === '' ? null : raw;
}

/**
 * @param {{
 *   command?: string,
 *   positional: string[],
 *   flags: Record<string, string|boolean>,
 *   io: { out: (line: string) => void, err: (line: string) => void },
 *   options?: import('../../model/provider/credentials.mjs').CredentialOptions,
 *   readStdin?: () => string,
 * }} args
 * @returns {number}
 */
export function modelCredentialsCommand({
  command,
  positional,
  flags,
  io,
  options = {},
  readStdin = () => readFileSync(0, 'utf8'),
}) {
  if (command !== 'credentials') {
    io.err(USAGE);
    return EXIT.usage;
  }
  const [verb, provider] = positional;
  if (verb === 'list') {
    const credentials = PROVIDERS.map((entry) => {
      const found = getCredentials(entry, options);
      return { provider: entry, source: found.source, apiKey: maskSecret(found.apiKey) };
    });
    io.out(JSON.stringify({ credentials }, null, 2));
    return EXIT.ok;
  }
  if (verb === 'set') {
    if (typeof provider !== 'string' || provider === '') {
      io.err(USAGE);
      return EXIT.usage;
    }
    const secret = resolveSecretInput(flags, readStdin);
    if (secret === null) {
      io.err(USAGE);
      return EXIT.usage;
    }
    try {
      setStoredCredential(provider, secret, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.err(message);
      return err instanceof RangeError ? EXIT.usage : EXIT.failed;
    }
    io.out(JSON.stringify({ provider, source: 'os-dpapi', apiKey: maskSecret(secret) }, null, 2));
    return EXIT.ok;
  }
  if (verb === 'delete') {
    if (typeof provider !== 'string' || provider === '') {
      io.err(USAGE);
      return EXIT.usage;
    }
    try {
      const result = deleteStoredCredential(provider, options);
      io.out(JSON.stringify({ provider, deleted: result.deleted }, null, 2));
      return EXIT.ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.err(message);
      return err instanceof RangeError ? EXIT.usage : EXIT.failed;
    }
  }
  io.err(USAGE);
  return EXIT.usage;
}
