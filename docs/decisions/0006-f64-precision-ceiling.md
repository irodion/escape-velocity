# ADR-0006: f64 precision; ~10¹³ zoom ceiling; perturbation theory out of scope

- Status: Accepted
- Date: 2026-05-23

## Context

The zoom depth of an escape-time fractal renderer is gated by the precision of
its floating-point arithmetic:

| Precision | Practical zoom limit before pixelation/banding |
| --------- | ----------------------------------------------- |
| f32       | ~10⁵                                            |
| f64       | ~10¹³ – 10¹⁴                                    |
| Beyond    | requires arbitrary-precision arithmetic + *perturbation theory* (a high-precision reference orbit with low-precision deltas) |

Because compute runs in WebAssembly on the CPU
([ADR-0001](0001-cpu-side-wasm-compute.md)), **f64 is free** — WASM has native
f64 support, with no performance disadvantage versus f32 in this code path.

The decision is not about slice 1 (which would use f64 regardless) but about
the **roadmap ceiling**: does the project ever promise deep zoom?

## Decision

- `fractal-core` uses **f64** throughout. The viewport type is two f64
  coordinates plus an f64 zoom factor.
- The practical zoom ceiling is **~10¹³**.
- **Perturbation theory and arbitrary-precision arithmetic are explicitly
  out of scope.**

## Consequences

### Positive

- Free with WASM-CPU compute; no performance penalty.
- ~10¹³ is visually very deep — genuinely delightful to explore.
- The viewport type stays simple (`{ center_re: f64, center_im: f64, zoom: f64 }`),
  which keeps every slice that touches it minimal.
- No need for a numeric trait abstraction in `fractal-core`.

### Negative

- No "infinite" zoom. Users who expect 10¹⁰⁰-style zooms will hit the wall.
- A future GPU compute slice (deferred from ADR-0001) would **regress to f32**
  — WGSL and GLSL core have no f64. Reconciling this would require either
  emulated double-double arithmetic in shaders, an accepted reduction in zoom
  ceiling for the GPU path, or keeping the CPU path as the "deep zoom" mode.

## Alternatives considered

- **Perturbation theory on the roadmap.** Rejected. Would roughly double the
  project's algorithmic ambition and force a high-precision viewport type
  (bignum/decimal) from day 1 to avoid a later rewrite — a significant
  pedagogical commitment that displaces other learning.
- **Defer the decision; use f64 now and revisit later.** Rejected as a
  *commitment* — same f64-now outcome, but without explicitly closing
  perturbation, retrofitting later would touch every layer that passes a
  viewport around.

## Related

- [ADR-0001](0001-cpu-side-wasm-compute.md) — why f64 is free here, and the
  GPU-slice tension.
