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

### Amendment (P2, #78): what "cancellation" actually means

Slice 6's "cancellation by render-epoch ID" over-promised. What it shipped is
**supersede-on-arrival**: a stale frame's *paint* is discarded (the response
fails the epoch check), but the worker still runs the doomed `compute` to
completion because it processes each message synchronously inside `onmessage`
— its event loop is blocked for the whole frame, so a superseding request
waits in the client's single pending slot until the dead frame finishes. At
8192 iterations on a deep zoom that is multiple seconds of "nothing is
happening".

P2 makes the cancellation *real*. The worker renders a frame as a sequence of
horizontal **bands** (`fractal_core::compute_rows` → the `compute_band` WASM
export), yielding a macrotask between bands so queued messages are observed.
The client posts a lightweight `cancel` (its supersede signal) when a new
request overtakes one already on the worker; the worker tracks the highest
epoch it has seen and **abandons the remaining bands** the moment the
in-flight render is superseded, freeing itself for the latest viewport
immediately. The same band boundaries carry a `progress` heartbeat that drives
a determinate "Rendering NN%" indicator on slow renders. Colorize still runs
**once** over the whole buffer at the end, so the global-normalisation modes
(which key off whole-frame statistics) stay seam-free — partial bands are
never painted. Bands concatenate bit-for-bit to a single `compute`, so the
rendered image is unchanged.

## Consequences

### Positive

- Parallel-iterator code in `fractal-core` is clean once set up — a
  `par_iter()` over pixel rows instead of bespoke tile coordination.
- Teaches genuine shared-memory threading on a non-trivial workload — high
  pedagogical value.
- Cancellation (slice 6) keeps a new pan/zoom from *painting* a stale frame —
  though the worker still computed it to completion; real work-cancellation
  (abandoning the stale compute itself) landed later in P2 (see the amendment
  under **Decision** above).

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
