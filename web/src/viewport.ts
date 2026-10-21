/**
 * The view onto the complex plane, on the main thread (ADR-0015, #172): a
 * TypeScript port of `fractal_core::Viewport` (`crates/fractal-core/src/viewport.rs`).
 *
 * The main thread needs only the geometry: pan, cursor-anchored zoom, resize,
 * and the pixel ↔ complex projection that the orbit overlay, the inspector and
 * the Julia picker map the cursor with. It used to get them by instantiating
 * the whole threaded WASM module a second time, beside the worker's, for this
 * one class. Rust stays the source of truth for the compute: the worker
 * rebuilds a WASM `Viewport` from these five fields for every render.
 *
 * So this is a mirror, and every formula keeps Rust's operation order. Both
 * sides compute in IEEE-754 binary64 with no fused multiply-add, so the two
 * agree bit for bit, not merely within a tolerance. Change one, change the
 * other: `viewport-parity.test.ts` compares them on the real module (#169).
 *
 * An immutable value: every operation returns a new viewport. Its fields are
 * plain numbers, so there is nothing to free and nothing to flatten before a
 * `postMessage`.
 */

/**
 * Real-axis span at `zoom = 1` and `width = REFERENCE_WIDTH`, wide enough for
 * the whole Mandelbrot set. `BASE_RE_SPAN` in `viewport.rs`.
 */
export const BASE_RE_SPAN = 3.5

/**
 * The width at which `zoom = 1` spans {@link BASE_RE_SPAN}. The per-pixel
 * scale is keyed to it, not the live width, so a wider window shows more of the
 * plane rather than a finer one (ADR-0011). `REFERENCE_WIDTH` in `viewport.rs`.
 */
export const REFERENCE_WIDTH = 800

/** The zoom floor, a UX limit: below it the set is a few pixels across. */
export const MIN_ZOOM = 0.25

/** The zoom ceiling: the f64 precision horizon (ADR-0006). */
export const MAX_ZOOM = 1e13

/** Complex-plane size of one pixel at `zoom`, the same on both axes (`Viewport::pixel_scale`). */
export function pixelScale(zoom: number): number {
  return BASE_RE_SPAN / REFERENCE_WIDTH / zoom
}

/** `zoom` clamped to `[MIN_ZOOM, MAX_ZOOM]`, as `zoom_around` clamps it. */
export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM)
}

/** The CSS size of the box a viewport is displayed in (`getBoundingClientRect`'s). */
export interface BoxSize {
  readonly width: number
  readonly height: number
}

/**
 * The grid position of the sample drawn under CSS point `(cssX, cssY)` of the
 * box the viewport is displayed in (B5, #76). Every CSS → grid mapping goes
 * through here: the zoom anchor, and the click, hover and inspector readouts.
 * TypeScript only; the compute never sees CSS pixels.
 *
 * Two steps. Scale by the viewport's logical grid over the box, not the
 * render buffer, so it holds at any render scale. Then go back half a pixel:
 * the sample at grid coordinate j is drawn across the cell [j, j + 1), so the
 * cursor's cell-edge position `cssX · scale` sits half a pixel past the
 * sample it is over.
 */
export function cssToGrid(
  viewport: Viewport,
  box: BoxSize,
  cssX: number,
  cssY: number,
): { x: number; y: number } {
  return {
    x: (cssX * viewport.width) / box.width - 0.5,
    y: (cssY * viewport.height) / box.height - 0.5,
  }
}

export class Viewport {
  /**
   * `width` × `height` is the logical (display) grid, in pixels. Validated
   * here, at the boundary, as the WASM binding's constructor did; the maths
   * below trusts its inputs, as `fractal-core` does.
   */
  constructor(
    readonly centerRe: number,
    readonly centerIm: number,
    readonly zoom: number,
    readonly width: number,
    readonly height: number,
  ) {
    requireFinite(centerRe, 'Viewport: center re')
    requireFinite(centerIm, 'Viewport: center im')
    if (!(Number.isFinite(zoom) && zoom > 0)) {
      throw new Error('Viewport: zoom must be finite and > 0')
    }
    requireDimension(width, 'Viewport: width')
    requireDimension(height, 'Viewport: height')
  }

