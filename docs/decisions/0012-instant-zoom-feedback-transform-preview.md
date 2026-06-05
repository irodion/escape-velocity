# ADR-0012: Instant zoom feedback via a transform Preview and a debounced Settle

- Status: Accepted
- Date: 2026-06-05

## Context

Mouse-wheel zoom feels dead during the gesture. Each wheel notch immediately
commits the new [Viewport](../../CONTEXT.md) and fires a full recompute
([input.ts](../../web/src/input.ts) `handleWheel` → `onChange` → `rerender`);
until the worker returns, the canvas keeps showing the *old* frame at the *old*
magnification. The user gets no confirmation the zoom registered — just a lurch
to the final zoom once compute finishes, with intermediate notches dropped by
the single-slot coalescing queue.

Pan does not have this problem. A drag has explicit brackets — `mousedown` →
many `mousemove` → `mouseup` — and shows a live **Preview** during the gesture
(the last frame, pixel-shifted inside the buffer), recomputing only on release.
Wheel zoom has no brackets and no Preview at all.

The chosen optimization target is **instant in-gesture feedback**, not a faster
final image. The Settle recompute is left full-quality (no iteration or
resolution dropping — see *Alternatives*).

## Decision

Give wheel zoom the same "respond now, compute once at the end" shape pan
already has, built from four parts:

1. **A debounced Settle.** During a wheel scrub, notches update only the
   Preview; no `onChange` fires. A single recompute is deferred to ~150 ms
   (`WHEEL_SETTLE_MS`) after the wheel goes quiet. This *reduces* total compute
   versus today's coalesced per-notch renders.

2. **A GPU CSS-transform Preview.** The Preview is the existing frame scaled
   under the cursor via `canvas.style.transform` (an accumulated `DOMMatrix`) —
   zero compute, composited on the GPU. Chosen over redrawing a scaled snapshot
   into the buffer.

3. **A pure accumulator module.** The cursor-anchored matrix algebra and the
   authoritative Viewport advance live in a DOM-free, timer-free module that
   maintains both representations in lockstep. The matrix is driven by the
   **realized** zoom ratio (`next.zoom() / current.zoom()`), not the raw wheel
   factor, so at a `MIN_ZOOM`/`MAX_ZOOM` clamp the realized ratio collapses to
   `1.0` and the Preview freezes exactly when the Viewport does — the two cannot
   drift, and there is no snap-on-Settle at the limits.

4. **The paint contract.** Every real frame that paints is correct at identity
   transform (Settle, recolorize, resize, boot alike), so `paint()` in
   [render-client.ts](../../web/src/render-client.ts) **unconditionally** clears
   `canvas.style.transform` immediately before `putImageData`, in the same tick.
   This is an atomic, snap-free swap and needs no callback plumbing back to the
   input layer. Because no `onChange` fires during a scrub, no frame paints
   mid-gesture, so the transform accumulates undisturbed until the Settle frame
   clears it.

A new gesture (including a pan `mousedown`) that starts inside the pending-Settle
window cancels the debounce and commits the zoom immediately; the authoritative
Viewport is already exact, so the committed math is always correct. Zoom-out is
letterboxed with black (the outside-the-set colour) and zoom-in overflow is
clipped with `overflow: hidden`. Pan is untouched; the zoom transform is
additive.

## Consequences

### Positive

- Delivers the intent: wheel zoom responds instantly and scrubs smoothly at
  60 fps, with the cursor-anchored point held fixed throughout.
- Total compute drops — one Settle per scrub instead of a coalesced burst.
- The trickiest logic (matrix algebra + clamp consistency) is isolated in a
  pure, browser-free module, fully unit-testable.
- The single-slot coalescing + epoch machinery in `render-client.ts` is
  untouched and still correct; the Settle is just one ordinary render.

### Negative

- Re-introduces a CSS transform on the canvas element — the exact approach an
  earlier pan implementation abandoned after a mouseup snap-back. The risk is
  contained by the atomic paint contract, but a future reader must understand
  *why* it is safe here and was not there (coordination, not the transform
  itself).
- Adds a cross-module invariant: `paint()` clears a transform it does not own.
  This is deliberately one line, but it couples the render-client to a property
  the input layer establishes.
- An isolated single notch now shows the soft Preview for ~150 ms before its
  true frame lands, rather than computing immediately.
- A pan that starts in the sub-second pending-Settle overlap may snapshot the
  not-yet-refreshed buffer — an accepted, transient visual imperfection.

## Alternatives considered

- **Keep per-notch compute, just add a transform.** Rejected: during a scrub the
  painted frame always lags the cursor, so resetting the transform on each paint
  would yank the image back to a stale magnification mid-gesture. Deferring
  compute to a Settle is what makes the Preview stable.
- **Redraw a scaled snapshot into the buffer** (the literal generalization of
  pan's in-buffer shift). Rejected: CPU work per notch, compounding resample
  blur unless re-sampled from a kept snapshot each frame, and it cannot compose
  into a single matrix the way a transform does. The GPU transform is free and
  accumulates cleanly.
- **Drop iterations or resolution on the Settle and refine in the background**
  (progressive rendering). Rejected for this slice: the goal is feedback, not a
  faster final, and a low-iteration preview shifts the histogram-normalisation
  distribution, producing a visible colour pop on every Settle. Left as possible
  future work.
- **Oversized render buffer** so zoom-out reveals real content. Rejected: extra
  compute on every frame, directly against the goal; zoom-out reveals black
  instead.
- **Unify pan into the same transform matrix now.** Rejected: pan is not broken,
  rewriting it re-opens the snap-back scar, and wheel-zoom and drag-pan never
  fire simultaneously. Revisited only when pinch-zoom lands.
- **Block a new gesture until the Settle frame paints** (the stricter boundary
  rule). Rejected: adds latency and state to a rare path for a sub-second,
  cosmetic-only gain.

## Related

- [ADR-0011](0011-zoom-keyed-to-reference-width.md) — the zoom convention; the
  accumulator advances the authoritative Viewport via `zoom_around`, leaving
  that coordinate convention untouched. The matrix is a pure screen-space
  representation of the same change.
- [ADR-0002](0002-split-compute-and-colorize.md) — the compute/colorize split
  whose `recolorize` fast path also paints at identity (covered by the paint
  contract).
- [CONTEXT.md](../../CONTEXT.md) — the *Preview* and *Settle* glossary terms
  introduced for this decision.
- Issue #55 — the PRD this ADR backs.
