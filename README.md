# lain.

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              lain.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      local development environment
```

A personal system for running models, agents, tools, and projects from one place.

---

## idea

Your machine already has everything scattered across it.

Code in one place. Models somewhere else. Notes somewhere else. Git, terminals, Studio, scripts, random folders, half-finished experiments.

`lain.` is the layer that connects them.

It keeps track of the environment, knows which projects exist, gives work to specialist agents, talks to local models, remembers useful context, and eventually handles the repetitive parts of development.

The interface can stay small. The system underneath doesn't have to.

---

## structure

```text
lain/
│
├── core/       runtime
├── agents/     specialist workers
├── models/     local models
├── memory/     persistent context
├── projects/   project state
├── tools/      things lain. can use
└── system/     machine state
```

```text
config/         configuration
docs/           documentation
scripts/        utilities
tests/          tests
```

Nothing here is meant to hide what the system is doing.

---

## agents

Eight names. Eight jobs.

| agent | role |
|---|---|
| **Yukari** | orchestration |
| **Rinnosuke** | development |
| **Patchouli** | research |
| **Nitori** | systems |
| **Keine** | memory |
| **Eirin** | diagnostics |
| **Aya** | discovery |
| **Marisa** | experiments |

They're specialists, not characters you have to talk to.

`lain.` routes the task, passes the relevant context, and gets out of the way.

→ [`docs/agents.md`](docs/agents.md)

---

## current state

### done

- repository skeleton
- Python package
- CLI entry point
- configuration
- agent roster
- basic documentation
- local project discovery and registry
- live project context inspection

### building

- runtime
- system inspection
- tool execution
- local model support
- memory
- Git integration
- project-aware agents
- Roblox Studio integration

### later

- model routing
- automatic model selection
- sandboxing
- project indexing
- telemetry
- desktop interface

The order isn't sacred. Things move when they're ready.

---

## projects

Project discovery scans configured roots for recognizable project markers and stores a small local registry.

```powershell
lain projects
lain projects scan
lain projects scan --root C:\Users\User\Inkbound --root C:\Users\User\Splice
lain project Inkbound
```

`lain project <name>` resolves a registered project and inspects its live filesystem state. For Git projects it reports the current branch and whether the working tree is clean or modified, along with a bounded top-level structure view and a short README summary when available.

Set `LAIN_PROJECT_ROOTS` to configure roots persistently. On Windows, separate multiple roots with `;`.

The registry is stored at `~/.lain/projects.json`, or at the path specified by `LAIN_PROJECT_REGISTRY`.

---

## local

`lain.` is local-first.

The machine is the default source of truth. Local models, local files, local memory, local tools.

Remote services can be plugged in when they're actually useful.

They just don't get to define the system.

---

## setup

Python 3.11+.

```powershell
git clone https://github.com/lainarchive/lain.git
cd lain
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
lain
```

For now, running it gives you a small status screen.

Eventually, `lain` becomes the place you start.

---

## rules

```text
local first
keep it small
keep context
make changes reversible
show what's happening
build the useful thing
```

No feature exists just because it looks good in a screenshot.

---

## status

```text
version    0.1.0
state      building
models     coming
agents     8
```

`lain.` isn't finished.

That's all.

---

## license

MIT
