# Phase 7 — Intelligence Systems: Model Intelligence, Model Foundry, Evaluation Lab, Research Lab

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Companion:** `01-hardware-self-improvement-acceptance.md` (Hardware Intelligence, controlled self-improvement, acceptance tests, backlog, readiness).
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · UNV unverified assumption · OQ open question.

---

## 0. The constraints that shape every subsystem here

| Constraint | Value | Consequence |
|---|---|---|
| Budget | **$0**; unknown pricing or provider restrictions **fail closed** | A model whose cost cannot be established locally is unusable, not "try it and see" (EUR, ADR-005) |
| Local inference | Ollama present (client 0.40.4), **no daemon listening at audit time**, and `ollama ps` listed no loaded model | Discovery must handle "provider absent" as a normal state, not an error |
| Hardware | 4 cores / 4 threads, no SMT; RTX 3050 6 GB; ~15.9 GB RAM | Evaluation is slow and serial; benchmarks must be small, paired, and resumable |
| Model behaviour | A measured **n=50 tool-call study**; a ≤4 B model at 4 096 context is the working assumption, and tool-call reliability is the project's riskiest unknown | Evaluation exists to falsify that risk before more is built on it |
| Provenance | Reproducibility and evidence over assumptions (EUR) | Every result carries model identity, hardware, configuration, dataset version, raw output |
| Honesty | "No claims of success without verification" (EUR) | No ranking, no capability claim, and no benchmark figure may be published without its raw record |

---

## 1. Model Intelligence

### 1.1 What it is

**ESR.** Model Intelligence answers one question with evidence: *for this task, on this machine, under these constraints, which model may be used, and why?* It is **not** a provider list and not a hardcoded preference order. It maintains a local record of what is available and what has been measured, and it never infers a capability from a model's name, size, or marketing.

### 1.2 Discovery (ESR)

| Source | Mechanism | Notes |
|---|---|---|
| Local runtime (Ollama) | local API (`/api/tags`, `/api/ps`) on loopback | Discovery is a *poll of a local service*; absence is a state, not a failure |
| Local model files | filesystem scan of the configured model directory, with digests | Enables identification when the runtime is absent |
| Configured endpoints | user-declared base URLs, **explicitly enabled** | Nothing is probed beyond loopback without an explicit opt-in |
| External catalogs | **read-only metadata only** (name, size, licence, quantization) | No installation, no download, no auto-update; a catalog entry is not a capability |
| Manual registration | a user-recorded model with a known digest and licence | The escape hatch that keeps the system usable without automation |

**ESR — discovery must not become a network dependency.** Model discovery that requires the internet is a discovery mechanism that fails exactly when the machine is offline, which is when a local-first system is supposed to work.

### 1.3 The cost/restriction rule, mechanically (EUR, ADR-005)

Every model record carries a **cost class**, and the classification is by *evidence*, not by name:

| Cost class | Evidence required | Routable when $0-only policy is on |
|---|---|---|
| `free_local` | runs on this machine, no external account | yes |
| `free_remote_verified` | a documented free tier whose terms were recorded locally, with a dated source | yes, if the terms were re-checked within the configured window |
| `trial_or_credit` | limited allowance of any kind | **no** |
| `paid` | any charge | no |
| `unknown` | cost or restrictions not established locally | **no — and this is the important row** |

**ESR — `unknown` fails closed with a recorded reason.** A provider whose pricing cannot be determined locally is not "probably free": the failure of a free-tier assumption is a silent charge, which is exactly the outcome the constraint exists to prevent. The reason is recorded so the user can resolve it once, deliberately, rather than the system re-asking forever.

**ESR — restatement of a practical trap:** a local runtime may expose models that are *not* local (a remote-hosted variant behind the same API). The classifier must therefore verify locality from evidence (the model serves without outbound traffic; the runtime reports it resident) rather than from the endpoint's hostname.

### 1.4 Capability records — declared vs measured (ESR)

Two distinct fields, never merged:

- **Declared capability** (from metadata/registration): context length, modality, quantization, parameter count, licence.
- **Measured capability** (from the Evaluation Lab): tool-call schema adherence, structured-output validity, instruction following, coding pass rate on a fixed task set, retrieval-use quality, latency, tokens/s, peak RAM/VRAM, failure modes.

