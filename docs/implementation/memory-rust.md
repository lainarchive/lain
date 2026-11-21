# Rust memory store slice

`crates/lain-memory` is the owner-approved synchronous port of
`src/memory/store.mjs`. It does not replace or wrap Node's store, choose an
async runtime, or accept ADR-011. The root Cargo workspace inherits the lints
in `.devin/rust_core.md`; its lockfile is committed. `target/` was already
ignored before this slice.

`MemoryStore::open(path)` accepts a filesystem path or `:memory:`. Its methods
are `remember`, `get`, `search`, `supersede`, `promote`, `link`, `neighbors`,
`provenance`, and idempotent `close`. `MemoryInput`, `SearchOptions`, and
`NeighborOptions` replace JavaScript objects; defaults retain untrusted input,
ten search results, and one graph hop. `StoreError::code()` exposes the Node
domain reason codes. SQLite errors retain their typed cause but error display
is opaque and debug messages are redacted.

The schema, WAL/FULL pragmas, immediate transactions, trust filtering,
supersede history, FTS5 query quoting, UTF-16 length limits, and JavaScript
whitespace set mirror Node. SQLite's default five-second busy timeout is
disabled to match Node's zero timeout. `compat.rs` ports the eight value-secret
patterns used on title/content, the serialized residual-secret backstop,
canonical JSON string escaping, and SHA-256 without extra dependencies.
Link metadata is not redacted, matching Node's existing link behavior.

Generated IDs retain the 26-character ULID layout and process-wide monotonic
ordering. Randomness comes from bundled SQLite's `randomblob` rather than
Node's `crypto.randomBytes`; exact random output is not a compatibility claim.
Rust strings cannot represent JavaScript's lone UTF-16 surrogates, and typed
inputs exclude JavaScript wrong-type/non-integer arguments at compile time.
No other intended store-behavior difference is known.

Approved dependencies: rusqlite 0.43.0 with bundled SQLite, thiserror 2.0.21,
and dev-only tempfile 3.27.0. FTS5 availability, durability pragmas, hashing,
redaction patterns, validation/error branches, rollback, trust changes, graph
cycles, and bounds have unit tests; seven integration tests retain AT-P4-01
through AT-P4-07 as idiomatic `at_p4_*` names.

Verification: `cargo fmt --all --check` exits 0, clippy with `-D warnings`
finishes without warnings, and `cargo test --workspace` reports 13 unit and
7 integration tests passed. The Node type gate reports `type_errors: 0`,
and check self-tests report `checks=8 pass=8 fail=0`. Existing Linux Node and
missing-gitleaks failures are recorded in `open-issues.md`. Rust coverage was
not measured: installing llvm-cov requires separate owner approval. A clean
`cargo build -p lain-memory` with an empty external `CARGO_TARGET_DIR` took
8.71 seconds wall time (Cargo reported 8.70 seconds; dependency downloads
were already cached).

Node coverage (`node --test --experimental-test-coverage "test/**/*.test.mjs"`)
reported line/branch/function percentages of 60.94/93.75/66.67 for
`tools/check/format.mjs`, 39.47/66.67/50.00 for `layout.mjs`, and
34.83/85.71/60.00 for `repo-hygiene.mjs`. `secrets.mjs` was not in that
coverage report; check entry points run in child processes, while the Node
unit suite imports rule helpers. The separate check self-tests and full
gates exercise those entry points, but no coverage percentage is claimed
for them. The coverage run has the same 12 existing Linux test failures.
