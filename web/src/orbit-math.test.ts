import { describe, expect, it } from 'vitest'
import {
  BAILOUT_SQR,
  cssToBufferPixel,
  cssToComplex,
  revealedCount,
  traceOrbit,
  type ViewGeometry,
} from './orbit-math.js'
import { computeBufferDims } from './render-buffer.js'
import { pixelScale, Viewport } from './viewport.js'

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

describe('cssToComplex', () => {
  // Display ratio 1 (buffer == CSS box) keeps the anchors easy to reason about.
  const viewport = new Viewport(-0.5, 0.1, 1, 800, 600)
  const view: ViewGeometry = { viewport, rect: { width: 800, height: 600 } }

  it('picks the sample drawn under the cursor, the pixel the inspector probes', () => {
    // A cursor in the middle of cell (100, 50) is over buffer pixel (100, 50),
    // rendered from the sample at grid coordinate (100, 50), not (100.5, 50.5).
    expect(cssToBufferPixel(100.5, 50.5, 800, 600, 800, 600)).toEqual({ px: 100, py: 50 })
    expect(cssToComplex(100.5, 50.5, view)).toEqual(viewport.pixelToComplex(100, 50))
  })

  it('snaps anywhere in a cell to that cell’s sample, not the cursor’s exact point', () => {
    // Off-centre in cell (10, 20): still the sample at (10, 20), the one the
    // inspector probes, not (10.4, 20.4).
    const sample = viewport.pixelToComplex(10, 20)
    for (const [x, y] of [
      [10, 20],
      [10.9, 20.9],
      [10.1, 20.7],
    ] as const) {
      expect(cssToBufferPixel(x, y, 800, 600, 800, 600)).toEqual({ px: 10, py: 20 })
      expect(cssToComplex(x, y, view)).toEqual(sample)
    }
  })

  it('clamps a cursor on the right or bottom edge into the last pixel', () => {
    expect(cssToComplex(800, 600, view)).toEqual(viewport.pixelToComplex(799, 599))
  })

  it('reproduces the Rust pixel_to_complex_f anchor at the top-left pixel', () => {
    // Cross-check the literal formula (not the implementation): for center
    // (0,0), zoom 1, 800×600, pixel (0,0) is (−399.5·scale, +299.5·scale),
    // drawn under the top-left cell.
    const ref: ViewGeometry = { ...view, viewport: new Viewport(0, 0, 1, 800, 600) }
    const scale = pixelScale(1)
    const c = cssToComplex(0.5, 0.5, ref)
    expect(c.re).toBeCloseTo(-399.5 * scale, 12)
    expect(c.im).toBeCloseTo(299.5 * scale, 12)
  })

  it('honours the CSS↔logical display ratio when the canvas is stretched', () => {
    // A 1600×1200 CSS box over the 800×600 grid: CSS (801, 601) is in logical
    // cell (400, 300).
    const stretched: ViewGeometry = { ...view, rect: { width: 1600, height: 1200 } }
    expect(cssToComplex(801, 601, stretched)).toEqual(viewport.pixelToComplex(400, 300))
  })

  // At render scale s the frame on screen is a buffer of about s× the logical
  // grid, rendered from a viewport at s× the zoom (`main.ts`'s `rerender`).
  // The pick must be exactly the sample the kernel computed for the buffer
  // pixel the inspector probes, including when the buffer size was floored.
  it.each([
    ['scale 2', 800, 600, 2, Number.POSITIVE_INFINITY],
    ['scale 0.5, odd size (floored)', 1279, 719, 0.5, Number.POSITIVE_INFINITY],
    ['scale 1.5, odd size (floored)', 1001, 677, 1.5, Number.POSITIVE_INFINITY],
    ['pixel budget bites', 1279, 719, 2, 2_500_000],
  ])('names the probed buffer pixel’s sample exactly: %s', (_, w, h, scale, budget) => {
    const logical = new Viewport(-0.7435, 0.1314, 200, w, h)
    const rect = { width: w, height: h }
    const buffer = computeBufferDims(w, h, scale, budget)
    // What the worker renders: the request `rerender` builds.
    const rendered = new Viewport(
      logical.centerRe,
      logical.centerIm,
      logical.zoom * buffer.scale,
      buffer.width,
      buffer.height,
    )
    for (const [x, y] of [
      [0.2, 0.2],
      [w / 2 + 0.3, h / 2 - 0.4],
      [w - 0.6, h - 0.1],
      [w * 0.731, h * 0.219],
    ] as const) {
      const pixel = cssToBufferPixel(x, y, w, h, buffer.width, buffer.height)
      if (pixel === null) throw new Error('degenerate box')
      expect(cssToComplex(x, y, { viewport: logical, rect }, buffer)).toEqual(
        rendered.pixelToComplex(pixel.px, pixel.py),
      )
    }
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