**ESR — routing may only use measured values for capability claims.** Declared values are used for **hard filters only** (context length, modality, licence allowlist). A model's parameter count is not a capability measurement, and the n=50 study's expected finding — that branding and size do not predict tool-call reliability — is precisely why this separation is structural rather than a stylistic preference.

### 1.5 Health, availability, and the "resident" state

**ESR.** Health is an observation, not a configuration: is the runtime reachable; is the model resident; what is the measured latency of a trivial call; how many consecutive failures; when did it last succeed. Routing consults health **after** hard filters and **before** scoring, and a degraded model is demoted rather than removed — removal would silently change which model produced a result, breaking comparability.

---

## 2. Model Foundry

### 2.1 Scope (ESR)

The Foundry manages **model records and adapters**, and nothing else:

```
model_id             stable local id
identity             provider + name + version/tag + CONTENT DIGEST (pinned)
files                paths + hashes of the local artifact (if any)
provenance           origin, licence, download record or "pre-existing"
runtime_binding      which runtime serves it, and how it is loaded
resource_profile     measured RAM/VRAM at load, at N context, tokens/s
capability_records   declared + measured, linked to evaluation result ids
cost_class           with the evidence that established it
constraints          context limit, licence restrictions, region/terms notes
lifecycle            available → healthy → degraded → unavailable → retired
```

**ESR — pinning is by digest, not tag.** `qwen3-4b-instruct-2507:latest` is mutable; a routine re-pull can silently change behaviour and invalidate every frozen fixture. Every evaluated result and every routed request records the digest it used (audit OD-8).

### 2.2 Adapters (ESR)

One adapter per **protocol**, not per provider:

| Adapter | Serves | Notes |
|---|---|---|
| `openai_compatible_local` | loopback HTTP APIs following that chat-completions shape | one adapter covers many local runtimes |
| `ollama_native` | the local runtime's native API, when it exposes something the compatible surface does not | keeps provider-specific features from contaminating the general path |
| `llama_cpp_server` | a local server binary | no Python, no framework dependency |
| `manual_cli` | a model invoked as a subprocess with a documented I/O contract | the fallback that keeps the system honest about "any local model" |

**ESR — do not build a provider zoo.** A new provider is a new *configuration record* for an existing adapter; a new adapter is justified only by a genuinely different protocol. The audit's warning — "do not turn this into an enormous hardcoded provider list" — is a design rule: the number of adapters is small and stable, and the number of model records is data.

### 2.3 What the Foundry must not do (ESR)

It must not: download without explicit approval and a recorded digest; auto-update a model; delete a model that produced evaluated results (it retires the record and keeps the artifacts); or expose a routing decision that bypasses the cost classifier.

---

## 3. Evaluation Lab

### 3.1 Purpose (ESR)

The Lab exists to make one class of statement impossible: *"model X is better."* It replaces such statements with: *"on task set S (version, digest), hardware H, configuration C, at time T, model X (digest D) passed k/n with raw results R."*

### 3.2 Suites (ESR)

| Suite | What it measures | Size posture (4-core CPU) |
|---|---|---|
| Tool-call conformance | does the model emit calls matching the declared schema; valid JSON; correct argument types; no invented tools | the project's riskiest unknown; ≥ 50 trials per shape, batched and resumable |
| Structured output | schema validity rate, repair rate | small, fixed fixtures |
| Instruction following | adherence to explicit constraints, checked mechanically | small |
| Coding | pass/fail on a fixed, vendored task set, with build commands pinned | smallest set that discriminates; vendored so it runs offline |
| Agent task completion | multi-step tasks in the contained workspace, scored by evidence, not by the model's report | 5–10 fixed tasks |
| Retrieval quality | does retrieval change the answer for the better on tasks with a known answer; **and does absence of retrieval hurt?** | requires a defined metric (the repository has none — audit A-1/AT-052) |
| Security behaviour | does the model refuse/flag injected instructions in tool output; are policy denials respected | paired control + escape, per the E5 method |
| Latency/throughput | tokens/s, time-to-first-token, peak RAM/VRAM, at declared context sizes | measured, reported as distributions with n |

**ESR — every suite has a fixed fixture digest.** A suite whose inputs changed cannot compare runs, and "the benchmark improved" is then unfalsifiable. Fixtures are vendored in the repository (or in a local store with recorded hashes), never fetched at run time.

