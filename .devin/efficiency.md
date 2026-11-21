# Token and usage efficiency

**Scope:** every agent session in this repository, every change. Read with `AGENTS.md`, which owns the context-threshold
table and the source-of-truth order; this file does not repeat them.

## 1. Diffs, not rewrites

- Change the lines that need changing. Use range edits; never regenerate a whole file to alter part of it.
- A rewrite is allowed only when more than half the file changes, or the file is new. Say which in the PR.
- Do not reformat, reorder, or re-wrap lines the task does not touch. The format gate does not own the root documents or
  `docs/research/` (`tools/check/format.mjs`, `LEGACY_PATHS`); normalising them in passing produces a large diff nobody
  asked for. Renormalisation is open issue 1 and needs its own commit.
- Do not rename or move files as a side effect. A move is its own commit.
- Prefer one small commit per logical change over one large commit per session.

## 2. Reading

- Search before reading: `rg -n <term> <path>`, then read only the matching range.
- Never print a large file whole. `docs/memory/CURRENT_STATE.md` and the research documents have 400-character lines;
  extract the section you need.
- Read a file once per session and keep the result. Re-reading the same range in different slices costs tokens and
  breaks the cache (section 3).
- Batch independent read-only checks into one turn. Do not repeat a scan whose inputs have not changed.
- Tool output that is only evidence (test logs, verify logs) goes to `artifacts/verify/`; quote the summary line, not the log.

## 3. Prompt caching

Providers cache the longest unchanged prefix of a request. Every edit near the front invalidates everything after it.

- **Stable first, volatile last.** Order context as: system and repository instructions, these playbooks, skills, task
  spec, then working material (diffs, logs, tool output). Never interleave fresh output into the stable block.
- **Do not edit instruction files mid-session.** A change to `AGENTS.md`, `.devin/*.md` or `.agents/skills/*` invalidates
  the cached prefix for every later turn and every concurrent session. Change them in a dedicated commit, deliberately.
- **No volatile values in instruction files.** No dates, counts, SHAs or "currently" claims in `.devin/`; those belong in
  `docs/memory/CURRENT_STATE.md`, which is read on demand.
- **Append, don't rewrite history.** Do not summarise and replace earlier turns to save space unless the session is past
  the `AGENTS.md` handoff threshold; a rewritten history is a cache miss on the whole conversation.
- **Keep the tool set fixed** for the session. Adding or removing tools changes the prefix.
- **Reuse identical text.** When the same spec or file range is needed again, reference the earlier read instead of
  fetching a slightly different range.
- **Live model calls stay double-gated.** Cache savings are never a reason to run a paid transport. `ALLOW_LIVE=1` and
  `OPENAI_FUNDED=1` remain required, and default tests make zero network calls.
- Report cache or token savings only when the provider's usage fields report them (`AGENTS.md`, usage-efficient execution).

## 4. No speculative code

Every line of implementation traces to one of these, and the PR names which:

1. An explicit instruction from the owner in the current task.
2. A task record in `tasks/*.json`.
3. An entry in `docs/implementation/open-issues.md`, `INITIAL_BACKLOG.md` or `IMPLEMENTATION_ROADMAP.md`.
4. An acceptance test in `ACCEPTANCE_TESTS.md` or a research specification under `docs/research/` that the task adopts.

Not allowed without one of those:

- Abstractions, extension points, flags or config keys "for later".
- Placeholder modules, stub functions, `TODO` scaffolding, unused exports.
- New dependencies. Runtime and development dependencies need owner approval and an edit to
  `tools/check/repo-hygiene.mjs`; a candidate in `DECISIONS.md` is not approval.
- Fixing an unrelated defect found along the way. Record it in `docs/implementation/open-issues.md` and keep the diff on task.

If the spec is ambiguous, stop and ask, or record the assumption in the PR under "Assumptions". Do not resolve it in code.

## 5. Commits

Conventional Commits, matching the existing history:

```text
<type>(<optional scope>): <subject>
```

- Types: `feat`, `fix`, `docs`, `test`, `style`, `refactor`, `chore`, `perf`. Scope is the milestone or subsystem
  (`feat(M9): ...`, `fix(store): ...`).
- Subject: lower case, no trailing period, at most 72 characters, says what is now true.
- Body only when the why is not obvious from the diff: the failure that motivated it, the measured number, the decision
  it relies on. Wrap at 100 columns. No change lists that restate the diff.
- One logical change per commit. Never `--amend` or force-push published history.

## 6. Pull requests

Title in commit form. Body, in this order, each section short:

```markdown
## Summary
One to three sentences: what is true after merge that was not before.

## Traces to
The task, issue or spec (section 4).

## Verification
Each command run and its actual result line, e.g. `npm run verify` -> `checks=8 pass=8 fail=0`.

## Decisions and assumptions
Anything the reviewer must approve; "none" if none.
```

- No restating of the diff, no file-by-file tour, no unmeasured claims.
- A PR does one thing. Split a PR that needs two summaries.
