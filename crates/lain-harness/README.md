# lain-harness

Provider-independent building blocks for an evidence-gated parallel harness.
Nothing here dispatches tools, grants permissions or starts a paid model by default.

- `evidence`: staged `StepReport` with a caller-supplied claim boundary. Only a
  prepared report with nonempty, zero-exit test/compiler observations can verify.
- `dag`, `scope`: immutable validated graph, topological layers and lexical
  workspace-relative scopes. Ancestor nodes may share paths; concurrent nodes may not.
  `ScopeGuard` takes trusted read-only and path-only writer predicates. Classify a
  writer only when **all** its effects are bounded by `path`/`file_path`; both are
  checked if present. Unknown tools, shell, `create_tool` and `test_tool` are denied.
  Core currently has no built-in path-only file writer: creator and plugin tools
  execute host code. Lexical checking does not resolve symlinks or sandbox writes;
  retain the existing policy and filesystem containment checks at dispatch.
- `verify`: a dedicated check callback and separate repair callback, with at most
  two repairs and a fresh check after each. The caller owns timeouts/cancellation
  for callbacks; the repair count, not callback duration, is bounded here.
- `worktree`: detached HEAD exploration trees under the Git common directory,
  labeled `detached@<sha>`. Explicit removal returns errors; Drop cleanup is best
  effort. Removal discards all uncommitted changes in that exploration tree.
- `advisor`: optional `Option<Advisor>`, bounded nonblocking note delivery and a
  separate model review task. Full/closed channels increment a shared drop count.
  The caller explicitly chooses the model and starts each review; `None` does no work.
- `abort`: accumulated regex matching, safe-prefix verdicts and bounded restarts
  against `ModelProvider::stream`. A restart discards the aborted attempt, drops
  its stream and appends a system correction. This driver is text-only: tool-call
  deltas are refused, never executed. Stream errors propagate without retry.
- `cache`: append-only committed messages encoded once as JSON Lines bytes.
  Pending tool calls stay in the live tail; completion appends a Tool message.
  Commit refuses unresolved tools. `messages()` returns owned snapshots, so a
  provider cannot mutate committed history. `prefix_bytes()` is the stable cache
  representation, not a promise that every provider preserves wire serialization.

`cargo test -p lain-harness` runs only local fakes and temporary Git repositories.
