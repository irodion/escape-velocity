import { describe, expect, it } from 'vitest'
import type { ViewState } from './view-state.js'
import { formatCoords, parse, serialize } from './view-state.js'

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
  orbit: true,
}

describe('serialize / parse', () => {
  it('round-trips every field exactly', () => {
    expect(parse(serialize(SAMPLE))).toEqual(SAMPLE)
  })

  it('round-trips deep-zoom precision without loss', () => {
    // Exact f64 values with long mantissas — `String(n)` is the shortest form
    // that round-trips them, so equality below is exact, not approximate.
    const deep: ViewState = {
      ...SAMPLE,
      re: -0.7436438870371587,
      im: 0.13182590420531198,
      zoom: 123456789.125,
    }
    const back = parse(serialize(deep))
    // String(n) is the shortest round-tripping form, so equality is exact.
    expect(back?.re).toBe(deep.re)
    expect(back?.im).toBe(deep.im)
    expect(back?.zoom).toBe(deep.zoom)
  })

  it('emits a leading # and short keys', () => {
    const hash = serialize(SAMPLE)
    expect(hash.startsWith('#')).toBe(true)
    expect(hash).toContain('z=200')
    expect(hash).toContain('it=256')
    expect(hash).toContain('pal=viridis')
    expect(hash).toContain('kind=mandelbrot')
  })

  it('serializes a negative center without escaping the minus or dot', () => {
    expect(serialize(SAMPLE)).toContain('re=-0.743')
  })
})

describe('parse tolerance', () => {
  it('returns null for an empty hash', () => {
    expect(parse('')).toBeNull()
    expect(parse('#')).toBeNull()
  })

  it('returns null when no key is recognized', () => {
    expect(parse('#foo=bar&baz=1')).toBeNull()
  })

  it('tolerates a leading # or ?', () => {
    expect(parse('#z=10')).toEqual({ zoom: 10 })
    expect(parse('?z=10')).toEqual({ zoom: 10 })
    expect(parse('z=10')).toEqual({ zoom: 10 })
  })

  it('drops non-finite numbers but keeps the valid siblings', () => {
    expect(parse('#re=abc&im=0.5')).toEqual({ im: 0.5 })
    expect(parse('#re=NaN&im=Infinity&z=5')).toEqual({ zoom: 5 })
  })

  it('drops a non-positive zoom (the Viewport constructor requires zoom > 0)', () => {
    expect(parse('#z=0')).toBeNull()
    expect(parse('#z=-3')).toBeNull()
  })

  it('keeps a raw out-of-stop maxIter (caller snaps it to a stop)', () => {
    // A stale value like 1000 is not a slider stop; parse returns it verbatim
    // (validated finite & positive) and the caller runs `nearestMaxIterStop`.
    expect(parse('#it=1000')).toEqual({ maxIter: 1000 })
    expect(parse('#it=0')).toBeNull()
  })

  it('drops unknown enum values, keeping known ones', () => {
    expect(parse('#pal=chartreuse&norm=cycled')).toEqual({ normalisation: 'cycled' })
    expect(parse('#kind=hexagon')).toBeNull()
    expect(parse('#field=escape-time')).toEqual({ field: 'escape-time' })
  })

  it('accepts every documented enum member', () => {
    expect(parse('#pal=kahol-lavan')?.palette).toBe('kahol-lavan')
    expect(parse('#norm=logarithmic')?.normalisation).toBe('logarithmic')
    expect(parse('#kind=julia')?.mode).toBe('julia')
  })

  it('parses the orbit toggle as a strict 1/0 boolean, dropping anything else', () => {
    expect(parse('#orb=1')).toEqual({ orbit: true })
    expect(parse('#orb=0')).toEqual({ orbit: false })
    // Junk / truthy-looking strings are not 1|0, so the field drops out and the
    // caller falls back to the default (orbit on).
    expect(parse('#orb=true')).toBeNull()
    expect(parse('#orb=2')).toBeNull()
  })

  it('parses a partial hash into just the fields present', () => {
    expect(parse('#re=-0.5&im=0&z=120')).toEqual({ re: -0.5, im: 0, zoom: 120 })
  })
})

describe('formatCoords', () => {
  it('shows signed re/im to five decimals and scientific zoom', () => {
    expect(formatCoords(-0.7435, 0.1314, 200)).toBe('re −0.74350 · im +0.13140 · zoom 2.0e2')
  })

  it('uses a typographic minus and an explicit plus', () => {
    const out = formatCoords(-1, 2, 1)
    expect(out).toContain('re −1.00000')
    expect(out).toContain('im +2.00000')
  })

  it('renders +0 for a zero component', () => {
    expect(formatCoords(0, 0, 1)).toBe('re +0.00000 · im +0.00000 · zoom 1.0e0')
  })

  it('keeps zoom compact at deep magnification', () => {
    expect(formatCoords(0, 0, 1.2e9)).toContain('zoom 1.2e9')
  })
})
