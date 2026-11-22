# Neural dashboard

The Next.js client in this directory uses the Rust daemon's
[Axum bridge](../crates/lain-cli/src/dashboard.rs). It is separate from the
[Node terminal dashboard](../docs/ui/README.md).

## Run locally

From the repository root, using the Node version in [`.node-version`](../.node-version):

```sh
npm --prefix dashboard ci
npm --prefix dashboard run build
cargo run -p lain -- ui
```

Open the local URL printed by the daemon, including its token fragment. Treat
that URL as a credential. The build writes static assets to `dashboard/out/`;
the bridge serves them on `127.0.0.1:4040`. Stop any daemon already using the
same IPC endpoint before starting `lain ui`. See the
[Rust CLI guide](../crates/lain-cli/README.md) for configuration.

## Develop

- `app/` is the Next.js entry point and styles; `components/` contains the dashboard.
- `lib/` holds API contracts, authentication, client state, and tests.
- Regenerate `lib/generated.ts` from the repository root with
  `cargo run -q -p lain-cli --example dashboard-contracts > dashboard/lib/generated.ts`.
- From this directory, run `npm test`, `npm run lint`, and `npm run typecheck`.
