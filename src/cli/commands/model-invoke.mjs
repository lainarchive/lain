/**
 * @generated
 * @purpose  `lain model invoke <task.json> <provider>` — route one task to a provider stub (M-7 scaffold)
 * @requires Chief-of-Staff
 */
import { readFileSync } from 'node:fs';
import { StoreError } from '../../core/errors.mjs';
import { ModelPolicyError } from '../../model/integration.mjs';
import { decide, permitsExecution } from '../../policy/decide.mjs';
import { buildContext, DEFAULT_RULES } from '../../policy/rules.mjs';
import { getCredentials, maskSecret } from '../../model/provider/credentials.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

/**
 * The stub modules this scaffold can route to. The map is the seam the real
 * transports will replace one entry at a time; `local` is included because
 * the mock is a provider too and costs nothing to route.
 *
 * @type {Record<string, () => Promise<{ query?: (prompt: string) => { provider: string, answer: string, echo: string }, localModel?: (prompt: string) => { answer: string, echo: string } }>>}
 */
const PROVIDER_STUBS = {
  openai: () => import('../../model/provider/openai.mjs'),
  gemini: () => import('../../model/provider/gemini.mjs'),
  local: () => import('../../model/localModel.mjs'),
};

const USAGE = `lain model invoke — route one task to a provider (M-7 scaffold)

  lain model invoke <task.json> <provider>
      Read the task file, ask the policy engine for 'model.invoke', and run
      the named provider's STUB — a mock answer, no network, no key. The
      credential status is reported masked in the output document.
      Providers: openai, gemini, local.

  lain model invoke <task.json> <provider> --live
      Refused in this scaffold: real transports are the milestone proper and
      need explicit owner approval. Exit 3; nothing is sent anywhere.

  Exit 0 on success; 3 when the policy refused or --live was refused;
  4 on an unknown provider; 2 for usage errors and unreadable task files.
`;

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {Promise<number>}
 */
export async function modelInvokeCommand({ command, positional, flags, io }) {
  if (command !== 'invoke') {
    io.err(USAGE);
    return EXIT.usage;
  }
  const [taskPath, providerId] = positional;
  if (taskPath === undefined || providerId === undefined) {
    io.err(USAGE);
    return EXIT.usage;
  }
  const loader = PROVIDER_STUBS[providerId];
  if (loader === undefined) {
    io.err(`failed: unknown provider: ${providerId} (known: ${Object.keys(PROVIDER_STUBS).join(', ')})`);
    return EXIT.failed;
  }
  if (flags.live === true || flags.live === 'true') {
    io.err('refused: --live is the milestone proper — this scaffold makes no network calls and holds no approval to start');
    return EXIT.refused;
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(taskPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`refused: cannot read task file — ${reason}`);
    return EXIT.usage;
  }
  const task = /** @type {{ prompt?: unknown, granted_capabilities?: unknown }} */ (raw);
  if (typeof task.prompt !== 'string' || task.prompt === '') {
    io.err('refused: task file needs a non-empty string prompt');
    return EXIT.usage;
  }
  const granted = Array.isArray(task.granted_capabilities) ? /** @type {string[]} */ (task.granted_capabilities) : [];
  const context = buildContext({
    rules: DEFAULT_RULES,
    tool_id: 'model.invoke',
    granted_capabilities: granted,
    budget: { exceeded: false },
    approval: { status: null },
    complete: true,
  });
  const decision = decide(
    {
      action: 'model.invoke',
      target: providerId,
      requested_capabilities: ['model.invoke'],
      effect_class: 'read_only',
      requested_by: 'model-invoke',
    },
    context,
  );
  if (!permitsExecution(decision)) {
    const refusal = new ModelPolicyError(decision);
    io.err(`refused: ${refusal.message}`);
    io.err(`decision    ${refusal.decision.arm_id} ${refusal.decision.outcome} (${refusal.decision.reason_code})`);
    return EXIT.refused;
  }
  try {
    const module = await loader();
    const credentials = getCredentials(providerId);
    if (providerId === 'local') {
      const result = /** @type {{ localModel: (prompt: string) => { answer: string, echo: string } }} */ (module).localModel(task.prompt);
      io.out(JSON.stringify({ taskId: taskPath, provider: 'local', ...result, credentials: { source: credentials.source, apiKey: maskSecret(credentials.apiKey) } }, null, 2));
      return EXIT.ok;
    }
    const result = /** @type {{ query: (prompt: string) => { provider: string, answer: string, echo: string } }} */ (module).query(task.prompt);
    io.out(JSON.stringify({ taskId: taskPath, ...result, credentials: { source: credentials.source, apiKey: maskSecret(credentials.apiKey) } }, null, 2));
    return EXIT.ok;
  } catch (err) {
    if (err instanceof StoreError || err instanceof ModelPolicyError) {
      io.err(`failed: ${err.message}`);
      return EXIT.failed;
    }
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`failed: ${reason}`);
    return EXIT.failed;
  }
}
