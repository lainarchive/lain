# OpenAI live transport

## What it is

`queryLive` in `src/model/provider/openai.mjs` sends one ChatCompletion
request to `https://api.openai.com/v1/chat/completions` with model
`gpt-4o-mini` and returns `{ provider, answer, echo, model }`. The stub
`query` in the same file is unchanged and stays the default path of
`lain model invoke`.

## The gate

The live path is a policy question, not a code path. `lain model invoke
<task.json> openai --live --approval <decision-id> --ledger <db-path>`
asks the engine under `model.invoke.external` (effect class `external`,
requires the `model.invoke.external` capability). The engine answers A5
(require_approval) unless a recorded human approval — the M-6 persistent
ledger's `granted` outcome, named by decision id — turns the answer into
A5b (`allow_with_conditions`, condition
`external_invocation_covered_by_recorded_approval`). A denied record is A1,
a timed-out one is A2, a pending one still asks, and an unknown id still
asks. A granted approval never substitutes for the capability: A6b outranks
A5b.

OpenAI is additionally gated on `OPENAI_FUNDED=1`. OpenAI has no free API
tier — every call costs prepaid credits — so under the $0-first policy the
transport refuses until the owner says the account is funded.

## Credentials (Decision #1: Option A)

`AGY_ACCOUNT` holds the raw API key; the repo-root `.env` file is the
fallback (`AGY_ACCOUNT=sk-...`). `getCredentials('openai')` resolves it
read-only and `maskSecret` reports it as `****` + last four characters —
in command output, in test assertions, nowhere raw. The key travels only
in the `Authorization: Bearer` header, never in a URL, and never in an
error message. Option B (an account reference resolved against the OS
credential store) is the recorded follow-up; the loader's seam
(`getCredentials`) is where it lands without touching the transport.

## Usage

```powershell
# the stub — free, no network (default)
lain model invoke task.json openai

# the live transport — needs capability, approval record, credential, funding
lain model invoke task.json openai --live --approval 01M7E8GRANTEDOAI --ledger %USERPROFILE%\.lain\approvals.db
```

The task file must carry `"granted_capabilities": ["model.invoke.external"]`.

## Tests

`test/model/openai-live.test.mjs` pins the request shape (URL, POST,
Bearer header, `max_tokens: 256`), the response mapping, the HTTP-error and
shape-error paths, and the no-key refusal — all against an injected
`fetchImpl`, no network. The one real-network test (`AT-M7-21`) runs only
when `ALLOW_LIVE=1` **and** `OPENAI_FUNDED=1`; otherwise it is reported as
skipped.
