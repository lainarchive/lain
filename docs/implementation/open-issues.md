# Open issues

## Node verification after the neural dashboard merge

On Linux with Node 26.13.1 and gitleaks 8.30.1, the post-dashboard cleanup and
unchanged `main` (`9fa3e6e`) both report `checks=8 pass=5 fail=3` under
`npm run verify`. The same twelve Node tests fail in both worktrees. The
format gate flags an existing 236-character line in the Rust dashboard tests
(`crates/lain-cli/src/dashboard.rs:783`, limit 200). The history scan reports
one finding in both worktrees; that finding needs separate triage.

## Rust memory port verification on Linux

The owner-approved `lain-memory` port encountered existing Node gate failures on
Ubuntu with Node 26.13.1. Unchanged `main` (`3c63800`) and the Rust branch both
report `tests 433`, `pass 385`, `fail 12`, `skipped 36` under `npm test`, with
the same failing test names. No Node runtime or existing test was changed.

Failures: AT-V2-APR-03, AT-V1-E2E-01/02, AT-V2-CAN-05,
AT-V3-BND-06/07, AT-V3-HL-09/03, AT-V1-TOOL-08/10, the hard-link
directory-listing refusal test, and the malformed GPU reading test. Examples:
`INTERPRETER_MISSING` names `C:\Python315\python.exe` on Linux; the GPU
fixture receives `nvidia-smi could not be run (ENOENT)` instead of a parse
failure. These need a separate platform-fixture/guard review, not changes in
the memory port.

`gitleaks` is absent here. Both unchanged main and the Rust branch also report
three fallback `assigned-secret` candidates in existing synthetic fixtures:
`test/model/credentials-dpapi.test.mjs:90`,
`test/model/gemini-live.test.mjs:24`, and
`test/model/openai-live.test.mjs:26`. Neither advisory `npm run check` nor
required `npm run verify` passes (`checks=8 pass=6 fail=2`). No secret-scanner
suppression or unrelated test fix was added. Full-history scanning remains
unverified; rerun on the intended Windows environment with gitleaks installed.

Evidence: `artifacts/verify/rust-node-tests.log`,
`artifacts/verify/rust-baseline-node-tests.log`,
`artifacts/verify/rust-baseline-secrets.log`, and
`artifacts/verify/rust-check.log` (local ignored verification logs).

Known limitations and unresolved guarantees, with what each one needs. An issue
is closed only by evidence; a limitation that is documented is still a
limitation, and it is listed here so that no claim depends on the reader not
knowing about it.

## Issue 1 — The working tree mixes LF and CRLF (needs a decision)

**What is true.** The repository runs with `core.autocrlf=true` (set globally).
The canonical documents were committed by earlier sessions and are checked out
with CRLF in the working tree; the four files whose content this task wrote are
LF. A `.gitattributes` file has been prepared with `* text=auto eol=lf`, but it
is **not committed**, and nothing renormalises the existing files until it is.

**Why it matters.** With `core.autocrlf=true`, a working-tree byte read is not a
Git byte. Any future integrity work — comparing a file's hash against a recorded
one, or verifying a manifest — has to know which form it is comparing. The
verification system works around this rather than fixing it: `format` reports
legacy CRLF files but does not enforce LF on them.

**What it needs.** A decision from the project owner: commit `.gitattributes`,
then run `git add --renormalize .` as a separate, reviewed step and commit the
result. That rewrites the working-tree form of the existing documents (no content
change, a large diff), so it is not something to slip into another commit. Until
then, `npm run check:format-strict` shows exactly how many violations are
outstanding.

## Issue 2 — CLOSED: gitleaks is installed, and the gate produced a real verdict

**What was true.** `gitleaks` was absent, so `npm run verify` failed by design and
`npm run check` reported `SKIP: gitleaks full scan` with the note "this is NOT a
clean scan". A conservative nine-pattern scan ran instead.

