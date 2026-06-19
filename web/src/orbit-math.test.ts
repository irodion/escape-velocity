import { describe, expect, it } from 'vitest'
import {
  BAILOUT_SQR,
  complexToCss,
  cssToBufferPixel,
  cssToComplex,
  pixelScale,
  revealedCount,
  traceOrbit,
  type ViewGeometry,
} from './orbit-math.js'

describe('traceOrbit', () => {
  it('keeps an interior point bounded for the full maxIter (z₀=0, c=0 stays at 0)', () => {
    const pts = traceOrbit(0, 0, 0, 0, 64)
    // One (re, im) pair per iteration, never escaping.
    expect(pts.length).toBe(64 * 2)
    expect(pts.every((v) => v === 0)).toBe(true)
  })

  it('never emits more than maxIter points', () => {
    // A deep-interior Julia point (z₀ near 0, c in the main cardioid).
    const pts = traceOrbit(0.01, 0, -0.5, 0, 200)
    expect(pts.length).toBeLessThanOrEqual(200 * 2)
  })

  it('escapes quickly for a clearly divergent c and keeps the escaping point', () => {
    // Mandelbrot orbit of c = 2: 0 → 2 → 6 → 38 → … escapes almost at once.
    const pts = traceOrbit(0, 0, 2, 0, 64)
    expect(pts.length).toBeLessThan(64 * 2)
    const lastRe = pts[pts.length - 2]
    const lastIm = pts[pts.length - 1]
    // The retained final point is the first one past the bailout.
    expect(lastRe * lastRe + lastIm * lastIm).toBeGreaterThan(BAILOUT_SQR)
  })

  it('starts Julia orbits at z₀ (the clicked point), not 0', () => {
    // z₀ = (0.3, 0.5), c = (-0.4, 0.6): first emitted point is z₀ itself.
    const pts = traceOrbit(0.3, 0.5, -0.4, 0.6, 16)
    expect(pts[0]).toBeCloseTo(0.3, 12)
    expect(pts[1]).toBeCloseTo(0.5, 12)
  })

  it('applies z² + c on the second point', () => {
    // z₀ = (0,0), c = (0.1, 0.2): z₁ = z₀² + c = c.
    const pts = traceOrbit(0, 0, 0.1, 0.2, 8)
    expect(pts[2]).toBeCloseTo(0.1, 12)
    expect(pts[3]).toBeCloseTo(0.2, 12)
  })
})

describe('revealedCount', () => {
  it('reveals z₀ first and the whole orbit by the end of the sweep', () => {
    expect(revealedCount(0, 10, 1000, 0.8)).toBe(1) // start of cycle: just z₀
    expect(revealedCount(400, 10, 1000, 0.8)).toBe(5) // phase .4 → t .5 → 1+4
    expect(revealedCount(800, 10, 1000, 0.8)).toBe(10) // sweep done → hold full
    expect(revealedCount(950, 10, 1000, 0.8)).toBe(10) // still holding full
  })

  it('loops every period', () => {
    expect(revealedCount(1400, 10, 1000, 0.8)).toBe(revealedCount(400, 10, 1000, 0.8))
  })

  it('never exceeds nDrawn and handles the 0/1-point cases', () => {
    expect(revealedCount(0, 0, 1000, 0.8)).toBe(0)
    expect(revealedCount(123, 1, 1000, 0.8)).toBe(1)
    for (let e = 0; e < 1000; e += 37) {
      const r = revealedCount(e, 8, 1000, 0.8)
      expect(r).toBeGreaterThanOrEqual(1)
      expect(r).toBeLessThanOrEqual(8)
    }
  })
})

describe('complexToCss / cssToComplex', () => {
  // Display ratio 1 (buffer == CSS box) keeps the anchors easy to reason about.
  const view: ViewGeometry = {
    centerRe: -0.5,
    centerIm: 0.1,
    zoom: 1,
    logicalW: 800,
    logicalH: 600,
    rectW: 800,
    rectH: 600,
  }

  it('round-trips an arbitrary CSS pixel within fp tolerance', () => {
    const c = cssToComplex(123.5, 456.25, view)
    const back = complexToCss(c.re, c.im, view)
    expect(back.x).toBeCloseTo(123.5, 9)
    expect(back.y).toBeCloseTo(456.25, 9)
  })

  it('maps the grid centre to the viewport centre', () => {
    // The geometric centre of the pixel grid is (logicalW-1)/2, (logicalH-1)/2.
    const c = cssToComplex((800 - 1) / 2, (600 - 1) / 2, view)
    expect(c.re).toBeCloseTo(view.centerRe, 12)
    expect(c.im).toBeCloseTo(view.centerIm, 12)
  })

  it('reproduces the Rust pixel_to_complex_f anchor at the top-left pixel', () => {
    // Cross-check the literal formula (not the implementation): for center
    // (0,0), zoom 1, 800×600, pixel (0,0) is (−399.5·scale, +299.5·scale).
    const ref: ViewGeometry = { ...view, centerRe: 0, centerIm: 0 }
    const scale = pixelScale(1)
    const c = cssToComplex(0, 0, ref)
    expect(c.re).toBeCloseTo(-399.5 * scale, 12)
    expect(c.im).toBeCloseTo(299.5 * scale, 12)
  })

  it('honours the CSS↔logical display ratio when the canvas is stretched', () => {
    // A 1600-CSS-wide canvas backed by an 800-logical grid: the CSS pixel that
    // maps to the grid centre (logical 399.5, 299.5) lands on the viewport
    // centre — 2× the logical coordinate at this ratio.
    const stretched: ViewGeometry = { ...view, rectW: 1600, rectH: 1200 }
    const c = cssToComplex(399.5 * 2, 299.5 * 2, stretched)
    expect(c.re).toBeCloseTo(view.centerRe, 12)
    expect(c.im).toBeCloseTo(view.centerIm, 12)
  })
})

describe('cssToBufferPixel (E2, #95)', () => {
  it('floors a CSS pixel to the containing buffer cell at 1× (buffer == CSS box)', () => {
    // 800×600 CSS box over an 800×600 backing store: a fractional coordinate
    // stays inside its current cell (floor), not the nearest sample centre.
    expect(cssToBufferPixel(123.4, 456.6, 800, 600, 800, 600)).toEqual({ px: 123, py: 456 })
  })

  it('maps against the backing store, not the CSS box, at 2× render scale', () => {
    // 800×600 CSS box over a 1600×1200 backing store (render scale 2×): the CSS
    // centre reaches the buffer centre and the far edge reaches the far buffer —
    // a CSS-box mapping would only ever address the top-left quarter.
    expect(cssToBufferPixel(400, 300, 800, 600, 1600, 1200)).toEqual({ px: 800, py: 600 })
    expect(cssToBufferPixel(799, 599, 800, 600, 1600, 1200)).toEqual({ px: 1598, py: 1198 })
  })

  it('maps against the backing store at 0.5× render scale', () => {
    // 800×600 CSS box over a 400×300 backing store (render scale 0.5×).
    expect(cssToBufferPixel(400, 300, 800, 600, 400, 300)).toEqual({ px: 200, py: 150 })
  })

  it('clamps a cursor on the far edge into the buffer (never one past the last pixel)', () => {
    expect(cssToBufferPixel(800, 600, 800, 600, 800, 600)).toEqual({ px: 799, py: 599 })
    expect(cssToBufferPixel(-3, -3, 800, 600, 800, 600)).toEqual({ px: 0, py: 0 })
  })

  it('returns null for a degenerate display box', () => {
    expect(cssToBufferPixel(10, 10, 0, 600, 800, 600)).toBeNull()
  })
})
