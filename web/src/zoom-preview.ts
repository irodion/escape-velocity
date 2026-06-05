import type { Viewport } from '../wasm/fractal_wasm.js'

/**
 * Pure accumulator for the wheel-zoom **Preview** (ADR-0012; the
 * *Preview* / *Settle* glossary terms live in `CONTEXT.md`).
 *
 * A wheel scrub is a sequence of notches. This module folds that
 * sequence into two representations held in lockstep:
 *
 *  - the **authoritative Viewport**, advanced once per notch via
 *    `Viewport.zoom_around` (the cursor-invariant zoom of ADR-0011);
 *  - the **CSS transform matrix** that scales the on-screen frame to
 *    approximate that viewport — a pure screen-space stand-in painted
 *    instantly while the real recompute is deferred to the Settle.
 *
 * The matrix is a scale-plus-translate affine `p ↦ scale·p + (tx, ty)`
 * (no rotation), expressed in the canvas's CSS-pixel box with
 * `transform-origin` at its top-left (set in `index.html`). It carries
 * no DOM and no timers, so the whole scrub is unit-testable against a
 * `Viewport` double.
 *
 * ## Why the matrix is driven by the *realized* zoom ratio
 *
 * Each notch composes a scale-about-cursor step whose factor is
 * `next.zoom() / current.zoom()` — the ratio the viewport **actually**
 * moved — not the raw wheel factor. At the `MIN_ZOOM` / `MAX_ZOOM`
 * clamp, `zoom_around` stops advancing, so the realized ratio collapses
 * to `1.0` and the Preview freezes in exact step with the viewport. The
 * two can never drift, so the Settle frame always matches what was on
 * screen — no snap at the clamp.
 */
export interface ZoomPreview {
  /** Authoritative viewport, advanced via `zoom_around` per notch. */
  readonly viewport: Viewport
  /** Accumulated uniform scale, relative to the frame on screen when the
   *  scrub began. Equals `viewport.zoom() / startZoom` by construction. */
  readonly scale: number
  /** Accumulated translation in CSS pixels, paired with `scale` as the
   *  affine `p ↦ scale·p + (tx, ty)`. */
  readonly tx: number
  readonly ty: number
}

/**
 * Begin a scrub whose Preview is the identity transform over `viewport`
 * (the frame currently on screen). The first `applyZoomNotch` advances
 * from here.
 */
export function beginZoomPreview(viewport: Viewport): ZoomPreview {
  return { viewport, scale: 1, tx: 0, ty: 0 }
}

/**
 * Fold one wheel notch into the Preview.
 *
 * `zoomPixelX` / `zoomPixelY` are the cursor in the viewport's logical
 * pixel grid (what `zoom_around` consumes). `anchorX` / `anchorY` are the
 * same cursor in the canvas's CSS-pixel box (what the transform anchors
 * on). They scale by the same display ratio, so the screen point the
 * matrix holds fixed is exactly the complex-plane point `zoom_around`
 * holds fixed — the Preview tracks the true zoom.
 */
export function applyZoomNotch(
  preview: ZoomPreview,
  zoomPixelX: number,
  zoomPixelY: number,
  anchorX: number,
  anchorY: number,
  factor: number,
): ZoomPreview {
  const next = preview.viewport.zoom_around(zoomPixelX, zoomPixelY, factor)
  // The realized ratio (see module doc) — 1.0 at the clamp, so the
  // Preview freezes exactly when the viewport stops advancing.
  const realized = next.zoom() / preview.viewport.zoom()
  // Compose a scale-about-(anchorX, anchorY) step of `realized` onto the
  // existing affine. A lone scale-about-`a` is `p ↦ realized·p +
  // a·(1−realized)`; composing it *after* `p ↦ scale·p + t` gives the
  // closed form below (no matrix object needed for pure scale+translate).
  return {
    viewport: next,
    scale: realized * preview.scale,
    tx: realized * preview.tx + anchorX * (1 - realized),
    ty: realized * preview.ty + anchorY * (1 - realized),
  }
}

/**
 * Render the Preview as a `canvas.style.transform` string. Valid only
 * with `transform-origin: 0 0` (the canvas top-left), under which the
 * string maps a local point `p` to `scale·p + (tx, ty)` exactly.
 */
export function zoomPreviewTransform(preview: ZoomPreview): string {
  return `translate(${preview.tx}px, ${preview.ty}px) scale(${preview.scale})`
}
