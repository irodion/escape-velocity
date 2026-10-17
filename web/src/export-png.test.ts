import { describe, expect, it } from 'vitest'
import { buildFilename, computeExportDims, EXPORT_MAX_PIXELS } from './export-png.js'
import type { ViewState } from './view-state.js'
import { serialize } from './view-state.js'

const SAMPLE: ViewState = {
  re: -0.743,
  im: 0.1314,
  zoom: 200,
  maxIter: 256,
  palette: 'viridis',
  normalisation: 'cycled',
  mode: 'mandelbrot',
  field: 'escape-time',
  cRe: -0.7,
  cIm: 0.27015,
  orbit: false,
}

describe('buildFilename', () => {
  it('embeds the permalink params with a .png extension and prefix', () => {
    const name = buildFilename(SAMPLE)
    expect(name.startsWith('escape-velocity-')).toBe(true)
    expect(name.endsWith('.png')).toBe(true)
  })

  it('swaps permalink separators for filename-safe characters', () => {
    const name = buildFilename(SAMPLE)
    // `=` → `-` and `&` → `,`, so neither URL separator survives in the name.
    expect(name).not.toContain('=')
    expect(name).not.toContain('&')
    // The leading hash from `serialize` is stripped.
    expect(name).not.toContain('#')
  })

  it('carries every permalink key into the filename', () => {
    const name = buildFilename(SAMPLE)
    // Each `key-value` pair from the (separator-swapped) permalink appears.
    const expected = serialize(SAMPLE).slice(1).replace(/=/g, '-').replace(/&/g, ',')
    expect(name).toBe(`escape-velocity-${expected}.png`)
  })

  it('preserves the negative sign in coordinate values', () => {
    const name = buildFilename(SAMPLE)
    // re=-0.743 → `re--0.743`: the value's own minus is untouched.
    expect(name).toContain('re--0.743')
  })
})

describe('computeExportDims', () => {
  // Ordinary desktop windows (logical CSS px) that the old shared 2.5M on-screen
  // budget clamped (#157): at 2560×1440 both buttons saved the same 0.82× image.
  it.each([
    [1512, 982],
    [1920, 1080],
    [2560, 1440],
  ])('saves a %i×%i window at exactly 1× and 2× the logical size', (w, h) => {
    expect(computeExportDims(w, h, 1)).toEqual({ width: w, height: h, scale: 1 })
    expect(computeExportDims(w, h, 2)).toEqual({ width: w * 2, height: h * 2, scale: 2 })
  })

  it('clamps to the export budget, preserving the aspect ratio', () => {
    // 3440×1440 ultrawide at 2× = 6880×2880 ≈ 19.8M px > budget.
    const dims = computeExportDims(3440, 1440, 2)
    expect(dims.width * dims.height).toBeLessThanOrEqual(EXPORT_MAX_PIXELS)
    expect(dims.width * dims.height).toBeGreaterThan(EXPORT_MAX_PIXELS * 0.999)
    expect(dims.scale).toBeLessThan(2)
    expect(dims.width / dims.height).toBeCloseTo(3440 / 1440, 2)
  })

  it.each([
    [3440, 1440],
    [3840, 2160],
    [7680, 4320],
  ])('keeps a %i×%i 2× export under the iOS Safari 4096² canvas-area limit', (w, h) => {
    const dims = computeExportDims(w, h, 2)
    expect(dims.width * dims.height).toBeLessThanOrEqual(4096 * 4096)
  })
})
