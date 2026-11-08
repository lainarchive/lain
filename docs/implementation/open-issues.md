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

## Issue 2 — gitleaks is not installed (needs an install decision)

**What is true.** `gitleaks` is absent. `npm run verify` therefore **fails**, by
design, and `npm run check` reports `SKIP: gitleaks full scan` with the note
"this is NOT a clean scan". A conservative nine-pattern scan runs instead and
currently finds nothing.

**Why it matters.** The conservative scan does not read history and does not know
gitleaks' rule set. A secret committed in an earlier commit would not be found by
it. The distinction between "scanned and clean" and "not scanned" is the whole
point of fail-closed reporting, so it must not be blurred in a status report.

**What it needs.** Either an install of gitleaks (a single binary; not installed
automatically by this build), or an explicit decision to accept the weaker gate
and say so wherever verification is reported.

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
