# Gemini live transport

## What it is

`queryLive` in `src/model/provider/gemini.mjs` sends one generateContent
request to
`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`
and returns `{ provider, answer, echo, model }`. The stub `query` in the
same file is unchanged and stays the default path of `lain model invoke`.
`gemini-1.5-flash` is the free-tier model: an AI Studio key carries a
genuine $0 quota, which is why Gemini is the provider the live tests may
actually call.

## The gate

Same as OpenAI's: `lain model invoke <task.json> gemini --live --approval
<decision-id> --ledger <db-path>` asks the engine under
`model.invoke.external`. The M-6 ledger's `granted` record, named by
decision id, is what turns A5 into A5b; the task must also hold the
`model.invoke.external` capability itself (A6b outranks A5b). Gemini needs
no funding flag — its free tier costs nothing — so the only switches are
the engine's.

## Credentials (Decision #1: Option A)

`AGY_ACCOUNT` holds the raw API key; the repo-root `.env` file is the
fallback (`AGY_ACCOUNT=AIza...`). The key travels in the
`x-goog-api-key` header — deliberately not as a `?key=` query parameter,
because URLs end up in logs and histories while headers do not — and is
never included in an error message. Masked reporting is `****` + last four
characters.

## Usage

```powershell
# the stub — free, no network (default)
lain model invoke task.json gemini

# the live transport — needs capability, approval record, credential
lain model invoke task.json gemini --live --approval 01M7E8GRANTEDLIVE --ledger %USERPROFILE%\.lain\approvals.db
```

The task file must carry `"granted_capabilities": ["model.invoke.external"]`.

## Tests

`test/model/gemini-live.test.mjs` pins the request shape (endpoint names
the model, `x-goog-api-key` header, `contents/parts/text` body), the
response mapping, the HTTP-error and shape-error paths, and the no-key
refusal — all against an injected `fetchImpl`, no network. The one
real-network test (`AT-M7-26`) runs only when `ALLOW_LIVE=1`; otherwise it
is reported as skipped.
