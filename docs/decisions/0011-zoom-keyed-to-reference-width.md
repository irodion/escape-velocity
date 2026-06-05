# ADR-0011: Zoom keyed to a fixed reference width, not the buffer width

- Status: Accepted
- Date: 2026-06-05

## Context

The "fit-to-window" feature sizes the render buffer to the available browser
window so the fractal fills the whole screen instead of a fixed 800×600 box.
The intent (chosen during design) is **"a bigger window reveals more of the
set"** — with square pixels preserved, so the image is never distorted.

The original viewport convention ([viewport.rs](../../crates/fractal-core/src/viewport.rs))
defined the per-pixel complex-plane scale as:

```
pixel_scale = (BASE_RE_SPAN / width) / zoom        // 3.5 / (width · zoom)
```

The real-axis span the user sees is `width · pixel_scale = 3.5 / zoom` — **independent
of `width`**. Under this rule `zoom` alone fixes the visible real-axis span, and
buffer width is purely pixel density. This was sound while resolution was a
quality knob decoupled from layout (all presets were 4:3).

It breaks the fit-to-window intent. Resizing the window from 800×600 (4:3) to
1920×1080 (16:9) at the same zoom keeps the real-axis span at `3.5/zoom` and
*shrinks* the imaginary span from `2.625/zoom` to `1.969/zoom` — a vertical
crop. Widening the window reveals nothing new horizontally; it only sharpens.
The opposite of "fill the space, reveal more."

## Decision

Key the per-pixel scale to a **fixed reference width of 800**, not the actual
buffer width:

```
const REFERENCE_WIDTH: f64 = 800.0;
pixel_scale = (BASE_RE_SPAN / REFERENCE_WIDTH) / zoom    // (3.5/800) / zoom
```

- `zoom` becomes **pure magnification**: complex-plane units per reference
  pixel, independent of buffer dimensions.
- A larger window (more pixels × a fixed scale) reveals **more of the plane in
  both axes**; a smaller one reveals less. Square pixels are preserved, so the
  set is never distorted.
- The render-resolution multiplier (0.5× / 1× / 2× vs. window size) becomes
  **purely a sharpness knob** — it changes pixel density without changing the
  visible region.
- `REFERENCE_WIDTH = 800` is chosen so that at 800 px wide the visible region is
  **byte-identical to the historical convention**: existing default views,
  saved zoom values, and the per-mode default frames all behave exactly as
  before at the legacy width.

## Consequences

### Positive

- Delivers the feature's intent: bigger window = more fractal, no distortion.
- `zoom` gains a cleaner, resolution-independent meaning (magnification).
- Simplifies the `with_resolution` aspect-ratio caveat: changing dimensions now
  *intentionally* changes the visible window, rather than silently preserving
  the real-axis span only for same-aspect resizes.
- The screen→buffer input mapping (`canvas.width / rect.width` in `input.ts`)
  already handles a dynamic buffer/display ratio, so pan/zoom needs no change.

### Negative

- Changes the heart of `fractal-core`'s coordinate convention; every test that
  asserts "real-axis span = 3.5/zoom regardless of width" must be revised to the
  reference-width form.
- The `MIN_ZOOM`/`MAX_ZOOM` bounds and the ADR-0006 ~10¹³ ceiling are unchanged
  numerically, but their phrasing ("real-axis span") shifts to per-reference-pixel
  scale — a documentation update.
- Introduces a magic constant (`800`) whose only justification is backward
  compatibility; a future reader needs this ADR to understand why it isn't,
  say, a clean power of two.

## Alternatives considered

- **Keep the original convention (zoom fixes the real-axis span).** Rejected:
  fails the feature intent — widening the window only sharpens and vertically
  crops, never reveals more horizontally.
- **CSS-stretch a fixed 800×600 buffer to fill the window.** Rejected: produces
  non-square pixels and a visibly distorted fractal.
- **Reference *height* (or the diagonal) instead of width.** Rejected: width is
  the axis `BASE_RE_SPAN` already anchors, and 800 is the legacy default width,
  so width gives the cleanest "identical at the old default" migration.

## Related

- [ADR-0006](0006-f64-precision-ceiling.md) — the zoom ceiling these scale
  bounds enforce.
- [CONTEXT.md](../../CONTEXT.md) — the *Zoom* and *Fit-to-window* glossary terms.