**What closed it.** The owner approved the install (D-P9, 2026-11-08). gitleaks
**8.30.1** is installed via `winget` as `Gitleaks.Gitleaks`, and `npm run verify`
now **exits 0 with `checks=8 pass=8 fail=0`** — the first time that gate has ever
produced a verdict rather than a refusal.

**What it found, and what that taught.** Two findings, both on
`test/store/redaction.test.mjs:70` in commit `e01dbb2`: the synthetic JWT fixture
belonging to the test that proves secrets never reach the store. The M-1 author
had stored that fixture as a base64 blob decoded at runtime, so the file would
contain no secret text — and gitleaks found it anyway, because its `jwt-base64`
rule **decodes base64 before matching**. The defence assumed a scanner that reads
text; the real one decodes. The fixture is now built from its three segments at
runtime (same 123-character token, no encoded blob in the file) and the store
still redacts it as `redacted:jwt`.

**What remains, and its limit.** The old blob is still in history, and
`gitleaks detect` scans commits, so `.gitleaksignore` carries exactly two
fingerprints naming those two findings on that one line. Nothing else is
suppressed: a real secret added to that file or any other does not match, and if
the fixture line changes the entries stop matching and the finding returns. The
lesson is recorded rather than the symptom hidden — **a scanner that decodes
defeats a defence that only obfuscates**, and "no leaks found" means no known
pattern matched, not that the repository is proven clean.

## Issue 3 — The two `package.json` guarded checks are policy, not proof

**What is true.** `repo-hygiene` enforces that no dependency outside the approved
list is installed, and the list contains exactly two development dependencies.
That is a policy check: it stops an unapproved dependency being added silently.
It does not and cannot prove that either dependency is trustworthy.

**Why it matters.** `typescript` and `@types/node` execute during development
(`typescript` runs as a program). A compromised release of either would run with
this project's privileges. The mitigation is pinning (`typescript` is pinned
exactly; `@types/node` uses a caret range) plus the lockfile.

**What it needs.** Nothing urgent. If the project later requires stronger
supply-chain guarantees, the options are exact pins for both, a lockfile-integrity
check in CI, and `npm audit --omit=dev` (which is vacuous today: there are no
runtime dependencies).

## Issue 4 — The event store's ownership model is a recommendation, not a decision

**What is true.** `docs/research/m1-foundation-readiness/02-security-and-containment.md`
recommends that a distinct Event Store own event persistence and ordering, with
the Policy Engine alone owning authorization. The canonical ownership table in
`SYSTEM_BOUNDARIES.md` still has **no row for events**, and the words
"single writer" appear nowhere in the canonical documents.

**Why it matters.** The measured cost of that gap is 963 torn reads in 1 766
observed writes when commits are per-document rather than batched. The
implementation can proceed — the store does not need a canonical row to be
correct — but a reader of the canonical documents would not know the store is
supposed to exist, or that only one writer may hold it.

**What it needs.** A canonical edit (one table row plus one normative sentence)
and, if the recommendation is adopted, a decision record. Both are outside this
task's authorization; the implementation records the rationale here instead.

## Issue 5 — No containment mechanism is implemented

**What is true.** Nothing in this repository contains a process, restricts a
token, or starts a job object. The containment research (low-integrity token plus
mandatory integrity control, Job Objects for process-tree ownership) is verified
as a *mechanism* on this machine but is not exercised by any code here.

**What it needs.** M-2. Until then, no document in `docs/implementation/` may
describe this project as isolated, containerised, sandboxed or contained.

## Issue 6 — The format policy deliberately does not cover the canonical documents

**What is true.** `npm run check` passes while the canonical documents contain
long lines and CRLF endings. Those violations are counted and printed as "NOT
ENFORCED".

**Why it matters.** A reader could believe the repository satisfies its own
formatting policy. It does not; it satisfies the policy on the files this task
owns, and the report says so out loud.

**What it needs.** Issue 1's decision. No separate action.

## Issue 7 — An explicit backup briefly releases single-writer ownership

