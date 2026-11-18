---
name: lain-lead-dev
description: >-
  Lead-developer engineering workflow, code style, policy invariants, and
  verification gates for the Lain repository. Use when planning milestones,
  editing src/ or test/, or preparing commits and handoffs.
---

# Lain Lead-Dev Workflow

## 1. Before Writing Code

- Read `docs/implementation/code-style.md` (reference shape:
  `src/tasks/states.mjs`; reference comments: `src/store/lock.mjs`).
- Check `docs/memory/CURRENT_STATE.md` and `DECISIONS.md` for active
  constraints. Never silently promote a proposed candidate to an accepted
  decision.
- Do not add runtime or dev dependencies without owner approval
  (`tools/check/repo-hygiene.mjs` enforces `ALLOWED_RUNTIME_DEPENDENCIES` and
  `ALLOWED_DEV_DEPENDENCIES`).

## 2. Code Style & Security Invariants

- **Comment voice**: first-person for decisions, record measured facts and
  non-obvious failures, never restate the line underneath.
- **Policy Engine**: default-deny (arms A1-A10). Fallbacks must never weaken
  policy.
- **$0-first**: live paid transports stay double-gated (`ALLOW_LIVE=1` and
  `OPENAI_FUNDED=1`); default tests cost \$0 and make zero network calls.
- **Containment wording**: never describe Lain as sandboxed, containerised, or
  VM-isolated (`SECURITY_MODEL.md` §10).
- **No push without explicit owner permission**; never rewrite published git
  history.

## 3. Mandatory Verification Gates

Run after edits and before reporting completion:

```powershell
node tools/check/types.mjs
npm test
npm run verify
```

`npm run verify` must report `checks=8 pass=8 fail=0` (including gitleaks).
Check `git status -s` to confirm no stray `.db`, `.log`, or `.tmp` artifacts
exist.
