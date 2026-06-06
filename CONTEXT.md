# Context: Escape Velocity

A glossary of the domain language. Implementation lives in the code; decisions
live in `docs/decisions/`. This file defines *terms* only.

## Terms

### Viewport
A rectangular window onto the complex plane: a `center`, a `zoom`, and pixel
`width`/`height`. Pixels are **square in the complex plane**, so the image is
never distorted; changing the canvas shape changes *how much of the set is
shown*, never the set's proportions.

### Zoom
Pure magnification — the count of complex-plane units per (reference) pixel.
The per-pixel scale is `(3.5 / 800) / zoom`, keyed to a **reference width of
800**, *not* to the actual buffer width. Consequence: a bigger window reveals
*more of the plane* in both axes (more pixels × fixed scale = wider window),
while `zoom` alone controls magnification. At 800 px wide the view is identical
to the project's historical convention. (Superseded the earlier "zoom fixes the
real-axis span at 3.5/zoom regardless of width" rule — see the ADR.)

### Render buffer
The off-screen pixel grid the worker computes and colourises — `width × height`
of iteration data turned into RGBA. Its size is the Viewport's `width`/`height`.

### Display surface
The on-screen size of the `<canvas>` element in CSS pixels. Historically pinned
to 800×600 and **decoupled** from the render buffer (resolution was a quality
knob, not a layout knob). The "fit-to-window" feature couples them: the display
surface becomes the available window area, and the render buffer is sized to
match it (modulo a quality factor).

### Render scale
The "quality factor" relating the render buffer to the display surface: buffer =
display size × render scale. A pure **quality knob** (sharpness vs. speed), not a
framing knob — `0.5×` subsamples for speed, `2×` supersamples for crispness, and
the framing (the visible region) is identical at every scale. Implemented by
scaling the render request's dimensions *and* its zoom together, so the
larger/smaller buffer covers the same window at a different sample density.

### Fit-to-window
Sizing the render buffer to the available browser window so the image fills it
with **no distortion** — square pixels are preserved, so a larger or
differently-shaped window reveals *more or less of the complex plane* rather
than stretching the fractal. Contrast with CSS-stretching a fixed buffer, which
warps the image (non-square pixels).

### Preview
The lower-fidelity image shown *immediately* during an interaction (pan, zoom,
resize) before the true frame exists — a reuse of the last rendered frame,
shifted, scaled, or stretched to approximate the new framing. It keeps the
gesture responsive and is **never** the final image: it carries no fresh
iteration data, only the previous frame's pixels rearranged.
_Avoid_: placeholder, stand-in, stretch.

### Settle
The end of an interaction — input has stopped — at which the true frame is
computed for the final Viewport and replaces the Preview. The boundary between
"responding to the gesture" (Preview) and "showing the truth" (Settle) is the
moment every recompute is deferred to.
_Avoid_: commit, finalise, end-of-gesture.

## Colouring

Three orthogonal choices turn a Viewport into pixels: the **Field** (what scalar
each pixel carries), the **Normalisation mode** (how that scalar is squashed into
`[0,1]`), and the **Palette** (what colour the `[0,1]` value becomes).

### Field
The per-pixel scalar quantity `compute` emits — the axis selected *before* any
Normalisation or Palette applies. Exactly one Field is active per render. Two
values: **Escape Time** and **Distance Estimate**. Selecting Distance Estimate
makes `compute` emit `d` *instead of* `nu`; it is one `f32` per pixel either way
(the inside-set `NaN` sentinel is shared).
_Avoid_: "field" in the algebraic sense (the complex field) — this is the
rendered scalar field, nothing to do with field theory.

### Escape Time
The default Field: the smooth (continuous) count `nu` at which the orbit escapes
to infinity. Inside-set pixels carry `NaN`.
_Avoid_: iterations / iteration count (those name the *discrete* index; `nu` is
the smoothed real value).

### Distance Estimate
The alternative Field: an estimate `d ≈ |z|·ln|z| / |z'|` of each pixel's
distance to the set boundary, expressed in pixel units so it is
resolution-independent. Yields razor-sharp, anti-aliased filaments. Requires
`compute` to track the orbit derivative `z'`; inside-set pixels carry `NaN`.
_Avoid_: "distance field" (collides with Field above); DE is fine as a code
abbreviation but spell it out in prose.

### Palette
The colour gradient that maps a normalised scalar in `[0,1]` to an RGB colour.
Independent of which Field produced the scalar — any Palette pairs with any
Field.
_Avoid_: colour scheme; "colormap" is acceptable only for the matplotlib-sourced
palettes that ship under that name.

### Normalisation mode
How a Field's scalar is squashed into `[0,1]` before Palette lookup. Unlike the
Palette, a Normalisation mode is **not universal across Fields**:
- **Cycled** (fractional part of `scalar / period`) is **Escape-Time only** — it
  assumes iteration units; a Distance Estimate has no period.
- **Clamped** (`min(1, d/k)` — a hard linear ramp over the first `k` pixels of
  distance, flat thereafter) targets **Distance Estimate** — it keeps the
  gradient in the thin boundary shell so filaments read as hairlines, not a
  halo.
- **Histogram**, **Linear**, **SquareRoot**, **Logarithmic** apply to any Field.

The valid (Field × Normalisation mode) pairs are a real constraint, not a UI
nicety: an invalid pair (e.g. Distance Estimate + Cycled) has no sensible
meaning and must be excluded, not silently rendered.
_Avoid_: "colouring mode" (overlaps Field); "scaling". (The UI label reads
"Coloring" for historical reasons — the canonical term is Normalisation mode.)