**What is true.** `node:sqlite`'s backup job cannot run while the store holds its
long-lived write transaction; measured, it rejects with `errcode 0` and
`errstr "not an error"`. `backup()` therefore releases the lock for the duration
of the copy and re-takes it immediately afterwards with `claimWriteLock`, which
throws `STORE_LOCK_LOST` if another process became the writer in that window. So
during a backup there is a real gap in the single-writer guarantee.

**Why it matters.** The guarantee this store sells is "one writer, always". A gap
that exists only during an explicit, operator-initiated backup is small — but it
is a gap, and it is documented here rather than left for someone to discover from
the code.

**What it needs.** Either accept the documented gap, or give backups their own
read-only connection so the writer lock is never released. The second option is
untested work.

## Issue 8 — No retention policy and no compaction

**What is true.** Events accumulate without bound. The measured cost is about
146 bytes per event, so the documented 2 GiB warning threshold is roughly
14.7 million events. Nothing deletes, archives or compacts.

**Why it matters.** Storage exhaustion is a failure mode the specification asks
the store to handle, and it is currently handled only by a warning threshold with
no enforcement.

**What it needs.** A retention decision (`08-open-decisions.md` OQ-M1.7/OQ-M1.13)
before this store holds production volume.

## Issue 9 — No tamper-evidence chain

**What is true.** `payload_hash` detects an edited payload because verification
recomputes it, and a deleted row shows up as a sequence gap. An attacker who
rewrites both the payload and its stored hash is not detected.

**Why it matters.** It bounds what "integrity verification" may claim: this is
consistency checking, not tamper evidence. The distinction matters for any future
claim that the log can be trusted against a hostile local actor.

**What it needs.** The hash-chain decision (`08-open-decisions.md`
OQ-M1.6/OQ-M1.21). If it is wanted later, it should be noted that adding it only
for new batches weakens it — the cost of delaying is real, not zero.

## Issue 10 — CLOSED: `lain approve` prompts through the ledger

**What was true.** `src/policy/approvals.mjs` implemented the approval contract — a
binding over `{action, tool_id, target, effect_class, task_id}`, a 60 s window,
`request`/`answer`/`statusFor`, and a timeout becoming `timed_out` — but nothing
prompted through it. The only approval a running task could receive was
`lain task run --allow <tool_id>`, a command-line flag rather than an answer to a
question, and not bound to any request digest.

**What closed it (V-2, commit `d2f152a`).** `src/cli/commands/approve.mjs` presents the
bound question and answers it, with `--list` for what is outstanding. An answer must
carry the digest of the question it answers; a digest belonging to a different question
is refused rather than reused. A2 is reachable in a real run now: a closed window is
`timed_out`, arm `APPROVAL_TIMED_OUT`, `deny_indeterminate`, `retryable: false`, and
there is no `--retry`, because "wait forever" is not an answer either.

**What it deliberately did not do.** `--allow` still exists for non-interactive use, and
it is recorded as flag-shaped: `decided_by: 'flag:<cli>'` with `decided_source: 'flag'`
stored on the record, so a reader of `approvals.json` need not know that the prefix
encodes "no person answered". A prompted answer reads `human:<name>`. That distinction
was a finding from the same stream: the runner had been synthesizing a granted status
for `--allow`, which made a flag indistinguishable from a person in the log.

## Issue 11 — Reads are confined when the kernel posture is prepared, and unrestricted otherwise

**What was true.** Inside its workspace a task process could read any file the
running user could read, and it could reach the network. Neither was restricted by
any mechanism; both were stated as limitations in `SECURITY_MODEL.md` §10.

**What changed (V-3, commit `347e013` and the container work that follows).** The
tool now runs inside a Windows **AppContainer**, so the read boundary is an ACL check
performed by the object manager rather than a path check in the runner. Measured
from inside a live container, positive control in the same run: a granted directory
reads; `C:\Users\frick`, `C:\Users\frick\.ssh`, `%TEMP%` and `C:\Program Files\nodejs`
all fail with `EPERM` (errno `-4048`); `C:\Windows\win.ini` stays readable. The
denial code matters: `EPERM` and not `ENOENT`, so a tool cannot report "no such file"
where the truth is "you may not read this".

