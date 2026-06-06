# ADR-0013: Distance Estimate as a selectable Field

- Status: Accepted
- Date: 2026-06-06

## Context

[ADR-0002](0002-split-compute-and-colorize.md) fixed the pipeline seam as
`compute(viewport, max_iter) → one smooth-iteration f32 (nu) per pixel`, then
`colorize(nu, palette, mode) → RGBA`. Every palette and normalisation mode
shipped since is a pure function of `nu`, which is what makes re-palette and
re-normalise instant: only `colorize` re-runs.

We want a **Distance Estimate** render — razor-sharp, resolution-independent
filaments around the set boundary. The distance estimate is
`d ≈ |z|·ln|z| / |z'|`, and the orbit derivative `z'` exists **only during
iteration**. It cannot be recovered from `nu`. So DE cannot be a palette or a
normalisation mode; it is a different kind of per-pixel quantity, which forces a
decision about how it fits the ADR-0002 seam.

## Decision

Introduce a **Field** axis — the per-pixel scalar `compute` emits — with two
values: **Escape Time** (`nu`, the existing default) and **Distance Estimate**
(`d`). The Field is chosen at compute time; Palette and Normalisation mode apply
on top of whichever Field is active.

- **Replace, don't coexist.** Distance Estimate makes `compute` emit `d`
  *instead of* `nu` — still exactly one `f32` per pixel, with the inside-set
  `NaN` sentinel shared. The WASM buffer (`Vec<f32>`), the handle/cache, and the
  recolorize fast-path are otherwise untouched.
- **Separate, family-agnostic kernel.** A new `escape_distance` kernel sits
  beside `escape_time`, which is left byte-for-byte unchanged. DE's derivative
  recurrence depends on the family (Mandelbrot differentiates w.r.t. `c`, Julia
  w.r.t. `z₀`), but the kernel stays family-agnostic the same way `escape_time`
  does — the caller passes the seeds `dz₀` and `dc` (Mandelbrot `dz₀=0, dc=1`;
  Julia `dz₀=1, dc=0`), recurrence `dz ← 2·z·dz + dc`.
- **Pixel units, converted in compute.** The kernel emits `d` in complex-plane
  units; the compute pipeline (which already walks pixels via the Viewport)
  divides by the per-pixel scale so the **buffer carries pixel-distance**.
  `colorize` therefore needs no Viewport knowledge.
- **`colorize` is Field-blind.** It only ever sees a scalar buffer; it cannot
  tell `nu` from `d`. The colorize seam needs **no** change for DE.
- **New `Clamped` normalisation** `min(1, d/k)` (fixed `k`, a hard linear ramp
  over the first `k` pixels then flat) keeps the gradient in the thin boundary
  shell so filaments read as hairlines, not a halo. It is the DE default.
- **(Field × Normalisation mode) validity is a real constraint, enforced in the
  UI.** `Cycled` divides by an iteration period and is meaningless for a
  distance, so it is excluded when the Field is Distance Estimate. Because
  `colorize` is Field-blind, nothing in the core rejects an invalid pair — the
  UI simply never offers it (and substitutes the Field's default mode on switch).
- **Field is compute-invalidating.** It joins `(viewport, max_iter, kind)` as a
  recompute trigger. Toggling Escape Time ↔ Distance Estimate is a full
  recompute; only Palette/Normalisation changes *within* a Field stay instant.

This **refines** ADR-0002 rather than superseding it: the compute/colorize split
stands; only its "one f32 = `nu`" detail generalises to "a scalar Field".

## Consequences

### Positive

- Crisp, resolution-independent filaments — the headline look — with the entire
  Palette/Normalisation stack reused.
- `colorize` and the `escape_time` hot path are untouched; DE work is isolated
  to `escape_distance` and one compute-pipeline branch.
- The buffer/cache/seam stay single-scalar; the fast-path is preserved for every
  colour change that doesn't cross Fields.

### Negative

- Toggling the Field is a **full recompute**, unlike every other colour change
  shipped so far (the derivative isn't in the `nu` buffer).
- `escape_distance` is ~2× the cost of `escape_time` (it also advances `dz`),
  paid whenever Distance Estimate is active.
- (Field × Normalisation mode) validity now lives in the UI/orchestration layer;
  the core cannot guard it because `colorize` is Field-blind.
- DE quality degrades at low `max_iter` (the derivative needs enough orbit to be
  meaningful) — handled only by the existing `max_iter` control.

## Alternatives considered

- **Coexist: emit both `nu` and `d` (A2).** Rejected — doubles the buffer and
  forks the colorize signature to serve a "blend DE with escape-time bands"
  feature nobody has asked for yet. Deferred until someone wants it.
- **Extend `escape_time` to also track `dz`, branching on `kind`.** Rejected —
  breaks the family-agnostic property the function advertises and burdens the
  hot escape-time path with DE work that only DE renders need.
- **Reuse only the existing global modes (Logarithmic) for DE.** Rejected — a
  global stretch spreads the gradient across the whole exterior, producing a
  halo/glow rather than the hairline filaments that were the point.
- **Convert `d` to pixel units inside `colorize`.** Rejected — would force
  `colorize` to learn the Viewport, denting the clean ADR-0002 colorize
  contract.
- **Full normal/slope shading (embossed 3-D) now (B).** Out of scope for this
  ADR — it needs the surface normal (the *direction* of `z'`, ~4 floats/pixel)
  and a light-direction parameter, and carries its own buffer-size-vs-light-
  interactivity trade-off. A later slice/ADR.

## Related

- [ADR-0002](0002-split-compute-and-colorize.md) — refined here: the seam now
  carries a scalar Field, of which `nu` is one value.
- [ADR-0001](0001-cpu-side-wasm-compute.md) — what the compute loop does.
- Wilson, L. R. (2012), *Distance estimation method for drawing Mandelbrot and
  Julia sets* — primary reference for the `escape_distance` kernel: derives the
  Hubbard–Douady potential `G = (1/2ⁿ)·ln|zₙ|`, the distance estimate
  `d = |z|·ln|z| / |z'|`, and the derivative recurrence `z'ₙ₊₁ = 2·zₙ·z'ₙ + dc`
  (`dc = 1` for Mandelbrot, `dc = 0` for Julia). Our implementation matches it
  for both families. http://www.imajeenyus.com/mathematics/20121112_distance_estimates/distance_estimation_method_for_fractals.pdf
  (Itself crediting Iñigo Quílez's distance-fractals article and mrob's
  distance-estimator notes.)
