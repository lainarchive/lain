# lain.

```text
quiet software for loud problems.
```

`lain.` is a local development environment that sits between you, your projects, your tools, and your models.

No giant dashboard. No unnecessary ceremony. Just a small system that knows what is going on and can do something about it.

---

## what it is

`lain.` is being built around a simple idea:

> keep the useful parts of a development machine in one place.

Projects. Local models. Agents. Memory. Tools. System information. Automation.

Instead of opening six different things and manually moving context between them, `lain.` should handle the boring parts and stay out of the way when it doesn't need to be involved.

It is local-first by design. Cloud services can be used when they make sense, but they aren't the foundation.

---

## the shape

```text
lain.
│
├── core/       the runtime
├── agents/     specialists
├── models/     local intelligence
├── memory/     things worth remembering
├── projects/   places where work happens
├── tools/      things lain. can use
└── system/     the machine underneath it all
```

Around that:

```text
config/         defaults
 docs/          notes + documentation
scripts/        utilities
tests/          checks
```

Simple enough to understand. Open enough to grow.

---

## agents

There are eight of them for now.

They aren't supposed to feel like a group of chatbots with personalities. They're just names attached to jobs.

| | job |
|---|---|
| **Yukari** | orchestration |
| **Rinnosuke** | development |
| **Patchouli** | research |
| **Nitori** | systems |
| **Keine** | memory |
| **Eirin** | diagnostics |
| **Aya** | discovery |
| **Marisa** | experiments |

`lain.` decides who should handle something, gives them the context they actually need, and keeps the result.

More agents can exist later. They don't get added just because eight looks small.

→ [`docs/agents.md`](docs/agents.md)

---

## what we're building

### foundation

- [x] repository structure
- [x] Python package
- [x] CLI entry point
- [x] configuration
- [x] agent definitions
- [x] documentation

### runtime

- [ ] persistent runtime state
- [ ] system inspection
- [ ] project discovery
- [ ] tool execution
- [ ] proper configuration loading

### intelligence

- [ ] llama.cpp integration
- [ ] local model discovery
- [ ] inference interface
- [ ] model routing
- [ ] context management

### memory

- [ ] Keine memory store
- [ ] project history
- [ ] decisions
- [ ] task history
- [ ] useful long-term context

### development

- [ ] Git integration
- [ ] project-aware workflows
- [ ] diagnostics
- [ ] sandbox execution
- [ ] Roblox Studio tooling

### eventually

- desktop interface
- system telemetry
- automatic model selection
- deeper project indexing
- more automation

The order matters. `lain.` should become useful before it becomes complicated.

---

## running it

You need Python 3.11+ and Git.

```powershell
git clone https://github.com/lainarchive/lain.git
cd lain
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

Then:

```powershell
lain
```

Right now it is intentionally boring.

That will change.

---

## philosophy

**local first.**

**quiet by default.**

**useful before impressive.**

**visible state.**

**reversible automation.**

**keep the context.**

**don't build a feature just because it sounds cool.**

`lain.` should feel less like an app and more like something that has always been sitting on the machine.

---

## status

Early development — `0.1.0`.

Nothing here is pretending to be finished yet.

That's kind of the point.

---

## license

MIT
