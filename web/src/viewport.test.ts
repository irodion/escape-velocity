import { describe, expect, it } from 'vitest'
import {
  BASE_RE_SPAN,
  clampZoom,
  cssToGrid,
  MAX_ZOOM,
  MIN_ZOOM,
  pixelScale,
  REFERENCE_WIDTH,
  Viewport,
} from './viewport.js'

// The properties the main thread relies on, after the Rust tests in
// `crates/fractal-core/src/viewport.rs` (same tolerances). That the two
// implementations agree is `viewport-parity.test.ts`'s job; this file pins the
// TS behaviour.

const sample = (): Viewport => new Viewport(-0.5, 0, 1, 800, 600)

describe('Viewport projection', () => {
  it('maps the top-left pixel to the top-left corner and the grid centre to the centre', () => {
    const vp = sample()
    const scale = vp.pixelScale()
    expect(vp.pixelToComplex(0, 0)).toEqual({ re: -0.5 - 399.5 * scale, im: 299.5 * scale })
    expect(vp.pixelToComplex(399.5, 299.5)).toEqual({ re: -0.5, im: 0 })
  })

  it('keys the pixel scale to the reference width, not the grid width (ADR-0011)', () => {
    expect(pixelScale(1)).toBe(BASE_RE_SPAN / REFERENCE_WIDTH)
    expect(pixelScale(4)).toBe(pixelScale(1) / 4)
    // A grid twice as wide keeps the scale, so it shows twice the real axis.
    const wide = new Viewport(-0.5, 0, 1, 1600, 600)
    expect(wide.pixelScale()).toBe(sample().pixelScale())
    const span = wide.pixelToComplex(1599, 0).re - wide.pixelToComplex(0, 0).re
    expect(span).toBeCloseTo((1599 / REFERENCE_WIDTH) * BASE_RE_SPAN, 12)
  })

  it('inverts pixelToComplex with complexToPixel', () => {
    const vp = new Viewport(-0.7435, 0.1314, 200, 1280, 720)
    for (const [px, py] of [
      [0, 0],
      [123.5, 77.25],
      [1279, 719],
    ]) {
      const c = vp.pixelToComplex(px, py)
      const back = vp.complexToPixel(c.re, c.im)
      expect(back.x).toBeCloseTo(px, 6)
      expect(back.y).toBeCloseTo(py, 6)
    }
  })
})

describe('cssToGrid', () => {
  it('scales CSS by the grid over the box, then names the sample half a pixel back', () => {
    // An 800×600 grid shown in a 400×300 box: CSS (50, 25) is the cell edge at
    // grid (100, 50), so the sample under it is at (99.5, 49.5).
    const vp = sample()
    expect(cssToGrid(vp, { width: 400, height: 300 }, 50, 25)).toEqual({ x: 99.5, y: 49.5 })
    // The middle of a cell is its sample.
    expect(cssToGrid(vp, { width: 800, height: 600 }, 10.5, 20.5)).toEqual({ x: 10, y: 20 })
  })
})

describe('Viewport.panByPixels', () => {
  it('shifts the image: the new pixel (p + dx, q + dy) shows the old pixel (p, q)', () => {
    const vp = sample()
    const panned = vp.panByPixels(50, -25)
    const before = vp.pixelToComplex(100, 200)
    const after = panned.pixelToComplex(150, 175)
    expect(Math.abs(after.re - before.re)).toBeLessThan(1e-12)
    expect(Math.abs(after.im - before.im)).toBeLessThan(1e-12)
  })

  it('moves the centre by exactly −dx and +dy pixel scales, and keeps zoom and grid', () => {
    const vp = sample()
    const scale = vp.pixelScale()
    const panned = vp.panByPixels(10, 20)
    expect(panned.centerRe).toBe(-0.5 - 10 * scale)
    expect(panned.centerIm).toBe(20 * scale)
    expect([panned.zoom, panned.width, panned.height]).toEqual([1, 800, 600])
    expect(vp.panByPixels(0, 0)).toEqual(vp)
  })
})

describe('Viewport.zoomAround', () => {
  it.each([
    [1, 100, 100, 1.25],
    [1, 400, 300, 4],
    [50, 0, 0, 1.1],
    [1e3, 799, 599, 2],
    [1e6, 250.5, 175.25, 0.5],
  ])(
    'keeps the point under the cursor in place (zoom %s, cursor %s,%s, factor %s)',
    (zoom, px, py, factor) => {
      const vp = new Viewport(-0.5, 0.1, zoom, 800, 600)
      const before = vp.pixelToComplex(px, py)
      const zoomed = vp.zoomAround(px, py, factor)
      const after = zoomed.pixelToComplex(px, py)
      expect(zoomed.zoom).toBe(zoom * factor)
      expect(Math.abs(after.re - before.re)).toBeLessThan(1e-12)
      expect(Math.abs(after.im - before.im)).toBeLessThan(1e-12)
      expect([zoomed.width, zoomed.height]).toEqual([800, 600])
    },
  )

  it('is the identity at factor 1', () => {
    const vp = sample()
    expect(vp.zoomAround(123.5, 77, 1)).toEqual(vp)
  })

  it('clamps to [MIN_ZOOM, MAX_ZOOM], landing exactly on the bound', () => {
    expect([clampZoom(1e-310), clampZoom(200), clampZoom(1e300)]).toEqual([MIN_ZOOM, 200, MAX_ZOOM])
    expect(new Viewport(0, 0, MAX_ZOOM, 800, 600).zoomAround(400, 300, 10).zoom).toBe(MAX_ZOOM)
    expect(new Viewport(0, 0, MAX_ZOOM / 2, 800, 600).zoomAround(400, 300, 10).zoom).toBe(MAX_ZOOM)
    expect(new Viewport(0, 0, MIN_ZOOM, 800, 600).zoomAround(400, 300, 0.1).zoom).toBe(MIN_ZOOM)
  })
})

describe('Viewport.withResolution', () => {
  it('keeps the centre and zoom exactly and takes the new grid', () => {
    const vp = new Viewport(-0.7435, 0.1314, 200, 800, 600)
    const resized = vp.withResolution(1920, 1080)
    expect(resized).toEqual(new Viewport(-0.7435, 0.1314, 200, 1920, 1080))
    expect(resized.pixelScale()).toBe(vp.pixelScale())
  })
})

describe('Viewport validation (as the WASM binding did)', () => {
  it.each([
    ['a non-finite centre', () => new Viewport(Number.NaN, 0, 1, 800, 600), 'center re'],
    ['a zero zoom', () => new Viewport(0, 0, 0, 800, 600), 'zoom'],
    ['a zero width', () => new Viewport(0, 0, 1, 0, 600), 'width'],
    ['a fractional height', () => new Viewport(0, 0, 1, 800, 600.5), 'height'],
    ['a non-finite pan', () => sample().panByPixels(Number.POSITIVE_INFINITY, 0), 'dxPixels'],
    ['a non-finite cursor', () => sample().zoomAround(0, Number.NaN, 2), 'pixelY'],
    ['a non-positive factor', () => sample().zoomAround(0, 0, -2), 'factor'],
    ['a zero resize', () => sample().withResolution(800, 0), 'height'],
  ])('rejects %s', (_, build, field) => {
    expect(build).toThrow(field)
  })
})
