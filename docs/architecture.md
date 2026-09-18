# architecture

`lain.` is built around one idea: it should understand the user's working environment, not merely answer isolated prompts.

## operating picture

At any moment, Lain should be able to answer:

1. Who am I?
2. What am I working on?
3. What does the user want?
4. What has been completed?
5. What is broken?
6. What is locked?
7. What am I allowed to touch?
8. What do I not know?
9. What should happen next?

This operating picture is assembled from explicit state rather than guessed from conversation.

## layers

```text
                    ┌─────────────────┐
                    │      user       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Lain runtime  │
                    │ operating       │
                    │ picture         │
                    └────────┬────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
     orchestration       context            authority
          │                  │                  │
       agents            memory             modes
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
       projects            tools              models
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                       local machine
```

## memory architecture

Memory is not one undifferentiated store.

- **facts** — stable information about the environment and projects
- **preferences** — how the user prefers work to be performed
- **projects** — project-specific state and context
- **decisions** — choices and the reasons behind them
- **events** — useful chronological history
- **skills** — operations Lain knows how to perform
- **relationships** — dependencies between projects, tools, and systems

The memory layer should preserve provenance and avoid turning guesses into facts.

## project state

Every registered project should have an explicit state:

- active
- paused
- archived
- experimental

Project state is separate from Git state. A clean working tree does not mean a project is active, and an active project can have uncommitted work.

Each project can also define a **constitution**: rules about what may be changed, what is locked, required verification, and other project-specific constraints.

## decision history

Important architectural and workflow decisions should be recorded with:

- project
- decision
- reason
- date
- affected systems
- whether the decision is still active

This gives Lain a durable answer to "why is it like this?" rather than forcing it to rediscover old reasoning.

## authority modes

### OBSERVE

Inspect and report. No modifications.

### ASSIST

Investigate and propose actions. Changes require approval.

### EXECUTE

Perform actions that fall within the current authority and project rules.

Authority should be explicit and visible.

## checkpoints and reversibility

Before meaningful risky operations, Lain should be able to create a checkpoint representing the known-good state.

The system should prefer reversible operations and retain enough information to explain or restore a change.

## forensics

When something breaks, Lain should have a dedicated forensic path:

```text
observe
  ↓
identify first failure
  ↓
trace dependencies
  ↓
produce diagnosis
  ↓
propose smallest safe action
  ↓
verify
```

Forensics is diagnostic first. It should not immediately rewrite a system simply because an error was observed.

## mission model

Longer work should be represented as a mission with:

- objective
- project
- current phase
- constraints
- completed work
- pending work
- checkpoints
- verification state

This allows Lain to resume work without reconstructing the entire task from scratch.

## project switching

The active project is first-class state.

A project switch should update the relevant context, workspace bindings, rules, and available tools. It should not silently mix context from unrelated projects.

## watch mode

Lain should eventually support passive project watching.

Watchers may detect changes such as:

- Git activity
- test failures
- process failures
- configuration changes
- other registered project events

Observation must respect project rules and authority modes. A watcher should not automatically modify a locked system.

## self-explanation

Lain should be able to explain operational decisions using observable facts:

- what it changed
- why that area was selected
- what constraints applied
- what it verified
- what remains uncertain

This is an explanation of actions and evidence, not hidden internal reasoning.

## model independence

Models remain replaceable components.

Routing, project state, memory, tools, authority, and execution evidence should not depend on a particular model provider or model family.

## non-goals

Lain is not intended to:

- become a giant autonomous agent with invisible authority
- hide system state behind a polished interface
- treat every conversation as permanent memory
- rewrite working systems without understanding their boundaries
- pretend certainty when evidence is missing