**What is still open, and it is the honest half of the issue.**

- **Reads are only confined under the `kernel` read posture.** An unset posture
  refuses to run at all; `declared` records that reads are unrestricted. A deployment
  that has not prepared a container therefore still has the V-1 behaviour, on purpose
  and on the record.
- **The grants are read access.** Every directory a confined tool must read is a
  directory it can read, so the boundary is a list, and the list is the security
  argument. `C:\Windows` is on it by necessity.
- **A tool that spawns something needs that thing granted too.** The image exemption
  covers the process the supervisor creates and nothing below it.
- **Network access is unchanged.** It is policy-only, as before; the container was not
  measured for network behaviour and nothing here should be read as network isolation.
- **The container is not a sandbox.** `SECURITY_MODEL.md` §10 carries the four limits
  beside the claim, and the sentence that survives every measurement in V-3 is still
  "Lain is not a sandbox."

**What it still needs.** Network isolation, investigated separately as the V-3 brief
required rather than folded in. And the mechanism needs to survive a machine where
the profile cannot be prepared — which must be a refusal, and is tested as one.

## Issue 12 — CLOSED for what a job object can actually enforce

**What was true.** Every task carried a budget with `max_processes`, `max_wall_ms`,
`max_output_bytes` and `max_model_calls` ceilings, and the runner passed the
wall-clock and output limits down to `workspace.run`. There was **no Job Object**, so
process count, process memory and total job time were recorded ceilings with no
mechanism behind them.

**What closed it (V-2, commits `d2f152a` and `a6911bf`).** `tools/win32/job_host.py`
supervises the tool through a job object: the tool is created suspended, assigned, then
resumed, so it cannot run or spawn anything outside the job; the supervisor holds the
handle with `KILL_ON_JOB_CLOSE`, so killing the supervisor reaps the tree. Process memory
and job time are enforced. The approval gate above and the cancellation cascade close the
other two V-1 gaps.

**What remains unenforced, and is now said by the code rather than implied.** `CEILINGS`
in `src/exec/limits.mjs` carries one row per ceiling with an `enforced_by` value, and
three rows are `none` with the measurement that put them there:

- **`max_processes`** — `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` counts the process doing the
  spawning, so a limit of 1 fails its first `CreateProcess` with `WinError 1816
  ERROR_NOT_ENOUGH_QUOTA` and breaks every tool that legitimately spawns. Bounded instead
  by the number of tool runs.
- **The per-process time ceiling** — `JOB_OBJECT_LIMIT_PROCESS_TIME` never fires. An 8.04 s
  burn under a 1000 ms ceiling ran to completion, exit 0. Total job time is used instead,
  and it is user-mode CPU time, so it does not bound a sleeping tool.
- **The tool-call ceiling at the tool layer** — read by `src/tools/invoke.mjs` and never
  advanced, so a positive ceiling could not be reached. The task runner now spends one
  counter per invocation at admission, where a refusal happens before a workspace exists.

Two limitations belong here too rather than in a footnote: job-time overshoot is
load-dependent (measured 2.07 s to 8.13 s for a 1000 ms ceiling over an 8 s burn), and
the supervisor is a soft target — anything holding its PID can kill it and anything that
can write the helper can change what it enforces. The helper hash and the settle record
make tampering visible, not impossible.
timeout and by whatever its parent process does when the timeout fires.

**Why it matters.** `RESOURCE_BUDGET.md` describes three profiles and the
admission layer refuses on them, so the numbers look enforced. The honest
statement is: two of the five ceilings are enforced by a timer and a buffer, and
three are recorded intent.

**What it needs.** The Job Object work (Tier 1 containment), which is M-2 scope
and is not authorized yet.
