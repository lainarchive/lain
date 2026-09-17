# lain.

> a local-first development environment for projects, models, agents, memory, and tools.

`lain.` is meant to live quietly on the machine and make development easier. It is not trying to be another chat window. The goal is a single local layer that can understand the machine, work with projects, run specialist agents, use local models, and keep useful context over time.

## status

**Early development — v0.1.0**

The repository currently contains the core Python package, CLI entry point, configuration, agent definitions, project structure, and documentation. Local model integration and the runtime are next.

## architecture

```text
lain.
├── core/       runtime and orchestration
├── agents/     specialist agents
├── models/     local model integrations
├── memory/     persistent context and decisions
├── projects/   project discovery and state
├── tools/      external and local capabilities
└── system/     machine and runtime information
```

Supporting configuration and documentation live outside the package:

```text
config/         default configuration
docs/           vision and agent documentation
scripts/        setup and utility scripts
tests/          automated tests
```

## agents

`lain.` uses quiet specialist agents rather than a collection of personalities.

| agent | responsibility |
|---|---|
| **Yukari** | orchestration and delegation |
| **Rinnosuke** | development and implementation |
| **Patchouli** | research and technical knowledge |
| **Nitori** | systems, hardware, and performance |
| **Keine** | memory and project history |
| **Eirin** | diagnostics and root-cause analysis |
| **Aya** | discovery and web research |
| **Marisa** | experiments and sandbox work |

See [`docs/agents.md`](docs/agents.md) for the full roster and design notes.

## design principles

- **local first** — prefer local models, data, and tools
- **simple on the surface** — complexity belongs underneath
- **useful before impressive** — every subsystem should earn its place
- **reversible changes** — automation should be safe to undo
- **visible state** — know what `lain.` is doing
- **persistent memory** — useful context should survive sessions
- **minimal cloud dependency** — use remote services when they provide a real benefit
- **automation saves time** — the system should reduce work, not create more

## development

Requirements:

- Python 3.11+
- Git

Install the project locally:

```powershell
git clone https://github.com/lainarchive/lain.git
cd lain
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

Run it:

```powershell
lain
```

The current bootstrap output is intentionally small. As the runtime is built, this command will become the main entry point into `lain.`.

## roadmap

### 0.1 — foundation

- [x] repository structure
- [x] Python package
- [x] CLI entry point
- [x] default configuration
- [x] agent roster
- [x] project documentation

### 0.2 — local runtime

- [ ] runtime state
- [ ] system inspection
- [ ] project discovery
- [ ] structured configuration loading
- [ ] command/tool execution layer

### 0.3 — local intelligence

- [ ] llama.cpp integration
- [ ] model discovery
- [ ] model routing
- [ ] inference interface
- [ ] context management

### 0.4 — agents and memory

- [ ] Yukari orchestration
- [ ] specialist agent runtime
- [ ] Keine memory store
- [ ] task history
- [ ] decision log

### 0.5 — development environment

- [ ] project-aware workflows
- [ ] Git integration
- [ ] diagnostics
- [ ] sandbox execution
- [ ] Roblox Studio tooling

### later

- desktop dashboard
- performance telemetry
- automatic model selection
- deeper project indexing
- richer automation

The roadmap is deliberately incremental. `lain.` should become useful one layer at a time instead of trying to build the entire system in one pass.

## license

MIT
