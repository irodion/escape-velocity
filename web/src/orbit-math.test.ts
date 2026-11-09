import { describe, expect, it } from 'vitest'
import {
  BAILOUT_SQR,
  cssToComplex,
  cssToPaintedPixel,
  revealedCount,
  type ScreenFrame,
  traceOrbit,
} from './orbit-math.js'
import { computeBufferDims } from './render-buffer.js'
import { cssToGrid, pixelScale, Viewport } from './viewport.js'
import { applyZoomNotch, beginZoomPreview } from './zoom-preview.js'

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
  const NO_SHIFT = { dx: 0, dy: 0 }
  const view: ScreenFrame = {
    rendered: viewport,
    buffer: { width: 800, height: 600 },
    shift: NO_SHIFT,
    rect: { width: 800, height: 600 },
    view: viewport,
    preview: null,
  }

  it('picks the sample drawn under the cursor, the pixel the inspector probes', () => {
    // A cursor in the middle of cell (100, 50) is over buffer pixel (100, 50),
    // rendered from the sample at grid coordinate (100, 50), not (100.5, 50.5).
    expect(cssToPaintedPixel(100.5, 50.5, view)).toEqual({ px: 100, py: 50 })
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
      expect(cssToPaintedPixel(x, y, view)).toEqual({ px: 10, py: 20 })
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
    const ref: ScreenFrame = { ...view, rendered: new Viewport(0, 0, 1, 800, 600) }
    const scale = pixelScale(1)
    const c = cssToComplex(0.5, 0.5, ref)
    expect(c.re).toBeCloseTo(-399.5 * scale, 12)
    expect(c.im).toBeCloseTo(299.5 * scale, 12)
  })

  it('honours the CSS↔buffer display ratio when the frame is stretched', () => {
    // A 1600×1200 CSS box over the 800×600 buffer: CSS (801, 601) is in
    // buffer cell (400, 300). The same holds for an old frame stretched over a
    // resized window until the new one paints.
    const stretched: ScreenFrame = { ...view, rect: { width: 1600, height: 1200 } }
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
      // The containing buffer cell, from the CSS point by hand.
      const px = Math.min(Math.floor((x / w) * buffer.width), buffer.width - 1)
      const py = Math.min(Math.floor((y / h) * buffer.height), buffer.height - 1)
      expect(
        cssToComplex(x, y, {
          rendered,
          buffer,
          rect,
          shift: NO_SHIFT,
          view: logical,
          preview: null,
        }),
      ).toEqual(rendered.pixelToComplex(px, py))
    }
  })

  it('names the exact point in the strip a pan exposed, and the drawn pixel elsewhere', () => {
    // A pan 100 px right, its frame not painted yet: the store already holds
    // the panned view, and the canvas shows the old frame shifted.
    const panned = viewport.panByPixels(100, 0)
    const afterPan: ScreenFrame = { ...view, shift: { dx: 100, dy: 0 }, view: panned }
    const grid = cssToGrid(panned, view.rect, 50.5, 300.5)
    expect(cssToComplex(50.5, 300.5, afterPan)).toEqual(panned.pixelToComplex(grid.x, grid.y))
    expect(cssToComplex(300.5, 300.5, afterPan)).toEqual(viewport.pixelToComplex(200, 300))
  })

  describe('under a zoom Preview', () => {
    // A two-notch scrub about an off-centre cursor: the Preview scales the
    // painted frame about that point, so the frame's pixel under the cursor
    // there is the one it was under before the scrub.
    const rect = { width: 800, height: 600 }
    const [ax, ay] = [250.3, 170.6]
    const grid = cssToGrid(viewport, rect, ax, ay)
    let preview = beginZoomPreview(viewport)
    for (let i = 0; i < 2; i++) preview = applyZoomNotch(preview, grid.x, grid.y, ax, ay, 1.25)

    it('carries the cursor back through the transform onto the painted frame', () => {
      // The anchor is a fixed point of the transform.
      expect(cssToComplex(ax, ay, { ...view, preview })).toEqual(cssToComplex(ax, ay, view))
      // Elsewhere, the shown point p came from the frame's (p − t) / scale.
      const [x, y] = [612.4, 77.9]
      const fx = (x - preview.tx) / preview.scale
      const fy = (y - preview.ty) / preview.scale
      expect(cssToComplex(x, y, { ...view, preview })).toEqual(
        viewport.pixelToComplex(Math.floor(fx), Math.floor(fy)),
      )
    })

    it('names the exact point under the cursor beyond a zoomed-out frame', () => {
      // The frame shrunk about the centre: the screen depicts the zoom-out's
      // viewport, and outside the old frame nothing was rendered, so the pick
      // is the point there, not the frame's edge pixel.
      const out = { scale: 0.5, tx: 200, ty: 150 }
      const zoomedOut = new Viewport(viewport.centerRe, viewport.centerIm, 0.5, 800, 600)
      const exact = (x: number, y: number) => {
        const grid = cssToGrid(zoomedOut, view.rect, x, y)
        return zoomedOut.pixelToComplex(grid.x, grid.y)
      }
      const shrunk = { ...view, view: zoomedOut, preview: out }
      expect(cssToComplex(10, 10, shrunk)).toEqual(exact(10, 10))
      expect(cssToComplex(790, 590, shrunk)).toEqual(exact(790, 590))
      // Inside the old frame, still its drawn pixel: CSS (400, 300) is (400, 300).
      expect(cssToComplex(400.5, 300.5, shrunk)).toEqual(viewport.pixelToComplex(401, 301))
    })
  })
})

