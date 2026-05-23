# ADR-0007: Parallelism via WASM threads (rayon), introduced worker-first

- Status: Accepted
- Date: 2026-05-23

## Context

A deep Mandelbrot render at high iteration counts on a single CPU thread takes
hundreds of milliseconds to seconds. Two distinct user-visible concerns flow
from this:

- **Responsiveness.** Compute must not run on the main thread, or the UI
  freezes during every render.
- **Throughput.** Using multiple cores can deliver near-linear speedup on
  embarrassingly parallel per-pixel work.

The choices considered:

- **Multi-worker tiling.** Split the canvas into tiles; one Web Worker + its
  own WASM instance per tile; results posted back as transferable buffers.
  No `SharedArrayBuffer`, so no COOP/COEP requirement.
- **Shared-memory WASM threads via `wasm-bindgen-rayon`.** True
  multithreading inside one WASM module via `rayon`. Requires `SharedArrayBuffer`,
  which the browser only enables when the page is served with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- **Single worker, no multicore.** Off-main-thread but single-threaded.

## Decision

Multicore via **`wasm-bindgen-rayon`** (shared-memory WASM threads).

Introduced in **two slices**, not one:

- **Slice 6:** a single coordinating Web Worker. The compute call runs off the
  main thread, with cancellation by render-epoch ID.
- **Slice 7:** add `wasm-bindgen-rayon` inside that worker for parallel
  iteration. The slice does *not* also carry first-time-worker plumbing.

## Consequences

### Positive

- Parallel-iterator code in `fractal-core` is clean once set up — a
  `par_iter()` over pixel rows instead of bespoke tile coordination.
- Teaches genuine shared-memory threading on a non-trivial workload — high
  pedagogical value.
- Cancellation (slice 6) means a new pan/zoom discards stale tiles instead
  of painting them.

### Negative

- **Constrains hosting.** COOP/COEP requires headers that GitHub Pages cannot
  set. See [ADR-0008](0008-host-on-cloudflare-pages.md).
- **`COEP: require-corp` is contagious.** Every resource loaded by the page
  must be same-origin or send a `Cross-Origin-Resource-Policy` header — no
  Google Fonts CDN, no third-party analytics. The repo should self-host all
  assets from slice 0 so this doesn't ambush slice 7.
- **`wasm-bindgen-rayon` setup is fiddly.** Custom build flags
  (`atomics`, `bulk-memory` target features), and the threadpool init is
  asynchronous and must complete before the first compute call.
- **Vite dev server must send the headers too.** Configure `server.headers`
  in `vite.config.ts`, or rayon will only work in the deployed build.
- The worker-first decomposition means slice 6 lands without delivering
  multicore speed — but it's still a real user-visible improvement
  (responsiveness, cancellation).

## Alternatives considered

- **Multi-worker tiling, no `SharedArrayBuffer`.** Embarrassingly parallel,
  near-linear multicore speedup, *zero* header requirements — would have
  left GitHub Pages unconstrained. Rejected because the educational value of
  learning real shared-memory threading is higher than the deployment
  simplicity it would have bought, and tiling's hand-rolled coordination is
  bespoke knowledge whereas rayon transfers to native Rust work.
- **Single worker only, no multicore.** Rejected. Simplest, fine on shallow
  views, but the project explicitly wants deep zooms to feel good.

## Related

- [ADR-0001](0001-cpu-side-wasm-compute.md) — what gets parallelised.
- [ADR-0002](0002-split-compute-and-colorize.md) — `compute` parallelises; the
  cheaper `colorize` does not need to.
- [ADR-0004](0004-wasm-pack-and-vite-build.md) — Vite dev-server headers.
- [ADR-0008](0008-host-on-cloudflare-pages.md) — the hosting constraint this
  ADR forces.
