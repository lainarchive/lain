# Systems and Rust standards

**Scope:** every Rust crate in this repository. The Core is Node today; Rust is the preferred Core candidate under
ADR-011, which still requires a vertical slice. These standards bind the first Rust line written, including that slice.
They do not themselves accept ADR-011, and the async runtime remains an open item in `DECISIONS.md` until the owner
records it.

## 1. Workspace layout

- One Cargo workspace at the repository root; crates under `crates/`. Library crates hold domain logic; binary crates are
  thin runners.
- Lints are set once in the workspace manifest and inherited (`[lints] workspace = true` in every crate):

```toml
[workspace.lints.rust]
unsafe_code = "forbid"
missing_debug_implementations = "warn"

[workspace.lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
panic = "deny"
todo = "deny"
unimplemented = "deny"
indexing_slicing = "warn"
await_holding_lock = "deny"
dbg_macro = "deny"
print_stdout = "warn"
```

- `clippy.toml` sets `allow-unwrap-in-tests = true` and `allow-expect-in-tests = true`. That is the only exemption.
- New crates need owner approval, the same as Node dependencies. Pin versions in `Cargo.lock`, which is committed.

## 2. Zero unwrap, zero expect

- No `.unwrap()`, `.expect()`, `panic!`, `todo!` or `unimplemented!` in production code, including binaries and build
  scripts. Tests and benches are exempt.
- `unreachable!` needs a comment that names the invariant making it unreachable. If the invariant can be expressed in a
  type, express it there instead.
- Indexing that can panic (`v[i]`, `&s[a..b]`) uses `.get()` and returns an error.
- An `#[allow(clippy::...)]` that relaxes any of the above needs a one-line reason beside it and owner sign-off in the PR.
- A panic in a Tokio task is not recovery. It is a defect.

## 3. Errors

**Domain boundaries use `thiserror`.** Every library crate exposes typed errors:

```rust
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StoreError {
    #[error("store lock lost to another writer")]
    LockLost,
    #[error("event {id} failed integrity check")]
    Integrity { id: EventId },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
```

- Variants map to the machine-readable reason codes Core already uses (`STORE_LOCK_LOST`, `WORKSPACE_LINK_ESCAPES`, ...).
  A reason code is part of the public contract; renaming one is a breaking change.
- A library never returns `anyhow::Error`, `Box<dyn Error>` or `String` errors from a public function.
- Wrap lower-level errors with context at the boundary that has the context, once. Do not re-wrap at every layer.

**Application runners use `anyhow`.** `main`, CLI commands, test harnesses and tools return `anyhow::Result` and add
`.context(...)` naming the operation and the entity. They match on domain errors where the exit code or policy outcome
depends on the variant; they never stringify and re-parse an error.

- Propagate with `?`. Never swallow an error with `let _ =` or `.ok()` unless the comment says why losing it is correct.
- Fail closed. An indeterminate outcome is a refusal, never a retry that hides it (ADR-004, ADR-005).
- Error messages and `Debug` output pass through redaction before persistence, as the Node store does today.

## 4. Async model: Tokio actors

**Actors own state.** A subsystem with mutable state runs as one task that owns it and receives messages. Callers hold a
cheap, cloneable handle.

```rust
pub struct StoreHandle { tx: mpsc::Sender<StoreMsg> }

enum StoreMsg {
    Append { batch: EventBatch, reply: oneshot::Sender<Result<Seq, StoreError>> },
}

impl StoreHandle {
    pub async fn append(&self, batch: EventBatch) -> Result<Seq, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(StoreMsg::Append { batch, reply }).await.map_err(|_| StoreError::Closed)?;
        rx.await.map_err(|_| StoreError::Closed)?
    }
}
```

**Bounded channels only.**

- Every channel is `mpsc::channel(N)` with `N` stated as a named constant and the reason for its size. `unbounded_channel`
  is forbidden.
- Backpressure is the default: producers `send().await`. Where a producer must not wait (a UI observer, a log tap), use
  `try_send` and handle `Full` explicitly: drop and count, or refuse. A refusal that queues silently is worse than one
  that says no.
- Request/response uses `oneshot`. Fan-out to observers uses `broadcast` with a bounded capacity and a handled `Lagged`.
- Observers never block Core. A slow subscriber loses events, not the writer (the same rule as `src/model/eventBus.mjs`).

**Structured cancellation.**

- Every long-lived task receives a `tokio_util::sync::CancellationToken`. Children get `token.child_token()`, so
  cancelling a parent cancels its subtree and nothing else.
- Every loop selects on cancellation first:

```rust
loop {
    tokio::select! {
        biased;
        _ = token.cancelled() => break,
        msg = rx.recv() => match msg { Some(m) => self.handle(m).await?, None => break },
    }
}
```

- No detached `tokio::spawn`. Spawned tasks go into a `JoinSet` or `tokio_util::task::TaskTracker` owned by their parent,
  and the parent awaits them on shutdown with a deadline.
- Cancellation settles the task state to `cancelled` and records it; it is not an error path. The Node runner's measured
  bar is the reference: a 3-second blocking script stopped in 591 ms. A Rust runner that is slower is a regression.
- Every external wait (process, network, provider) is wrapped in `tokio::time::timeout` with a budgeted duration.
- Blocking or CPU-heavy work goes to `spawn_blocking` or a dedicated thread, never onto the async workers.
- No `std::sync::Mutex` guard held across `.await` (`await_holding_lock` is denied). Prefer the actor over a shared lock.

## 5. Verification

Before a Rust change is marked ready for review, all three pass with no output beyond the summary:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

- `--all-targets` includes tests, benches and examples; warnings there fail the gate too.
- Each pass is reported in the PR with its actual result line. "Should pass" is not a result.
- The Node gates in `.devin/workflows.md` still apply while Node code exists in the same change.