### 3.3 Reproducibility record (ESR — mandatory per result)

```
result_id, run_id, timestamp, machine_id
model:      provider, name, version, DIGEST
runtime:    adapter, version, load parameters, context size, quantization
hardware:   cpu, cores, ram, gpu, vram_total, vram_free_AT_RUN, other load
fixture:    suite id, version, digest, sample count, sampling order
parameters: temperature, top_p, seed (if supported), max tokens, stop
raw:        the raw responses, stored verbatim (or content-addressed)
scoring:    the scorer version + the rule applied
outcome:    pass/fail per sample + aggregate + failure taxonomy
```

**ESR — the two fields that are usually omitted and must not be:** `vram_free_AT_RUN` (free VRAM on this machine swings **835 MiB → 3 629 MiB** depending on desktop load, so a run without it is not reproducible) and the **seed/decoding parameters** (without them a difference cannot be attributed to the model rather than the sampler).

### 3.4 Methodology rules (ESR)

1. **Paired comparisons.** The same fixtures, the same machine state class, adjacent in time — because the machine is shared with a live desktop and drift is real.
2. **Isolation from load.** Record desktop/GPU load; refuse to compare runs across load classes without flagging it.
3. **No single-sample conclusions.** Every headline figure states n and a dispersion measure.
4. **Resumable batches.** A 4-core CPU will be interrupted; a suite that cannot resume will never finish, and an unfinished suite is not evidence.
5. **Failure taxonomy, not just pass rate.** "Failed 30 %" is useless; "failed 22 % by inventing tool names, 8 % by malformed JSON" is actionable.
6. **Regression fixtures.** Any bug found in production becomes a fixture case with its originating event id.

### 3.5 What the Lab explicitly does not do

It does not rank models on popularity, does not publish a leaderboard, does not compare against vendor-reported numbers as if measured, and does not use a benchmark it cannot run offline.

---

## 4. Research Lab

### 4.1 Purpose (ESR)

Autonomous research with **provable provenance**: every claim in an output traces to a stored source, and every inference is labelled as inference.

### 4.2 Pipeline (ESR)

```
objective → source discovery → retrieval → extraction → claim/evidence separation
   → contradiction detection → synthesis → report (with citations) → retention
```

| Stage | Design rule |
|---|---|
| Source discovery | record *what was searched* (queries, endpoints, date) so "nothing was found" is auditable |
| Retrieval | store the retrieved bytes verbatim, content-addressed; a summary is derived data, never the source |
| Extraction | each extracted statement keeps its source span (offset/length) — a claim without a span is a quotation, not evidence |
| Reliability | per-source provenance class: primary/official documentation, peer-reviewed, reputable secondary, unverified secondary, model-generated. **Never numeric trust scores** — a number implies precision the evidence does not have |
| Contradiction detection | when two sources conflict, both are retained and the conflict is stated; **the system does not average them** |
| Synthesis | every sentence in a report is either cited or marked as inference; the two must be distinguishable by a reader |
| Retention | research memory links objectives → sources → claims → reports, so a later reader can re-derive a conclusion |

**ESR — citation tracking is a data-structure requirement, not a formatting requirement.** If the source span is not stored at extraction time, no downstream formatting can recover it. That is why the span is mandatory at the earliest stage.

### 4.3 Delegation to agents (ESR)

Research work is delegated as ordinary task contracts (Phase 5 §2.1). Two additions specific to research: the contract must state the **source-quality floor** (e.g. "primary documentation only" vs "secondary acceptable"), and the result must attach **retrieved bytes plus spans**, not only prose. A research result whose sources are not retrievable is a claim, not a finding.

### 4.4 The failure mode this subsystem is designed to prevent

**ESR.** A model can produce a fluent, well-cited-looking answer whose citations do not exist or do not say what is claimed. The structural defences are: spans stored at extraction; sources stored verbatim; a validation pass that re-opens each cited span and checks the claim appears in it; and an explicit output class for "asserted but unsupported". Without the validation pass, the system manufactures the appearance of evidence — the most expensive kind of error for a project whose stated standard is verified functionality.

---

*Hardware Intelligence, controlled self-improvement, the acceptance-test plan, the prioritized backlog, and the readiness verdict are in `01-hardware-self-improvement-acceptance.md`.*
