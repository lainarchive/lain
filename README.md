# lain.

```text
local.
quiet.
already running.
```

`lain.` is the layer between the machine and the work.

It keeps projects, models, agents, memory, tools, and system state in the same place. The idea is pretty simple: stop rebuilding the same context every time you sit down to make something.

No SaaS dashboard. No fake productivity language. No twenty-window workflow pretending to be a system.

Just a local environment that gets smarter as it gets used.

---

## underneath

```text
lain.
│
├── core/       runtime
├── agents/     specialists
├── models/     local inference
├── memory/     persistent context
├── projects/   workspaces
├── tools/      capabilities
└── system/     machine state
```

The repo stays boring on purpose. Most of the interesting stuff belongs in the runtime, not in a giant pile of framework code.

---

## agents

Eight specialists live here right now.

| agent | does |
|---|---|
| **Yukari** | coordinates things |
| **Rinnosuke** | writes and changes code |
| **Patchouli** | finds and understands information |
| **Nitori** | watches the machine |
| **Keine** | remembers what happened |
| **Eirin** | finds what's broken |
| **Aya** | goes looking for things |
| **Marisa** | tries weird ideas |

They're not meant to sit around talking to each other. `lain.` gives a task to the right one, gets the useful part back, and moves on.

→ [`docs/agents.md`](docs/agents.md)

---

## what it's becoming

### now

- [x] project skeleton
- [x] Python package
- [x] CLI entry point
- [x] configuration
- [x] agent roster
- [x] docs

### next

- [ ] runtime state
- [ ] system inspection
- [ ] project discovery
- [ ] tool execution
- [ ] proper config loading

### then

- [ ] llama.cpp
- [ ] local model discovery
- [ ] inference API
- [ ] model routing
- [ ] context handling
- [ ] Keine memory

### after that

- [ ] Git awareness
- [ ] project-aware agents
- [ ] diagnostics
- [ ] sandboxing
- [ ] Roblox Studio integration

### eventually

- desktop UI
- telemetry
- automatic model selection
- deeper project indexing
- more automation

Nothing is being built just to make the README look finished.

---

## layout

```text
config/         defaults
docs/           notes
scripts/        utilities
tests/          tests
```

The Python package is under `lain/`.

---

## running it

Python 3.11+.

```powershell
git clone https://github.com/lainarchive/lain.git
cd lain
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
lain
```

Current output is basically a heartbeat:

```text
lain.

good evening.

version      0.1.0
system       Windows ...
models       0
agents       8
projects     0

lain is alive. local intelligence comes next.
```

That part is temporary.

---

## rules

```text
local first
keep it small
keep the context
show your work
make changes reversible
useful > impressive
```

If something can be simpler, it probably should be.

---

## status

`0.1.0` · early development

This is the beginning of it.

---

## license

MIT
