# agents

lain. uses a small set of specialist agents. Their names are borrowed from Touhou Project characters; the names are identifiers, while each agent's role stays practical.

## roster

| agent | role |
|---|---|
| **Yukari** | orchestration — coordinates tasks and delegates work |
| **Rinnosuke** | development — code, tooling, and implementation |
| **Patchouli** | research — documentation, technical references, and knowledge |
| **Nitori** | systems — hardware, performance, and local environment |
| **Keine** | memory — project history, decisions, and context |
| **Eirin** | diagnostics — debugging and root-cause analysis |
| **Aya** | discovery — web research and information gathering |
| **Marisa** | experimental — unconventional approaches and sandbox work |

## design

Agents should be quiet specialists rather than personalities that constantly talk. `lain.` decides which agent is appropriate, gives it the minimum useful context, and keeps the resulting state visible.

The roster is intentionally small. New agents should only be added when a recurring responsibility cannot be handled cleanly by an existing one.