  /** Complex-plane size of one pixel at this zoom. */
  pixelScale(): number {
    return pixelScale(this.zoom)
  }

  /**
   * The complex point sampled at sub-pixel `(px, py)` of the grid
   * (`pixel_to_complex_f`). Pixel (0, 0) is the top-left one, and the grid's
   * geometric centre maps to the centre. Image-y grows down while the
   * imaginary axis grows up, hence the minus.
   */
  pixelToComplex(px: number, py: number): { re: number; im: number } {
    const scale = this.pixelScale()
    const midX = (this.width - 1) / 2
    const midY = (this.height - 1) / 2
    return {
      re: this.centerRe + (px - midX) * scale,
      im: this.centerIm - (py - midY) * scale,
    }
  }

  /**
   * The grid position that samples `(re, im)`: the inverse of
   * {@link pixelToComplex}. TypeScript only; the compute never maps this way.
   */
  complexToPixel(re: number, im: number): { x: number; y: number } {
    const scale = this.pixelScale()
    const midX = (this.width - 1) / 2
    const midY = (this.height - 1) / 2
    return {
      x: midX + (re - this.centerRe) / scale,
      y: midY - (im - this.centerIm) / scale,
    }
  }

  /**
   * Shift the view so the image moves by `(dxPixels, dyPixels)` grid pixels:
   * positive `dx` moves it right, positive `dy` down (`pan_by_pixels`). After
   * it, `next.pixelToComplex(p + dx, q + dy)` is `this.pixelToComplex(p, q)`.
   */
  panByPixels(dxPixels: number, dyPixels: number): Viewport {
    requireFinite(dxPixels, 'panByPixels: dxPixels')
    requireFinite(dyPixels, 'panByPixels: dyPixels')
    const scale = this.pixelScale()
    return new Viewport(
      this.centerRe - dxPixels * scale,
      this.centerIm + dyPixels * scale,
      this.zoom,
      this.width,
      this.height,
    )
  }

  /**
   * Multiply the zoom by `factor`, clamped to `[MIN_ZOOM, MAX_ZOOM]`, keeping
   * the complex point under sub-pixel `(pixelX, pixelY)` in place
   * (`zoom_around`): the point under the cursor stays under it. At the clamp
   * the zoom stops moving and the point still holds.
   */
  zoomAround(pixelX: number, pixelY: number, factor: number): Viewport {
    requireFinite(pixelX, 'zoomAround: pixelX')
    requireFinite(pixelY, 'zoomAround: pixelY')
    if (!(Number.isFinite(factor) && factor > 0)) {
      throw new Error('zoomAround: factor must be finite and > 0')
    }
    const pre = this.pixelToComplex(pixelX, pixelY)
    const zoom = clampZoom(this.zoom * factor)
    const candidate = new Viewport(this.centerRe, this.centerIm, zoom, this.width, this.height)
    const post = candidate.pixelToComplex(pixelX, pixelY)
    return new Viewport(
      this.centerRe + (pre.re - post.re),
      this.centerIm + (pre.im - post.im),
      zoom,
      this.width,
      this.height,
    )
  }

  /**
   * The same centre and zoom on a `width` × `height` grid
   * (`with_resolution`). The pixel scale doesn't change (ADR-0011), so a
   * bigger grid shows more of the plane.
   */
  withResolution(width: number, height: number): Viewport {
    return new Viewport(this.centerRe, this.centerIm, this.zoom, width, height)
  }
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`)
  }
}

// The binding took dimensions as `u32`; a grid is a whole number of pixels.
function requireDimension(value: number, name: string): void {
  if (!(Number.isInteger(value) && value > 0 && value <= 0xffff_ffff)) {
    throw new Error(`${name} must be a whole number > 0`)
  }
}
