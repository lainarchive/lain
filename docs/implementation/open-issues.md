# Open issues

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

## Issue 10 — The approval ledger exists but nothing prompts through it

**What is true.** `src/policy/approvals.mjs` implements the approval contract: a
binding over `{action, tool_id, target, effect_class, task_id}`, a window with a
default of 60 s, `request`/`answer`/`statusFor`, and a timeout that becomes
`timed_out` with `decided_by: 'timeout'`. It has tests. It is **not wired to any
human surface**: the only approval a running task can receive is
`lain task run --allow <tool_id>`, which is a command-line flag, not an answer to
a question, and it is not bound to a specific request digest.

**Why it matters.** A2 (`APPROVAL_TIMED_OUT`) can therefore be reached in a test
but not in a real run, and the difference between "the user allowed *this*" and
"the user allowed this tool at some point" is exactly the property the binding
was built for. Until the prompt exists, V-1's approval story is narrower than the
ledger's design suggests.

**What it needs.** The CLI approval prompt (D-P7) and the decision about where an
unattended run's timeout lands — it is already decided to be `DenyIndeterminate`
and never retried (OD-7); what is missing is the surface that produces it.

## Issue 11 — Reads are unrestricted and the network is policy-only

**What is true.** Inside its workspace a task process can read any file the
running user can read, and it can reach the network. Neither is restricted by any
mechanism; both are stated as limitations in `SECURITY_MODEL.md` §10 and in
`task-execution.md`.

**Why it matters.** The containment claim is about *writes* and about a process
tree a controller can terminate. A task that reads a credential file and writes
its contents into the workspace is not prevented by anything, and the redaction
layer protects the log rather than the process. This is the largest gap between
what Lain's design intends and what it currently enforces.

**What it needs.** A measured mechanism, not a policy statement: closing reads
needs a tool that does not exist yet, and closing the network needs either an
AppContainer/LPAC experiment (Tier 2, unmeasured) or a documented acceptance that
v0.1 cannot do it. Recorded as D-P3's declared out-of-scope items.

## Issue 12 — Nothing enforces the resource ceilings yet

**What is true.** Every task carries a budget with `max_processes`, `max_wall_ms`,
`max_output_bytes` and `max_model_calls` ceilings, and the runner passes the
wall-clock and output limits down to `workspace.run`. There is **no Job Object**:
process count, process memory and total job time are recorded ceilings with no
mechanism behind them. A script that spawns children is bounded only by the
timeout and by whatever its parent process does when the timeout fires.

**Why it matters.** `RESOURCE_BUDGET.md` describes three profiles and the
admission layer refuses on them, so the numbers look enforced. The honest
statement is: two of the five ceilings are enforced by a timer and a buffer, and
three are recorded intent.

**What it needs.** The Job Object work (Tier 1 containment), which is M-2 scope
and is not authorized yet.
