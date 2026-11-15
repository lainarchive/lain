/**
 * @generated
 * @purpose  `lain model invoke <task.json> <provider>` — stub routing (M-7 scaffold) and --live transport under the external gate (M-7 proper)
 * @requires Chief-of-St
 */
import { existsSync, readFileSync } from 'node:fs';
import { StoreError } from '../../core/errors.mjs';
import { ModelPolicyError } from '../../model/integration.mjs';
import { decide, permitsExecution } from '../../policy/decide.mjs';
import { buildContext, DEFAULT_RULES } from '../../policy/rules.mjs';
import { getCredentials, maskSecret } from '../../model/provider/credentials.mjs';
import { createPersistentLedger } from '../../model/persistentLedger.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

/**
 * The provider modules this command can route to. Each entry exposes the M-5
 * stub `query` and — for openai and gemini — the M-7 live `queryLive`; the
 * stub stays the default so a forgotten flag can never cost money.
 *
 * @typedef {{ query?: (prompt: string) => { provider: string, answer: string, echo: string },
 *   queryLive?: (prompt: string, options: { apiKey: string, fetchImpl?: typeof fetch }) =>
 *     Promise<{ provider: string, answer: string, echo: string, model: string }>,
 *   localModel?: (prompt: string) => { answer: string, echo: string } }} ProviderModule
 */

/** @type {Record<string, () => Promise<ProviderModule>>} */
const PROVIDER_STUBS = {
  openai: () => import('../../model/provider/openai.mjs'),
  gemini: () => import('../../model/provider/gemini.mjs'),
  local: () => import('../../model/localModel.mjs'),
};

const USAGE = `lain model invoke — route one task to a provider

  lain model invoke <task.json> <provider>
      Read the task file, ask the policy engine for 'model.invoke', and run
      the named provider's STUB — a mock answer, no network, no key. The
      credential status is reported masked in the output document.
      Providers: openai, gemini, local.

  lain model invoke <task.json> <provider> --live --approval <decision-id> --ledger <db-path>
      The real transport. The engine answers under 'model.invoke.external'
      (effect class external): the task must hold the model.invoke.external
      capability, and a recorded human approval — found in the persistent
      ledger by decision id with outcome 'granted' — is what turns A5's
      require_approval into A5b's allow_with_conditions. OpenAI additionally
      refuses unless OPENAI_FUNDED=1: it has no free API tier, and $0-first
      blocks unbilled spend. The credential comes from AGY_ACCOUNT or .env
      and is reported masked; it travels only in request headers.

  Exit 0 on success; 3 when the policy refused or a live precondition is
  missing; 4 on an unknown provider or a failed live call; 2 for usage
  errors and unreadable task files.
`;

/**
 * Map a ledger outcome to the approval status the engine consumes. The engine
 * refuses denied (A1) and timed_out (A2) outright; pending and unknown fall
 * through to A5, which asks again — a pending record is not a yes.
 *
 * @param {'pending' | 'granted' | 'denied' | 'timed_out'} outcome
 * @param {string} decisionId
 * @returns {{ status: 'pending' | 'granted' | 'denied' | 'timed_out', approval_id: string }}
 */
function approvalFromOutcome(outcome, decisionId) {
  return { status: outcome, approval_id: decisionId };
}

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }, fetchImpl?: typeof fetch }} args
 * @returns {Promise<number>}
 */
export async function modelInvokeCommand({ command, positional, flags, io, fetchImpl }) {
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
  const live = flags.live === true || flags.live === 'true';
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

  if (live) {
    // $0-first: OpenAI has no free API tier, so its live path stays shut until
    // the owner says the account is funded. Gemini's free tier needs no flag.
    if (providerId === 'openai' && process.env.OPENAI_FUNDED !== '1') {
      io.err('refused: openai has no free api tier — set OPENAI_FUNDED=1 only after the account is funded ($0-first)');
      return EXIT.refused;
    }
    const approvalId = typeof flags.approval === 'string' ? flags.approval : undefined;
    const ledgerPath = typeof flags.ledger === 'string' ? flags.ledger : undefined;
    if (approvalId !== undefined && ledgerPath === undefined) {
      io.err('refused: --approval needs --ledger <db-path> naming the persistent ledger to check it against');
      return EXIT.usage;
    }
    /** @type {{ status: 'pending' | 'granted' | 'denied' | 'timed_out', approval_id: string } | undefined} */
    let approval;
    if (approvalId !== undefined && ledgerPath !== undefined) {
      if (!existsSync(ledgerPath)) {
        io.err(`failed: approval ledger not found: ${ledgerPath}`);
        return EXIT.failed;
      }
      const ledger = createPersistentLedger(ledgerPath);
      try {
        const entry = ledger.list().find((candidate) => candidate.decision_id === approvalId);
        if (entry !== undefined) {
          approval = approvalFromOutcome(/** @type {'pending' | 'granted' | 'denied' | 'timed_out'} */ (entry.outcome), entry.decision_id);
        }
      } finally {
        ledger.close();
      }
    }
    const context = buildContext({
      rules: DEFAULT_RULES,
      tool_id: 'model.invoke.external',
      granted_capabilities: granted,
      budget: { exceeded: false },
      approval,
      complete: true,
    });
    const decision = decide(
      {
        action: 'model.invoke',
        target: providerId,
        requested_capabilities: ['model.invoke.external'],
        effect_class: 'external',
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
    const credentials = getCredentials(providerId);
    if (credentials.apiKey === null) {
      io.err(`refused: no credential for ${providerId} — set AGY_ACCOUNT or the repo .env file (source: ${credentials.source})`);
      return EXIT.refused;
    }
    try {
      const module = await loader();
      const queryLive = /** @type {NonNullable<(typeof module)['queryLive']>} */ (module.queryLive);
      if (queryLive === undefined) {
        io.err(`failed: provider ${providerId} has no live transport`);
        return EXIT.failed;
      }
      const result = await queryLive(task.prompt, { apiKey: credentials.apiKey, ...(fetchImpl !== undefined ? { fetchImpl } : {}) });
      io.out(
        JSON.stringify(
          {
            taskId: taskPath,
            live: true,
            approval_id: decision.approval_id ?? approval?.approval_id ?? null,
            ...result,
            credentials: { source: credentials.source, apiKey: maskSecret(credentials.apiKey) },
          },
          null,
          2,
        ),
      );
      return EXIT.ok;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      io.err(`failed: ${reason}`);
      return EXIT.failed;
    }
  }

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
