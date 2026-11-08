# 03 — Security Scanner and Gate Verification

**Status:** Verified by direct measurement. The gate fails closed.
**Date:** 2026-11-08
**Scope:** confirm that a missing scanner is distinguishable from a clean scan, that the required gate blocks, and that the scan reads only what it should.
**Independent?** Yes — reproduced from the outside, not read from the implementation report.

## Availability

| Probe | Result |
|---|---|
| `gitleaks` on `PATH` | **not found** |
| `%LOCALAPPDATA%\Programs\gitleaks` | absent |
| scoop shims | absent (and `scoop` itself is not installed) |
| chocolatey bin | absent |
| `~/go/bin` | absent; no Go toolchain installed |
| `winget` | **available** (an installation route exists) |

**Nothing was installed.** The assignment forbids automatic installation, and installing a security tool is a change to the user's environment that the user has not requested.

## Behaviour, measured

| Mode | Command | Result | Exit |
|---|---|---|---|
| Advisory (default) | `npm run check` | `[SKIP] secrets` — `gitleaks_available: false`, `files_considered: 78`, `fallback_patterns: 9`, `fallback_hits: 0`, note "this is NOT a clean scan" | **0** |
| Required | `npm run verify` (`--require-security`, or `LAIN_REQUIRE_SECURITY=1`) | `[FAIL] secrets` — "gitleaks is not installed, so full-history secret scanning did not run … the conservative pattern scan above is not equivalent to gitleaks" | **1** |

The distinction the assignment asked for is present in the output itself: advisory mode says `SKIP` and states in words that the result is not a clean scan; required mode fails and names the missing tool. A reader of the log cannot mistake one for the other.

## Scanning scope (verified in code, `tools/check/secrets.mjs`)

- Extensions considered: `.mjs .js .cjs .json .md .txt .yml .yaml .sql .env .sh .ps1 .example`.
- Skipped directories: `.git`, `node_modules`, **`.lain-audit`**, `artifacts`.
  - `.lain-audit` is skipped because it is the user's protected audit evidence and is not Lain's source.
  - `artifacts` is skipped because it holds this tool's own run logs; they are evidence, not inputs, and are never committed.
- Nine conservative patterns run as a fallback (private key blocks, AWS access key ids, GitHub tokens, Slack tokens, Stripe live keys, OpenAI-style keys, Google API keys, JWTs, assigned secrets).
- When `gitleaks` is present the check runs `gitleaks detect --no-banner --redact --source <root>` instead.

## False-positive handling, and a lesson the implementation already learned

During implementation the fallback scanner failed the build **twice on its own test fixtures** — first on the literal probe values inside `tools/check/secrets.mjs`, then on the fixtures inside `test/store/redaction.test.mjs`. The fix in both places is the same: the values are assembled at runtime from base64 fragments, so the file never contains the string it tests, while the test still exercises the exact pattern. `fallback_hits` is now 0 on a clean tree.

This is recorded rather than hidden because it is a general property: **a scanner's test data must not be indistinguishable from the thing it detects**, or the first honest run fails for the wrong reason.

## Recommendation ($0 only)

Install the **prebuilt Windows release binary** from the gitleaks GitHub releases page and place it either on `PATH` or in a repository-external tools directory that the check can find; `winget` is an acceptable alternative on this machine. Both are free. Do not add a paid scanning service, and do not weaken the required gate to make it pass — the gate's current refusal is the correct behaviour while the tool is missing.

## Limitations

- **No full-history scan has ever run on this repository.** The fallback scanner reads the working tree only. `npm run verify` failing is therefore the honest state, not a finding about the repository's contents.
- The absence of `fallback_hits` is **not** evidence that no secret exists; it is evidence that nine specific patterns did not match.
- The scanner skips `.lain-audit` by design. If a secret were ever written there, Lain's own gate would not see it.
- Whether gitleaks' default rules would flag or miss anything in this repository is unknown until it is installed and run.
