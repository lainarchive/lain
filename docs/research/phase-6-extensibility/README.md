# Phase 6 — Extensibility: Overview

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · OQ open question.

## Documents

| File | Covers |
|---|---|
| `00-extension-architecture-and-contracts.md` | taxonomy, the three contract layers, component identity, per-type contracts, trust tiers, lifecycle, discovery, installation preview, updates and deprecation |
| `01-creator-mode-and-security.md` | the Creator Mode pipeline and its four gates, failure handling, the consolidated extension security model, acceptance tests, backlog |

## What this phase settles

**EUR.** Lain should *"eventually be able to create, inspect, validate, package, install, activate, update, disable, and remove its own extensions"*, and the user wants **Creator Mode**: *"describe a plugin or capability in natural language, and Lain builds it."*

**EAD.** ADR-012 (creation ≠ activation) is Accepted and is the spine of this phase: the pipeline may generate a component, but authorization and activation are separate decisions made elsewhere.

The three decisions this phase makes, each of which resolves something the current canonical documents leave open:

1. **A package is not a component, and there is no universal executable runtime.** *"A plugin is a package containing components. A component can be a skill, tool, agent, hook, MCP connection or mod"* (Stage 6 research, verified). The package describes what is included; it never grants permission to execute anything.
2. **Requirements are not permissions.** A manifest declares what a component *needs*; the Policy Engine decides what it *gets*, and the effective set is an intersection, never a union. This is what makes "the model cannot grant itself permissions by writing a manifest" structural rather than aspirational.
3. **A mod is a hook with event-transformation scope and a higher trust tier** — not a peer of tool or skill. Interception is a more privileged surface than a normal plugin (Phase 4 F-1.4), so v0.1 ships the tier disabled.

## What this phase deliberately does not do

**ESR.** It does not design a marketplace (a catalog is optional and read-only; the local registry is the only runtime registry), does not define a plugin *execution* format (execution belongs to the runtime, per the Stage 6 research's own §1.2), does not promise sandboxing the machine cannot provide, and does not enable mods in v0.1.

## Dependency summary

Every subsystem in this phase depends on the Capability Registry, grant records, the Policy Engine `decide()` contract and an execution isolation implementation that actually exists — **none of which currently exist** (Phase 4 F-1.1: `ARCHITECTURE.md:157` claims mods use the "existing" contracts, registry, lifecycle, execution isolation and Policy Engine). Items 1–3 of the backlog (identity + registry table, digest-bound grant records, manifest validation) are nevertheless implementable today because they are pure data. See `../implementation-readiness/cross-phase-dependencies-and-sequence.md`.
