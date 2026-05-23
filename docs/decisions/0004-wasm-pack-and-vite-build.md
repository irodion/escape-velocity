# ADR-0004: Build with wasm-pack and Vite

- Status: Accepted
- Date: 2026-05-23

## Context

The project couples a Rust crate compiled to WebAssembly with a TypeScript
frontend ([ADR-0003](0003-vanilla-html-typescript-ui.md)). Three build-tooling
shapes were considered:

- `wasm-pack` (which wraps `wasm-bindgen` + `cargo build`) plus a JS-side
  bundler.
- Raw `wasm-bindgen` CLI with no bundler — serve ES modules as static files.
- [Trunk](https://trunkrs.dev/), the Rust-frontend-oriented bundler.

## Decision

- **`wasm-pack`** builds the Rust crates into a JS/TS package, with TypeScript
  declarations generated from wasm-bindgen.
- **Vite** serves the frontend with a dev server (HMR), bundles for production,
  and — important for slice 8 — provides `vite-plugin-pwa` for the PWA slice.

## Consequences

### Positive

- The best-documented Rust + WASM + TS path; abundant examples and recipes.
- Vite dev server with HMR keeps every slice's iteration cycle fast.
- `vite-plugin-pwa` makes the manifest + service-worker work in slice 8 nearly
  a configuration task rather than a build task
  ([ADR-0009](0009-pwa-as-late-slice.md)).

### Negative

- A bundler is incidental complexity. Some of the build wiring will be opaque
  to first-time readers — though Vite's defaults are sane.
- **Slice 7 trap:** when WASM threads land
  ([ADR-0007](0007-parallelism-via-wasm-threads.md)), the Vite **dev server**
  must also send COOP/COEP headers via `server.headers`, or rayon will only
  work in production builds. This is in the watch-list in the README.

## Alternatives considered

- **`wasm-bindgen` CLI, no bundler.** Rejected. Maximally minimal and
  educational in a "see all the wiring" sense, but pays friction every slice:
  no dev server, no HMR, no TypeScript pipeline (would need a separate `tsc`
  watch), and a hand-rolled PWA story later. Cost outweighs the transparency.
- **Trunk.** Rejected. Trunk shines when the frontend is *also* Rust (Leptos /
  Yew). With a TS frontend ([ADR-0003](0003-vanilla-html-typescript-ui.md)),
  Trunk is working against its grain.

## Related

- [ADR-0003](0003-vanilla-html-typescript-ui.md) — what gets bundled.
- [ADR-0007](0007-parallelism-via-wasm-threads.md) — the dev-server header
  caveat.
- [ADR-0009](0009-pwa-as-late-slice.md) — `vite-plugin-pwa` lands here.
