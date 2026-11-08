# 02 — M-1 Backup Restore Verification

**Status:** **Restore-verified.** All required checks passed.
**Date:** 2026-11-08
**Scope:** prove the M-1 backup can be restored and that the restored bytes match the recorded manifest. Restoration and integrity only — nothing from the restored copy was executed.
**Independent?** Yes. The backup was created by a different turn and had never been restore-tested.

## Source, destination, safety

| Item | Value |
|---|---|
| Backup source | `C:\Users\frick\Documents\Projects\lain-m1-backup-2026-11-08` |
| Manifest | `MANIFEST.csv` — columns `path, bytes, sha256, copy, verify`; 37 rows |
| Restore destination | `C:\Users\frick\AppData\Local\Temp\lain-restore-verify-2026-11-08` (checked absent before use) |
| Destination class | disposable `%TEMP%` directory, outside the canonical repository, V, W, archive B and `.lain-audit` |
| Source mutation | none — re-verified by file count (39) and manifest hash after the run |
| Execution | none — no script from the restored copy was run, no dependency installed, no second repository created |

## Results

| Check | Expected | Measured |
|---|---|---|
| Manifest format | 5 columns, 37 well-formed rows | 37 rows; 0 malformed (every SHA-256 is 64 hex characters) |
| Manifest statuses | all copied, all verified | `copy = COPIED` ×37; `verify = MATCH` ×37 |
| Manifest byte total | 934 165 | 934 165 |
| Restored files | 37 | 37 |
| Missing files | 0 | **0** |
| Unexpected files | 0 | **0** (37 on disk, all present in the manifest) |
| Size + SHA-256 mismatches | 0 | **0** |
| Restored byte total | 934 165 | 934 165 |
| Directory structure | `docs/` trees reconstructed | `docs/research` = 8 directories, `docs/memory` = 2 files |
| Excluded directories absent | `.git`, `.lain-audit`, `node_modules`, `artifacts` | all absent |
| Symlinks followed | no | 0 reparse points in the destination (the backup contains none) |
| Inspectable as a backup | required files present and parseable | the nine root documents present; `AGENTS.md` first line `# Repository Instructions`; recovered transcript 556 115 B |

**Final result: the backup is restore-verified.**

## What the backup does and does not contain (important)

The M-1 backup was taken during Step 0, **before any implementation existed**. Its own manifest confirms this:

- **Present:** `.gitignore`, the nine canonical root documents, `docs/memory/` (2 files), and all eight research directories including `docs/research/sources/recovered-lain-conversation.txt`.
- **Absent by design at capture time:** `package.json`, `tsconfig.json`, `.node-version`, `.gitattributes`, `RESOURCE_BUDGET.md`, `docs/implementation/`, `src/`, `test/`, `tools/`.
- **Absent by instruction:** `.git` and `.lain-audit`.

So "required project files are present" is true **for the state the backup was taken in**, and the implementation that exists today is *not* in this backup. That is not a fault in the backup; it is a coverage gap between the backup's timestamp and the current HEAD, and it is the one finding of this verification that needs a decision:

> **The only copies of M-1's implementation outside the canonical working tree are the 18 local commits in `.git`, which exist on one disk.** No backup taken since Step 0 contains `src/`, `test/`, `tools/`, `package.json` or the three corrected documents.

## Limitations

- Verification is of restored **bytes**, not of runtime behaviour. A restored copy could contain a file that runs differently; nothing was executed to find out.
- The manifest covers files only. Empty directories, NTFS ACLs, alternate data streams, timestamps and file attributes are not recorded, so restoration of those properties is neither claimed nor tested.
- The backup contains no `.git`, so it cannot reconstruct commit history — only content.
- The restore ran as the same user on the same volume. Cross-machine or cross-volume restoration was not tested.
