/**
 * Pure maths for the orbit visualizer (E1, #94): iterate a single point's
 * `z = z² + c` orbit in plain TS, and project complex-plane points to/from CSS
 * pixels on the overlay canvas.
 *
 * Everything here takes primitives rather than the opaque wasm `Viewport`
 * class, so the whole module is unit-testable without booting wasm. The
 * constants and the projection formula are a deliberate mirror of the Rust
 * source of truth (`crates/fractal-core/src/viewport.rs` and
 * `escape_time.rs`) — iterating one point is microseconds, so E1 stays
 * entirely on the TS side with no wasm/protocol change (per the issue).
 */

/**
 * The buffer width at which `zoom = 1.0` spans [`BASE_RE_SPAN`] of the real
 * axis. The per-pixel scale is keyed to this fixed value, not the live buffer
 * width (ADR-0011). Mirror of `REFERENCE_WIDTH` in `viewport.rs`.
 */
export const REFERENCE_WIDTH = 800

/**
 * Real-axis span at `zoom = 1.0` and `width = REFERENCE_WIDTH`. Mirror of
 * `BASE_RE_SPAN` in `viewport.rs`.
 */
export const BASE_RE_SPAN = 3.5

/**
 * Escape threshold on `|z|²`. The renderer bails at `|z| > 256`, i.e.
 * `|z|² > 65_536`. Mirror of `BAILOUT_SQR` in `escape_time.rs`. We trace the
 * orbit against the same threshold so the polyline escapes exactly when the
 * pixel under it is coloured "outside the set".
 */
export const BAILOUT_SQR = 65_536

/** Complex-plane size of one reference pixel — mirrors `Viewport::pixel_scale`. */
export function pixelScale(zoom: number): number {
  return BASE_RE_SPAN / REFERENCE_WIDTH / zoom
}

/**
 * The view geometry the projection needs, flattened from the wasm `Viewport`
 * plus the overlay canvas's CSS box. `logicalW`/`logicalH` are the viewport's
 * logical grid (`viewport.width()`/`height()`); `rectW`/`rectH` are the CSS
 * pixel size the canvas is displayed at.
 */
export interface ViewGeometry {
  readonly centerRe: number
  readonly centerIm: number
  readonly zoom: number
  readonly logicalW: number
  readonly logicalH: number
  readonly rectW: number
  readonly rectH: number
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
 * Project a complex-plane point to a CSS pixel on the overlay. The inverse of
 * the Rust `pixel_to_complex_f`, then logical → CSS by the display ratio.
 * Image-y is negated (the imaginary axis grows up, image-y grows down).
 */
export function complexToCss(re: number, im: number, view: ViewGeometry): { x: number; y: number } {
  const scale = pixelScale(view.zoom)
  const midX = (view.logicalW - 1) / 2
  const midY = (view.logicalH - 1) / 2
  const logicalX = midX + (re - view.centerRe) / scale
  const logicalY = midY - (im - view.centerIm) / scale
  return {
    x: (logicalX * view.rectW) / view.logicalW,
    y: (logicalY * view.rectH) / view.logicalH,
  }
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
 * Map a CSS pixel on the overlay back to its complex-plane point. CSS → logical
 * by the display ratio, then the Rust `pixel_to_complex_f` formula.
 */
export function cssToComplex(x: number, y: number, view: ViewGeometry): { re: number; im: number } {
  const scale = pixelScale(view.zoom)
  const midX = (view.logicalW - 1) / 2
  const midY = (view.logicalH - 1) / 2
  const logicalX = (x * view.logicalW) / view.rectW
  const logicalY = (y * view.logicalH) / view.rectH
  return {
    re: view.centerRe + (logicalX - midX) * scale,
    im: view.centerIm - (logicalY - midY) * scale,
  }
}
