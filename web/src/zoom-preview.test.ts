import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, Viewport } from './viewport.js'
import { applyZoomNotch, beginZoomPreview, zoomPreviewTransform } from './zoom-preview.js'

// The frame on screen when a scrub begins. The accumulator reads only the zoom
// `zoomAround` realizes, so the real clamp drives the clamp tests. The cursor
// also moves the centre, which `viewport.test.ts` covers, not this file.
function viewportAt(zoom: number): Viewport {
  return new Viewport(-0.5, 0, zoom, 800, 600)
}

describe('zoom-preview accumulator', () => {
  it('begins at the identity transform over the given viewport', () => {
    const vp = viewportAt(1)
    const preview = beginZoomPreview(vp)
    expect(preview.viewport).toBe(vp)
    expect(preview.scale).toBe(1)
    expect(preview.tx).toBe(0)
    expect(preview.ty).toBe(0)
    expect(zoomPreviewTransform(preview)).toBe('translate(0px, 0px) scale(1)')
  })

  it('scales about the cursor on a single notch', () => {
    // factor 2 about anchor (100, 50): p ↦ 2·p + a·(1−2) = 2·p − a.
    const preview = applyZoomNotch(beginZoomPreview(viewportAt(1)), 100, 50, 100, 50, 2)
    expect(preview.scale).toBe(2)
    expect(preview.tx).toBe(-100)
    expect(preview.ty).toBe(-50)
    expect(preview.viewport.zoom).toBe(2)
  })

  it('holds the cursor point fixed (scale·anchor + t === anchor)', () => {
    for (const [ax, ay, factor] of [
      [100, 50, 2],
      [320, 240, 1.25],
      [0, 0, 4],
      [799, 599, 0.5],
    ] as const) {
      const p = applyZoomNotch(beginZoomPreview(viewportAt(1)), ax, ay, ax, ay, factor)
      expect(p.scale * ax + p.tx).toBeCloseTo(ax, 9)
      expect(p.scale * ay + p.ty).toBeCloseTo(ay, 9)
    }
  })

  it('composes multiple notches at differing anchors (closed form)', () => {
    // Notch 1: factor 2 about (100, 50) → scale 2, t = (−100, −50).
    // Notch 2: factor 2 about (200, 100). realized = 4/2 = 2.
    //   scale' = 2·2 = 4
    //   tx'    = 2·(−100) + 200·(1−2) = −400
    //   ty'    = 2·(−50)  + 100·(1−2) = −200
    let p = beginZoomPreview(viewportAt(1))
    p = applyZoomNotch(p, 100, 50, 100, 50, 2)
    p = applyZoomNotch(p, 200, 100, 200, 100, 2)
    expect(p.scale).toBe(4)
    expect(p.tx).toBe(-400)
    expect(p.ty).toBe(-200)
    expect(p.viewport.zoom).toBe(4)
  })

  it('keeps scale equal to viewport.zoom/startZoom across a scrub', () => {
    // The load-bearing consistency property: the matrix scale never
    // drifts from the realized cumulative zoom, at any anchors/factors.
    const startZoom = 3
    let p = beginZoomPreview(viewportAt(startZoom))
    for (const [ax, ay, factor] of [
      [120, 80, 1.25],
      [400, 300, 1.25],
      [50, 600, 0.8],
      [700, 100, 2],
    ] as const) {
      p = applyZoomNotch(p, ax, ay, ax, ay, factor)
      expect(p.scale).toBeCloseTo(p.viewport.zoom / startZoom, 9)
    }
  })

  it('freezes the Preview at the MAX_ZOOM clamp (realized ratio → 1)', () => {
    // Start at the ceiling: zoomAround clamps, so the viewport does not
    // move and the matrix must not either, however hard the user scrubs.
    let p = beginZoomPreview(viewportAt(MAX_ZOOM))
    const before = { ...p }
    p = applyZoomNotch(p, 400, 300, 400, 300, 8)
    expect(p.viewport.zoom).toBe(MAX_ZOOM)
    expect(p.scale).toBe(before.scale)
    expect(p.tx).toBe(before.tx)
    expect(p.ty).toBe(before.ty)
  })

  it('freezes the Preview at the MIN_ZOOM clamp (realized ratio → 1)', () => {
    let p = beginZoomPreview(viewportAt(MIN_ZOOM))
    p = applyZoomNotch(p, 10, 10, 10, 10, 0.1)
    expect(p.viewport.zoom).toBe(MIN_ZOOM)
    expect(p.scale).toBe(1)
    expect(p.tx).toBe(0)
    expect(p.ty).toBe(0)
  })

  it('partially advances then freezes when a notch straddles the clamp', () => {
    // One notch from below the ceiling that overshoots: the realized
    // ratio is the clamped move (MAX/start), not the raw factor, so the
    // Preview lands exactly on the clamp with no overshoot to snap back.
    const start = MAX_ZOOM / 4
    let p = beginZoomPreview(viewportAt(start))
    p = applyZoomNotch(p, 0, 0, 0, 0, 100)
    expect(p.viewport.zoom).toBe(MAX_ZOOM)
    expect(p.scale).toBeCloseTo(MAX_ZOOM / start, 6) // == 4, not 100
  })
})
