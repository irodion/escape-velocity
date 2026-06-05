import { describe, expect, it } from 'vitest'
import { computeBufferDims } from './render-buffer.js'

const CAP = 2_500_000

describe('computeBufferDims', () => {
  it('renders 1:1 at scale 1 when under the pixel budget', () => {
    const dims = computeBufferDims(1280, 720, 1, CAP)
    expect(dims).toEqual({ width: 1280, height: 720, scale: 1 })
  })

  it('supersamples at scale 2 when the result fits the budget', () => {
    // 800×600 ×2 = 1600×1200 = 1.92M px < cap.
    const dims = computeBufferDims(800, 600, 2, CAP)
    expect(dims).toEqual({ width: 1600, height: 1200, scale: 2 })
  })

  it('subsamples at scale 0.5', () => {
    const dims = computeBufferDims(1280, 720, 0.5, CAP)
    expect(dims).toEqual({ width: 640, height: 360, scale: 0.5 })
  })

  it('shrinks to the pixel budget when the window is too large', () => {
    // 4K at scale 1 = 8.29M px > cap → shrink uniformly to ~cap.
    const dims = computeBufferDims(3840, 2160, 1, CAP)
    expect(dims.width * dims.height).toBeLessThanOrEqual(CAP)
    // Within rounding of the budget (not far under it).
    expect(dims.width * dims.height).toBeGreaterThan(CAP * 0.999)
    expect(dims.scale).toBeLessThan(1)
  })

  it('preserves the logical aspect ratio when shrinking to the budget', () => {
    const dims = computeBufferDims(3840, 2160, 1, CAP)
    const logicalAspect = 3840 / 2160
    expect(dims.width / dims.height).toBeCloseTo(logicalAspect, 2)
  })

  it('applies the budget against the scaled size, so scale 2 bites sooner', () => {
    // 1600×1200 logical ×2 = 3200×2400 = 7.68M px > cap → shrunk.
    const dims = computeBufferDims(1600, 1200, 2, CAP)
    expect(dims.width * dims.height).toBeLessThanOrEqual(CAP)
    expect(dims.scale).toBeLessThan(2)
  })

  it('floors degenerate (zero / NaN / negative) logical sizes to 1×1', () => {
    expect(computeBufferDims(0, 0, 1, CAP)).toEqual({ width: 1, height: 1, scale: 1 })
    expect(computeBufferDims(Number.NaN, 600, 1, CAP).width).toBe(1)
    expect(computeBufferDims(-100, -50, 1, CAP)).toEqual({ width: 1, height: 1, scale: 1 })
  })

  it('never returns a zero dimension even when a tiny scale would round to 0', () => {
    const dims = computeBufferDims(1, 1, 0.1, CAP)
    expect(dims.width).toBeGreaterThanOrEqual(1)
    expect(dims.height).toBeGreaterThanOrEqual(1)
  })
})
