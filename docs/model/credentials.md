# Provider credentials — how Lain finds an API key, and what it does with it

Status: scaffold (M-7). The loaders exist and are gated; no real transport is
wired, so no credential is ever sent anywhere yet.

## Where a credential comes from

`getCredentials(providerId)` in `src/model/provider/credentials.mjs` resolves a
key for `openai` or `gemini` in this order:

1. **`AGY_ACCOUNT` in the process environment.** First by design: the
   environment is per-process, never written to disk by Lain, and visible in
   the task's own audit trail.
2. **A `.env` file at the repository root** (module-relative path, not the
   current working directory). The file is already covered by `.gitignore`
   (`/.env`, `/\.env.*`, `!.env.example`), so a real key can never be staged by
   accident. `.env.example` documents the variable name.
3. **Nothing.** The loader returns `{ source: 'none', apiKey: null }`. That is
   a status, not an error — the scaffold has no transport to feed, and a
   missing key must not crash a lookup.

The loader only ever reads. There is no code path that writes a credential to
the repository, to the state directory, or to any file.

## What is reported, and what is withheld

Every CLI surface that touches credentials prints them through `maskSecret`:

- a key of length 5 or more prints as `****` plus its last four characters;
- a key of length 4 or less prints as `****` (too short to keep any part);
- no key prints as `(absent)`.

`lain model credentials list` therefore shows *where* a key would come from
(`env`, `env-file`, `none`) without ever printing the key itself. The raw value
exists only inside the process that read it.

## The gate is still the gate

`lain model invoke <task.json> <provider>` routes the task through the Policy
Engine under `model.invoke` (read-only, requires the `model.invoke`
capability) before it touches any provider module. Credential resolution
happens after the decision, and its masked form is included in the result
document so the audit trail shows the source without the secret.

`--live` was refused in this scaffold (`exit 3`). The milestone proper has
since landed (M-7, tag `v3.8-live-transport`): the real HTTPS transports run
under `model.invoke.external` with the approval gate described in
`docs/model/openai.md` and `docs/model/gemini.md`.

## Decision #1 — what `AGY_ACCOUNT` holds (decided 2026-11-14)

**Option A, now:** `AGY_ACCOUNT` holds the raw API key, with the repo-root
`.env` as fallback. The owner chose this for the live-transport milestone
because the exposure is already bounded: the key exists only in the process
environment, the AppContainer allow-list (`src/exec/workspace.mjs` `buildEnv`)
already blocks it from leaking into any contained child process, and the
loader plus `maskSecret` keep it out of every report. **Option B** —
`AGY_ACCOUNT` holds a named account resolved against the OS credential store
(Windows Credential Manager, via `cmdkey`/`Credential Management` APIs) — is
the recorded follow-up. The seam is `getCredentials`: its callers never learn
where the key came from, so swapping the resolver does not touch the
transports, the CLI, or the gate.
