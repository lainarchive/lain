# M-1 Verification Closure — README

**Status:** Complete. Independent verification of the reported M-1 Steps 0–3 completion, plus the containment measurement that gates M-2.
**Date:** 2026-11-08
**Scope:** read, measure and document. No M-2 work. One local commit containing corrections and these documents.
**Base revision at the start of this assignment:** `38a5e6699b273dc64dfa84ca41d592dbac34524e` (`main`, 18 commits, working tree clean, 10 ahead of `origin/main`, nothing pushed).
**Doctrine:** a claim is verified only when a command produced the evidence. Everything else is labelled as unverified, advisory, or not testable.

## What this assignment was

The previous turn reported M-1 Steps 0–3 complete. This package does not take that report on trust. It re-derives the repository state, reproduces the verification suite, measures the one guarantee whose wording was ambiguous (event-store writer ownership), proves the backup is restorable, confirms the security gate's behaviour, and runs the containment experiment that gates M-2.

## Documents

| # | Document | Question it answers |
|---|---|---|
| 00 | [Current-state verification](00-current-state-verification.md) | Does the repository match the reported state, exactly? |
| 01 | [Event-store ownership](01-event-store-ownership-verification.md) | Is the guarantee transaction serialization, continuous process ownership, both, or neither? |
| 02 | [Backup restore](02-backup-restore-verification.md) | Is the M-1 backup actually restorable, file by file? |
| 03 | [Security scanner](03-security-scanner-verification.md) | Does the gate fail closed, and does it scan the right things? |
| 04 | [M-1 regression](04-m1-regression-results.md) | Do the checks still pass, with exit codes? |
| 05 | [Low-integrity toolchain experiment](05-low-integrity-toolchain-experiment.md) | Can Node, Git and Python do bounded work inside a Low-IL workspace? |
| 06 | [M-2 readiness review](06-m2-readiness-review.md) | What is satisfied, what blocks, and what must be decided? |
| 07 | [Open decisions](07-open-decisions.md) | Which decisions are now required, and what is the recommendation? |
| 08 | [Final verification report](08-final-verification-report.md) | The consolidated result of the whole assignment. |

## Headline results

- **Repository state: as reported.** `38a5e66`, `main`, 81 tracked files, 0 staged, 0 modified, `[ahead 10]`, no remote operation ever performed.
- **Regression: green, independently reproduced.** `npm test` 110/110 (exit 0); `npm run check` 7 pass / 0 fail / 1 skip (exit 0); `npm run check:self` 8/8 (exit 0); `npm run verify` **exit 1** on the required security gate because `gitleaks` is absent.
- **Ownership: guarantee A, not B.** The store guarantees *one write transaction at a time*. It does **not** guarantee one process owns the writer role continuously. Measured: in three runs, a competing process acquired the lock while the first writer was mid-session after 375, 613 and 649 committed batches; the loser received `STORE_LOCK_LOST` and could not append again. Documentation that said "for the life of its session" was corrected.
- **Backup: restore-verified.** 37/37 files, 934 165 bytes, 0 missing, 0 unexpected, 0 hash mismatches, into an isolated destination that was then removed. The source backup was not modified.
- **Containment: PASS for the write boundary, with stated limits.** Node 24.21.0, Git 2.56 and Python 3.15 all performed ordinary bounded work inside a Low-integrity workspace with no elevation; every write outside that workspace — including into an unlabelled (Medium) directory under the same `%TEMP%` parent — was refused. Reads outside the workspace are **not** restricted by Mandatory Integrity Control; UI/COM escalation was not tested.
- **One earlier conclusion had to be corrected:** a `WRITE_RESTRICTED` restricted token built with **no** restricting SIDs produced a child that exited successfully while doing nothing. Without the flag, the same child did the work.
