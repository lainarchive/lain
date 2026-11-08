# Phase 7 — Intelligence Systems: Overview

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · OQ open question.

## Documents

| File | Covers |
|---|---|
| `00-model-evaluation-research.md` | Model Intelligence, Model Foundry, Evaluation Lab, Research Lab |
| `01-hardware-self-improvement-acceptance.md` | Hardware Intelligence, controlled self-improvement, acceptance tests, backlog |

## What this phase settles

The program brief requires Lain to *"discover, evaluate, and select models"* and to *"perform controlled experiments to improve its capabilities"*, with four permanent constraints that shape this phase more than any other:

- **$0-first, and unknown pricing fails closed (EAD, ADR-005).** Model Intelligence therefore classifies every model into five cost classes, and `unknown` produces a refusal with a recorded reason rather than a hopeful attempt.
- **Evidence over assumptions.** The Evaluation Lab's methodology rules exist because unpublished comparisons are the easiest way to believe something false: paired comparisons, load-class isolation, always stating n and dispersion, resumable batches, a failure taxonomy rather than a pass rate, and regression fixtures captured from real incidents.
- **Resource efficiency on modest hardware.** Hardware Intelligence treats model fit as arithmetic over four measured terms — weights, KV cache, runtime overhead, free VRAM at run time — and fails closed by recording a reason rather than silently shrinking context or swapping to a different model, because either change alters what a result *means*.
- **No unsupported claims.** Model rankings are never published as facts; every result carries model digest, hardware, configuration, fixture version, timestamp, raw output and methodology.

## The three positions most likely to be controversial

1. **No provider zoo (ESR).** One adapter per *protocol* (`openai_compatible_local`, `ollama_native`, `llama_cpp_server`, `manual_cli`), not one per provider. The Stage 3 dependency is a protocol boundary, not a vendor list.
2. **No leaderboard and no numeric trust scores (ESR).** For sources, provenance *classes* and preserved contradictions beat a number that implies precision nobody measured. For models, measured capability informs routing only where a measurement exists.
3. **Self-improvement may change performance, never authority (EUR + ESR).** Lain may propose changes to its own policies, grants, trust tiers, invariants and approval defaults; it may never apply them. The output of the loop is always a proposal artifact for a human decision.

## Dependency summary

Model Intelligence needs a provider abstraction that does not exist; the Evaluation Lab needs pinned model bindings and a resumable runner; the Research Lab needs a source store with spans; Hardware Intelligence needs only a timestamped probe, which is why its backlog items are implementable immediately. See `../implementation-readiness/cross-phase-dependencies-and-sequence.md`.
