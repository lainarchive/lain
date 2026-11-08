# 00 — Backup and Recovery

**Status:** The backup exists and is **restore-verified for content and Git history**. Genuine independence remains **UNRESOLVED**.
**Date:** 2026-11-08
**Scope:** what protects the M-1 implementation and the 19 local commits, how that protection was verified, and the one thing it does not protect against.
**Verification classification:** VERIFIED (creation, hashing, restoration, history recovery) · UNRESOLVED (off-device independence).

---

## 1. Why this came first

The M-1 Verification Closure found that the only restore-verified backup predated all implementation: `src/`, `test/`, `tools/`, `package.json`, `tsconfig.json` and `RESOURCE_BUDGET.md` were in **no backup at all**, and the sole copy of 19 unpushed commits was one working tree on one disk. That was the largest single risk the closure identified, and it needed no decision to fix.

## 2. Storage reality — measured, and it bounds the claim

| Volume | Type | Size | Free | Label / FS |
|---|---|---|---|---|
| `C:` | Fixed | 928.90 GB | **73.17 GB** | `SynergyOS`, NTFS |
| `D:` | Fixed | 0.40 GB | 0.38 GB | NTFS (functionally unusable) |

`Win32_DiskDrive` reports **one physical disk**: Index 0, `1TB SSD`, 931.51 GB, 5 partitions. `Win32_LogicalDiskToPartition` maps **both** `C:` (Disk #0 Partition #1) and `D:` (Disk #0 Partition #0) to that same disk. No removable media and no USB device are present.

**Therefore a second directory — on either volume — is not independent storage.** `%TEMP%`, `Documents` and a second folder on `C:` all share the disk that would fail. Cloud upload was not authorized and was not attempted.

## 3. What was created

| Item | Value |
|---|---|
| Destination | `C:\Users\frick\Documents\Projects\lain-m2-backup-2026-11-08` |
| Artifacts (kept **outside** the tree) | `…-artifacts\` — `MANIFEST.csv` 59 726 B, `SHA256SUMS.txt` 34 761 B, `BACKUP-INFO.txt` 1 151 B |
| Protection class | **SAME-DISK PROTECTION ONLY — not protection against disk failure** |
| Files | **305** |
| Bytes | **1 920 649** |
| Git history | `.git` included: **19 commits**, HEAD `d5452f1`, branch `main` |
| Included | `.git`, every tracked file, every untracked research document, `.gitignore`, `.gitattributes`, package manifests, source, tests, tools, canonical and research documentation, verification scripts |
| Excluded by design | `.lain-audit` (historical audit evidence, protected in place and already carried by the consolidation backup), `node_modules`, `artifacts` |
| Symlinks encountered | 0 |
| Collision check | destination verified absent before creation; no existing backup overwritten |

## 4. What was verified

- **Manifest re-derived from the files on disk** after the artifacts were moved out of the tree: **305 rows, 305 `MATCH`, 0 `MISMATCH`, 0 `MUTABLE-DRIFT`**, byte total exact.
- **Backup file count (305) equals the source's file count outside the excluded directories (305).** No unexpected file was copied and none was missed.
- **Restoration test** into `%TEMP%\lain-m2-restore-verify-c-2026-11-08` (absent before use, outside the repository and every protected location): 305 files restored, **0 mismatches and 0 missing** against the manifest, and then — from the restored copy alone — `HEAD d5452f1`, **19 commits**, branch `main`, `git diff` empty and `git status --porcelain` empty (an exact copy of a clean repository). `git fsck --strict` reported only the harmless pre-existing `dangling blob e69de29b…`.
- **No script from the restore was executed and no dependency was installed** — the objective was restoration and integrity verification, not execution.
- The disposable destination was removed and its removal verified. The source and every protected location were re-verified afterwards: porcelain 0 entries, archive B at `0e7fdee`, `.lain-audit` 144 files.

## 5. Two defects found in the first attempt — both provenance defects, both fixed

**ESR — recorded because they are the kind of defect that makes a manifest verify nothing.**

1. **The backup contained its own verification artifacts.** The first run wrote `MANIFEST.csv`, `SHA256SUMS.txt` and `BACKUP-INFO.txt` **inside** the destination, so the copied tree no longer matched the source (3 extra untracked files). Fixed by moving the artifacts to a sibling directory: a backup that contains its own manifest is no longer a copy of anything.
2. **`.git/index` was hashed as if it were immutable — it is not.** The restore test reported `MISMATCH: .git/index`, and investigation showed why: `.git/index` is Git's **stat cache**, rewritten by ordinary commands. Its recorded hash was `88FDBEFB…`; after a `git status` ran in the backup directory it became `32B6EAC2…`, and another `git status` changed it again to `9CC7BF24…`. It was hash-stable only while nothing touched the repository. The manifest now classifies that single path as **`MUTABLE-DRIFT`** rather than `MISMATCH`, and the final manifest shows 0 of both because it was re-derived from a quiet tree.

Both fixes were re-verified by a second restore, and the second restore preserved its own evidence until the cause was proven — the first one deleted the copy before the mismatch could be characterised.

## 6. What this backup does **not** protect

1. **Disk failure.** Same physical disk (Disk #0) as the original. A head crash or controller failure loses both.
2. **Ransomware or an account-level compromise**, which reaches both copies with the same credentials.
3. **The working tree's uncommitted state at an arbitrary moment** — it captures the state at creation time, which was clean.
4. **Anything outside the tree** — notably `.lain-audit`, which remains protected only by the consolidation backup W on that same disk, and the vault backup V, also on that same disk.

## 7. Restore procedure (so the backup is usable, not merely verified)

1. Confirm the destination does not already exist; never restore over a live repository.
2. Copy the tree, then verify against `…-artifacts\MANIFEST.csv` with `Import-Csv` — **not** a hand-rolled `Split(',')`, which parses 0 rows because the writer quotes every field (a mistake made once here).
3. Treat `.git/index` as `MUTABLE-DRIFT`: compare the rest, and re-run `git status` only after the comparison.
4. Confirm `git log -1`, the commit count and the branch from the restored copy alone.
5. Do **not** execute anything from the restore.

## 8. Open questions

| # | Question | Why it matters |
|---|---|---|
| OQ-BK-1 | Is removable media (a USB disk) available, or is an authorized off-device copy acceptable? | This is the only route to independence — **the largest remaining protection gap** |
| OQ-BK-2 | Should `.lain-audit` be carried into this backup set, given it is irreplaceable and currently single-copy on the same disk? | It is excluded by design here; its protection depends on one older backup on the same disk |
| OQ-BK-3 | Should commits be pushed to `origin` (11 are local) as a third copy? | Pushing has been explicitly held pending review (m00170); it is also the cheapest off-machine copy available at $0 |
