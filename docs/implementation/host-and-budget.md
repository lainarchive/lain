# Host probe and resource admission — implemented behaviour

This document describes the probe and admission layer **as implemented**. The
specification it was built from is
`docs/research/m1-foundation-readiness/03-resource-budget-specification.md`; where
the two differ, this document records what is actually true.

## Why this exists

Two failure modes, both observed in this project's own history:

1. **A remembered number used as a current fact.** The audit measured free VRAM
   swinging between 835 MiB and 3629 MiB on one machine in one session. A model
   "fits" only relative to the moment it is loaded, so a table cannot decide it.
2. **A guess that looks like a measurement.** The audit measured 146 bytes per
   event. Writing "Lain uses about 4 GB" instead of saying whether that is
   measured, configured, recommended or estimated is how a project starts
   believing a number nobody took.

The probe addresses the first; the provenance labels on every number address the
second.

## The probe

`npm run probe` prints versioned JSON; `npm run probe -- --text` prints a readable
summary; `npm run probe -- --volume <path>` measures a different volume.

It collects only what a decision needs: OS, release and architecture; Node version
and modules ABI; CPU model and logical count; total and free memory; GPU name,
total, used, free, utilisation and temperature when obtainable; free and total
space on the project volume; and the SQLite version available through
`node:sqlite`. It does **not** collect usernames, home paths, installed software or
anything else, and a test asserts that neither the user name nor the home path
appears in the record.

**No dependency is added.** GPU data comes from `nvidia-smi` when that binary is
already present and answers within three seconds. When it is absent, refuses, or
returns something unparseable, the field is `unavailable` **with a reason** — not
zero, and not absent. That distinction is load-bearing: "no GPU data" leads
admission to `indeterminate`, while "GPU measured, 200 MiB free" leads to a
denial, and those are different answers.

`LAIN_DISABLE_GPU_PROBE=1` suppresses the GPU probe. It exists so the
"no measurement" path can be tested on a machine that does have a GPU — without
it, a test would assert whatever the host happens to be.

## The budget

Three profiles ship as data in `src/budget/index.mjs`:

| Profile | Intent | Notable limits |
| --- | --- | --- |
| `minimal-background` | One task, nothing resident that is not needed | 1 model call, 1 tool slot, 1 agent, no delegation, 4096 context |
| `standard-development` | Interactive work with a model resident | 1 model call, 3 tool slots, 4 agents, depth 2, 4096 context |
| `higher-resource-workload` | A deliberately heavy run | same counts, 8192 context, larger data budgets |

Every limit is a `{ value, kind, note }` triple where `kind` is one of `measured`,
`historical`, `configured`, `recommended` or `estimated`. A test asserts that no
limit is `estimated`: this file contains no guesses, and anything that would be
one is left absent instead.

**A configured budget can only tighten what a measurement allows.** That is a
tested property, not an intention. The `standard-development` model budget is 4
GiB, and on a machine with 5389 MiB of free VRAM the usable figure is
`5389 − 768 = 4621 MiB`, so a request for 4.5 GiB is admitted even though it
exceeds the default budget when the budget is raised — because it genuinely fits
the hardware. Raising the budget never makes more VRAM exist.

## Admission

`admit(budget, request)` returns exactly one of three outcomes:

- **`admit`** — every configured limit holds and every required measurement is
  present.
- **`deny`** — with a `reason_code` naming the limit that refused it
  (`TOOL_SUBPROCESS_LIMIT`, `LIVE_AGENT_LIMIT`, `CONTEXT_LIMIT`,
  `MODEL_MEMORY_LIMIT`, `VRAM_INSUFFICIENT`, `DISK_INSUFFICIENT`).
- **`indeterminate`** — a required measurement is missing (`GPU_UNMEASURED`,
  `DISK_UNMEASURED`). This is deliberately not a denial: one means "no", the other
  means "Lain cannot tell", and collapsing them would make an unmeasured machine
  look like a refused request.

**It never adapts.** A refused request for an 8192-token context does not come
back with 4096 tokens; it comes back refused, with the reason. The same applies to
model substitution, precision changes and execution-mode changes, because each of
those changes what a result means. A test asserts that no `effective_*` field
appears in a refusal.

**It is deterministic and independent of the model.** Admission reads numbers; no
model output is an input, and no model can argue past a limit.

## Verification

`node --test --test-reporter=spec "test/host/*.test.mjs" "test/budget/*.test.mjs"`
→ 35 tests, 35 pass, 0 fail, using fixtures rather than this machine. The cases
that matter are the negative ones: unmeasured memory, a missing GPU tool, an
unparseable GPU reading, an invalid profile, an override of a limit that does not
exist, a request over each limit, and an indeterminate request that must not
silently become an approval.

`npm run probe` was also run against this machine, because a fixture-driven suite
proves the logic and not the plumbing:

```
probe schema 1  probed_at 2026-11-08T20:00:53.639Z
os          win32 10.0.26200 x64
runtime     node 24.21.0 (modules 137)
cpu         Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz x4
memory      total 17049010176 bytes, free 7755284480 bytes
gpu         measured — NVIDIA GeForce RTX 3050, 5393 MiB free of 6144
disk        measured — 78574882816 bytes free of 997400309760
capabilities sqlite:3.53.4
```

## Known limitations

1. **Free memory is `os.freemem()`.** It does not account for the page file, and
   it includes memory the OS will reclaim. It is a measurement, but a coarse one.
2. **Nothing enforces the budget yet.** Admission returns a decision; no code
   consumes it to limit a running process. There is no process to limit until M-2.
3. **`%TEMP%` has no quota.** A contained process would have an unbounded writable
   region; that must be set before any containment work.
4. **The probe measures capacity, not performance.** Load time, tokens per second
   and tool-call conformance are not measured here and are not claimed.
5. **Historical measurements are kept as `HIST`** in `RESOURCE_BUDGET.md` and are
   never used as limits. A `HIST` value must be re-measured before a decision uses
   it.
