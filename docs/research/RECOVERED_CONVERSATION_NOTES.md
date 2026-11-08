# Recovered Lain Conversation: Source Notes

## Source and integrity

- Original user-provided file: `Pasted text.txt`.
- Archived copy: [`sources/recovered-lain-conversation.txt`](sources/recovered-lain-conversation.txt).
- The source header describes an extracted 352-page PDF conversation plus five signed-in continuation chats. This provenance is reported by the supplied file; completeness and the underlying PDF were not independently verified here.
- The archived copy is 556,115 bytes. Its SHA-256 matches the user-provided file: `C5AAB53C0A033C6D7161F56CDF1718A524FC1E3D428E3638118B48BD83FE1276`.

## How to use it

This is historical source material, not a replacement for the current repository or `DECISIONS.md`. User-authored preferences are evidence of past intent; assistant recommendations and research claims in the transcript are not automatically approved decisions or verified facts. Resolve conflicts using the source-of-truth hierarchy in `AGENTS.md` and record unresolved conflicts explicitly.

## Requirements and proposals surfaced by the recovered chain

- Lain is intended as an independent, local-first, provider-independent AI operating environment, with software engineering as a major capability and practical income-generating work pursued alongside development.
- The user emphasized avoiding unnecessary model activity and accounting for limited hardware. A prior discussion gives an Intel i5-7500, RTX 3050 6 GB, and 16 GB RAM; re-check hardware before treating those details as current.
- The conversation distinguishes tools (capabilities), skills (procedures), plugins (functional extensions), and mods (interface or workspace extensions). The current architecture covers tools, skills, plugins, and MCP, but does not define a mod contract or trust levels.
- Creator Mode was described as researching, designing, building, documenting, testing, and packaging extensions. The transcript also proposes creating agents, tools, skills, mods, and eventual CLI/desktop customizations. Creation must remain separate from approval, installation, and activation.
- Proposed mod use cases include UI and project extensions, routing or retrieval strategies, scheduler and agent-selection policies, observability, and context compaction. Proposed safeguards keep policy enforcement, audit integrity, and spending limits outside ordinary mod control; typed contracts and isolation are discussed.
- The collaboration conversations propose shared Git-backed engineering memory, focused task handoffs, independent review, and a ChatGPT/DeepSeek workflow. Role splits and specialized modes are proposals to refine, not locked decisions.
- Overnight work is framed as bounded continuation of an assigned objective, not open-ended task invention. The transcript calls for explicit objectives, resource/time limits, cancellation, stopping conditions, and a check that completed or stalled agents are no longer consuming resources.

## Reconciliation status

1. Mods are recognized as a distinct extension type. Stage 6 research defines their contracts; the canonical architecture now records their integration with the existing extension platform, registry, execution isolation, and Policy Engine.
2. Collaboration is documented as a proposed service with communication ownership separate from task and agent state. Implementation scope remains future work.
3. Bounded continuation is documented as checkpointing blocked tasks while allowing unrelated, already-authorized work to continue. It does not authorize unattended external operations.
4. Historical hardware, benchmark, and security claims still require verification against original evidence.

The original source review did not itself change architecture decisions. The subsequent reconciliation records the decisions and clarifications made after that review.

## Canonical architecture reconciliation

Stage 6 research already covers Mods and unified extension contracts. The remaining gap is integration into the canonical architecture and system-boundary documents, not a lack of research. Collaboration requirements include shared discussions, direct agent messages, broadcasts, independent reviews, dispute escalation, and a dedicated ChatGPT participant where integrations permit. Bounded continuation means pausing only blocked tasks at checkpoints while unrelated work continues within previously authorized scope. These requirements must reuse existing task, agent, event, memory, and policy ownership rather than create competing authorities.
