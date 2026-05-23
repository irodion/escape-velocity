# ADR-0001: Run escape-time computation on the CPU in WebAssembly

- Status: Accepted
- Date: 2026-05-23

## Context

A fractal viewer can compute the escape-time iteration in one of two places:

- **On the GPU** as a fragment or compute shader (WGSL for WebGPU, GLSL for
  WebGL). Per-pixel iteration runs massively in parallel; WASM/Rust shrinks to
  a thin orchestration shim.
- **On the CPU** in code compiled to WebAssembly. Rust does the iteration; the
  canvas is a passive display surface.

The original idea statement contained a contradiction: *"calculation is done in
WebAssembly"* combined with *"WebGPU/WebGL to draw"*. For a fractal, the
iteration loop **is** the expensive work — these are alternatives, not layers
of the same architecture.

The project's stated purpose is educational: learning Rust, WebAssembly, and
the mathematics of escape-time fractals.

## Decision

The escape-time iteration runs in Rust compiled to WebAssembly, **on the CPU**.
The canvas is a passive display surface — Canvas2D `putImageData` of an RGBA
buffer produced by Rust.

GPU-shader compute is recorded as a **deferred, optional** future slice — not a
commitment in this roadmap. If it ever happens, it is a deliberate
architectural fork that supersedes this ADR.

## Consequences

### Positive

- Rust stays central. The pedagogical mass is on the part of the stack the
  project exists to teach.
- f64 precision is available for free (WASM has native f64) — see
  [ADR-0006](0006-f64-precision-ceiling.md).
- Slice 1 is as small as possible: no shader pipeline, no GPU device
  acquisition, no WGSL/GLSL learning curve gating the first render.
- Debuggable with ordinary Rust tooling; `cargo test` covers the algorithm.

### Negative

- CPU compute is materially slower than GPU. Deep zooms and high iteration
  counts require the parallelism slices (6 and 7) to feel smooth.
- A future GPU compute slice would be a *fork*, not an upgrade: it inverts
  this ADR and **regresses f64 → f32** because WGSL/GLSL core have no f64
  type. Any GPU slice must address precision explicitly (emulated doubles,
  reduced zoom ceiling, or accepted scope reduction).

## Alternatives considered

- **GPU shaders from the start.** Rejected. Makes Rust a thin orchestration
  shim and pushes the educational mass onto WGSL/GLSL — a different project.
  Also contradicts the stated "calculation in WebAssembly" intent.
- **CPU-only forever; drop GPU from the stack.** Rejected only as a *commit* —
  GPU remains an open possibility in the backlog, just not a commitment.

## Related

- [ADR-0002](0002-split-compute-and-colorize.md) — pipeline shape inside the
  CPU/WASM core.
- [ADR-0005](0005-core-and-wasm-crate-workspace.md) — how the Rust code is
  organised.
- [ADR-0006](0006-f64-precision-ceiling.md) — precision implications.
- [ADR-0007](0007-parallelism-via-wasm-threads.md) — how the CPU compute
  scales across cores.
