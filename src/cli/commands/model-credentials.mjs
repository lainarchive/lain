/**
 * @generated
 * @purpose  `lain model credentials list` — report provider credential status, masked (M-7 scaffold)
 * @requires Chief-of-Staff
 */
import { getCredentials, maskSecret } from '../../model/provider/credentials.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model credentials — provider credential status (M-7 scaffold)

  lain model credentials list
      Report, for every provider that would need a key, where its credential
      came from (env, env-file, none) and a MASKED value — only the last four
      characters survive, and an absent key prints '(absent)'. The full value
      is never printed, never logged, never written anywhere by this command.
      Read-only; no gate.
`;

/**
 * The providers that would need a credential once real transports exist.
 * `local` is a mock and needs none, so it is not listed.
 *
 * @type {string[]}
 */
const PROVIDERS = ['openai', 'gemini'];

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {number}
 */
export function modelCredentialsCommand({ command, positional, flags, io }) {
  if (command !== 'credentials') {
    io.err(USAGE);
    return EXIT.usage;
  }
  const [verb] = positional;
  if (verb !== 'list') {
    io.err(USAGE);
    return EXIT.usage;
  }
  const credentials = PROVIDERS.map((provider) => {
    const found = getCredentials(provider);
    return { provider, source: found.source, apiKey: maskSecret(found.apiKey) };
  });
  io.out(JSON.stringify({ credentials }, null, 2));
  return EXIT.ok;
}
