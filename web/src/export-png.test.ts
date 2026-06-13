import { describe, expect, it } from 'vitest'
import { buildFilename } from './export-png.js'
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
