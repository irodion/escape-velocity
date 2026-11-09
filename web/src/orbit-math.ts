import type { BoxSize, Viewport } from './viewport.js'
import type { PreviewTransform } from './zoom-preview.js'

/**
 * Pure maths for the orbit visualizer (E1, #94): iterate a single point's
 * `z = z² + c` orbit in plain TS, and map a CSS pixel on the canvas to the
 * complex point drawn there.
 *
 * The projection is the painted frame's own: the sample of the rendered pixel
 * under the cursor (`cssToComplex`). The iteration and `BAILOUT_SQR` are a
 * deliberate mirror of the Rust source of truth (`lib.rs`'s `BAILOUT_SQR` and
 * `escape_time.rs`'s iteration): iterating one point is microseconds, so E1
 * stays entirely on the TS side with no wasm/protocol change (per the issue).
 */

/**
 * Escape threshold on `|z|²`. The renderer bails at `|z| > 256`, i.e.
 * `|z|² > 65_536`. Mirror of `BAILOUT_SQR` in `crates/fractal-core/src/lib.rs`.
 * We trace the
 * orbit against the same threshold so the polyline escapes exactly when the
 * pixel under it is coloured "outside the set".
 */
export const BAILOUT_SQR = 65_536

/**
 * The frame on screen, as the cursor sees it. `rendered` is the viewport the
 * worker rendered the painted buffer from: the buffer's own size, at the zoom
 * times the effective render scale (the render request's fields). `rect` is the
 * untransformed CSS box it is stretched over, and `preview` the zoom Preview's
 * transform on it, if one is shown.
 */
export interface ScreenFrame {
  readonly rendered: Viewport
  readonly rect: BoxSize
  readonly preview?: PreviewTransform | null
}

/**
 * Iterate `z₀ → z₁ → z₂ → …` under `z = z² + c`, returning the flat point
 * sequence `[re0, im0, re1, im1, …]` (so the caller can stride it without
 * allocating a tuple per step). Stops the first step `|z|² > bailoutSqr`
 * (escape) — keeping the escaping point so the polyline visibly crosses the
 * bailout — or after `maxIter` points for an interior orbit (which never
 * escapes and reads as a tight cluster / short cycle).
 *
 * Mandelbrot: pass `z0 = (0, 0)`, `c = clicked point`.
 * Julia:      pass `z0 = clicked point`, `c = the Julia seed`.
 */
export function traceOrbit(
  z0Re: number,
  z0Im: number,
  cRe: number,
  cIm: number,
  maxIter: number,
  bailoutSqr: number = BAILOUT_SQR,
): number[] {
  const points: number[] = []
  let re = z0Re
  let im = z0Im
  for (let i = 0; i < maxIter; i++) {
    points.push(re, im)
    if (re * re + im * im > bailoutSqr) break
    // z² + c, on number pairs: (re + im·i)² = re² − im² + 2·re·im·i
    const nextRe = re * re - im * im + cRe
    const nextIm = 2 * re * im + cIm
    re = nextRe
    im = nextIm
  }
  return points
}

/**
 * How many leading orbit points to reveal at a given moment in the looping
 * trace animation (E1). The animation walks z₀→z₁→z₂… so the dynamics are
 * visible, then holds the full path before looping.
 *
 * `elapsedMs` is time since the loop started; the cycle repeats every
 * `periodMs`. The first `sweepFraction` of each cycle reveals the path one
 * point at a time (always starting from z₀); the remainder holds the whole
 * orbit so the settled shape is readable before the next pass. Returns a count
 * in `[1, nDrawn]` (or `nDrawn` itself for the 0/1-point degenerate cases).
 */
export function revealedCount(
  elapsedMs: number,
  nDrawn: number,
  periodMs: number,
  sweepFraction: number,
): number {
  if (nDrawn <= 1) return Math.max(0, nDrawn)
  const phase = (elapsedMs % periodMs) / periodMs
  if (phase >= sweepFraction) return nDrawn
  const t = phase / sweepFraction // 0 → 1 across the sweep
  return Math.min(nDrawn, 1 + Math.floor(t * (nDrawn - 1)))
}

/**
 * Map a CSS pixel on the surface back to the complex point the pixel beneath
 * the cursor was rendered from: the sample of the containing pixel of the
 * painted buffer (`cssToBufferPixel`'s pixel), not the cursor's exact sub-pixel
 * point. A pick, a traced orbit and the inspector's readout therefore name the
 * same sample the inspector probes, wherever in the pixel the cursor sits.
 *
 * Everything comes from the frame actually on screen, not the one last
 * requested: after a render-scale change, a resize or a permalink jump the old
 * frame stays up (CSS-stretched) until the new one paints, and the cursor is
 * over its pixels. The sample is projected through `rendered`, the viewport the
 * kernel sampled the buffer from (`pixel_to_complex` on the request), so it is
 * exact even when the buffer size was floored. Under a zoom Preview the point
 * is first carried back through the transform onto the untransformed frame; a
 * cursor beyond the painted frame's edge (a zoom-out Preview) clamps to the
 * nearest edge pixel.
 *
 * The zoom anchor deliberately does not snap: it keeps the continuous
 * `cssToGrid` point so a wheel notch scales about the cursor itself.
 */
export function cssToComplex(x: number, y: number, frame: ScreenFrame): { re: number; im: number } {
  const { rendered, rect, preview } = frame
  const fx = preview ? (x - preview.tx) / preview.scale : x
  const fy = preview ? (y - preview.ty) / preview.scale : y
  return rendered.pixelToComplex(
    containingCell(fx, rect.width, rendered.width),
    containingCell(fy, rect.height, rendered.height),
  )
}

/**
 * Map a CSS pixel on the surface to the **render-buffer pixel** under it — the
 * row-major `(px, py)` index into the worker's cached Field buffer the pixel
 * inspector probes (E2, #95).
 *
 * It maps against the canvas **backing store** (`bufferW`/`bufferH` =
 * `canvas.width`/`canvas.height`), *not* the viewport's logical grid: render
 * scale decouples the two (a 2× buffer is twice the logical width over the same
 * CSS box), so keying off the logical size would probe only the top-left
 * fraction at >1× and clamp along the edges at <1×. The CSS box (`rectW`/`rectH`)
 * is `getBoundingClientRect`'s size. A fractional CSS coordinate stays inside its
 * current cell, so this `floor`s to the *containing* pixel rather than the
 * nearest sample centre, then clamps into `[0, buffer)` (a cursor exactly on the
 * right/bottom edge would otherwise land one past the last pixel). Returns `null`
 * for a degenerate display box.
 */
export function cssToBufferPixel(
  cssX: number,
  cssY: number,
  rectW: number,
  rectH: number,
  bufferW: number,
  bufferH: number,
): { px: number; py: number } | null {
  if (rectW <= 0 || rectH <= 0) return null
  return { px: containingCell(cssX, rectW, bufferW), py: containingCell(cssY, rectH, bufferH) }
}

// The index of the cell, out of `cells` across a `span`-wide CSS box, that CSS
// coordinate `css` falls in, clamped into `[0, cells)`.
function containingCell(css: number, span: number, cells: number): number {
  return Math.min(Math.max(Math.floor((css / span) * cells), 0), cells - 1)
}