describe('cssToPaintedPixel (E2, #95)', () => {
  const frame = (bufferW: number, bufferH: number): ScreenFrame => ({
    rendered: new Viewport(0, 0, 1, bufferW, bufferH),
    buffer: { width: bufferW, height: bufferH },
    rect: { width: 800, height: 600 },
    shift: { dx: 0, dy: 0 },
    view: new Viewport(0, 0, 1, bufferW, bufferH),
    preview: null,
  })

  it('floors a CSS pixel to the containing buffer cell at 1× (buffer == CSS box)', () => {
    // 800×600 CSS box over an 800×600 buffer: a fractional coordinate stays
    // inside its current cell (floor), not the nearest sample centre.
    expect(cssToPaintedPixel(123.4, 456.6, frame(800, 600))).toEqual({ px: 123, py: 456 })
  })

  it('maps against the buffer, not the CSS box, at 2× render scale', () => {
    // 800×600 CSS box over a 1600×1200 buffer (render scale 2×): the CSS
    // centre reaches the buffer centre and the far edge reaches the far buffer —
    // a CSS-box mapping would only ever address the top-left quarter.
    expect(cssToPaintedPixel(400, 300, frame(1600, 1200))).toEqual({ px: 800, py: 600 })
    expect(cssToPaintedPixel(799, 599, frame(1600, 1200))).toEqual({ px: 1598, py: 1198 })
  })

  it('maps against the buffer at 0.5× render scale', () => {
    expect(cssToPaintedPixel(400, 300, frame(400, 300))).toEqual({ px: 200, py: 150 })
  })

  it('counts the far edge as the last pixel, and anything beyond as outside the frame', () => {
    expect(cssToPaintedPixel(800, 600, frame(800, 600))).toEqual({ px: 799, py: 599 })
    expect(cssToPaintedPixel(-3, -3, frame(800, 600))).toBeNull()
    expect(cssToPaintedPixel(803, 300, frame(800, 600))).toBeNull()
  })

  it('undoes a pan’s blit: the painted pixel the drag moved under the cursor', () => {
    // A 2× buffer blitted 30.5 buffer pixels right and 12 down: CSS (100, 50)
    // is buffer (200, 100) on the canvas, which shows painted pixel (169, 88).
    const shifted = { ...frame(1600, 1200), shift: { dx: 30.5, dy: 12 } }
    expect(cssToPaintedPixel(100, 50, shifted)).toEqual({ px: 169, py: 88 })
    // The black strip the drag exposed at the left/top holds no pixel.
    expect(cssToPaintedPixel(5, 2, shifted)).toBeNull()
  })

  it('maps through the canvas buffer, not the frame, when a drag redraws an older, smaller snapshot', () => {
    // A frame that painted mid-drag resized the canvas to 1000×750; the drag's
    // next blit draws its 800×600 snapshot into it 1:1, 20 px right. CSS
    // (400, 300) over the 800×600 box is canvas pixel (500, 375): snapshot
    // pixel (480, 375).
    const resized = {
      ...frame(800, 600),
      buffer: { width: 1000, height: 750 },
      shift: { dx: 20, dy: 0 },
    }
    expect(cssToPaintedPixel(400, 300, resized)).toEqual({ px: 480, py: 375 })
    // Beyond the snapshot's right edge: the black the blit left, no pixel.
    expect(cssToPaintedPixel(790, 300, resized)).toBeNull()
  })

  it('composes a pan’s blit with a zoom Preview over it', () => {
    // Preview 2× about the origin over a canvas shifted 10 buffer pixels right:
    // CSS (100, 100) is untransformed (50, 50), canvas pixel (50, 50), painted
    // pixel (40, 50).
    const both = {
      ...frame(800, 600),
      shift: { dx: 10, dy: 0 },
      preview: { scale: 2, tx: 0, ty: 0 },
    }
    expect(cssToPaintedPixel(100, 100, both)).toEqual({ px: 40, py: 50 })
  })
})
