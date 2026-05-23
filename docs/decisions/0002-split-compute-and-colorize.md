# ADR-0002: Split the pipeline into compute() and colorize()

- Status: Accepted
- Date: 2026-05-23

## Context

A fractal pixel goes through three stages:

```text
viewport coords  →  escape iteration count  →  RGBA color
```

The seam between these stages can be placed in different spots, and the choice
of seam is the single most important interface in the whole application — it
determines what crosses the WASM↔JS boundary, what re-runs when the user
changes a setting, and how cleanly a future GPU slice could slot in.

## Decision

`fractal-core` exposes **two** functions:

- `compute(viewport, max_iter) → iteration buffer` — runs the escape-time loop
  and writes per-pixel iteration counts (e.g. a smooth-iteration `f32` per
  pixel) into a buffer that **lives in WASM linear memory**. The JS side
  holds a handle (offset + length), not a copy.
- `colorize(iteration buffer, palette) → RGBA buffer` — maps iteration counts
  to RGBA pixels using the chosen palette, into a `Uint8ClampedArray`-shaped
  buffer ready for `putImageData`.

Both functions are Rust; the seam is inside the Rust core, not at the WASM
boundary.

## Consequences

### Positive

- **Palette changes are cheap.** Changing the palette re-runs only
  `colorize`, not the expensive iteration loop. Enables an instant-repalette
  UX from slice 4 onward.
- **Algorithm and presentation stay cohesive in Rust** yet are cleanly
  separable.
- **The iteration buffer naturally becomes a GPU texture** if a future GPU
  slice happens — only `colorize` moves to a shader, not the whole pipeline.
- The compute output is a *meaningful* artifact (per-pixel escape data), not
  pre-baked pixels — useful for debugging and possible analytic features.

### Negative

- More plumbing than a single `render()` call. TypeScript must hold a handle
  to the WASM-memory iteration buffer rather than owning a copy.
- **Lifetime / invalidation must be managed**: any viewport, resolution, or
  `max_iter` change invalidates the iteration buffer. A clear ownership
  protocol is needed — likely the WASM side owns the buffer, and a handle is
  released when the JS side requests a recompute.

## Alternatives considered

- **One Rust function: `render(viewport, palette) → RGBA`.** Rejected.
  Absolute simplest slice 1, but any palette tweak forces a full recompute
  of every pixel's iteration count.
- **Counts out, color in JS.** WASM returns iteration counts; JS does the
  coloring. Rejected. Splits the domain across two languages — the smooth-
  coloring formula belongs next to the algorithm it interprets, not in glue
  code.

## Related

- [ADR-0001](0001-cpu-side-wasm-compute.md) — what compute() actually does.
- [ADR-0005](0005-core-and-wasm-crate-workspace.md) — both functions live in
  `fractal-core`; the WASM binding crate is a pass-through.
