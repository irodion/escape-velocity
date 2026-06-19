import { describe, expect, it } from 'vitest'
import type { Settings } from './settings.js'
import { classifyTransition, sanitizeSettings } from './settings-transition.js'

// A finite, coherent baseline. Each test derives a `next` from a focused
// override so exactly one axis (or a deliberate combination) changes.
const BASE: Settings = {
  maxIter: 256,
  renderScale: 1,
  palette: 'viridis',
  normalisation: 'cycled',
  field: 'escape-time',
  mode: 'mandelbrot',
  cRe: 0,
  cIm: 0,
  orbit: false,
  inspect: false,
}

const JULIA: Settings = { ...BASE, mode: 'julia', cRe: -0.4, cIm: 0.6 }

const change = (over: Partial<Settings>): Settings => ({ ...BASE, ...over })

describe('classifyTransition', () => {
  it('identical settings → noop', () => {
    expect(classifyTransition(BASE, { ...BASE })).toEqual({ action: 'noop' })
  })

  describe('reset-view (fractal-family change)', () => {
    it('Mandelbrot → Julia lands on the origin frame', () => {
      expect(classifyTransition(BASE, change({ mode: 'julia' }))).toEqual({
        action: 'reset-view',
        view: { re: 0, im: 0, zoom: 1 },
      })
    })

    it('Julia → Mandelbrot lands on the (-0.5, 0) frame', () => {
      expect(classifyTransition(JULIA, { ...JULIA, mode: 'mandelbrot' })).toEqual({
        action: 'reset-view',
        view: { re: -0.5, im: 0, zoom: 1 },
      })
    })
  })

  describe('recompute (compute-class changes)', () => {
    it('renderScale change → recompute', () => {
      expect(classifyTransition(BASE, change({ renderScale: 2 }))).toEqual({ action: 'recompute' })
    })

    it('maxIter change → recompute', () => {
      expect(classifyTransition(BASE, change({ maxIter: 512 }))).toEqual({ action: 'recompute' })
    })

    it('Field change → recompute (ADR-0013: never recolorize)', () => {
      expect(classifyTransition(BASE, change({ field: 'distance-estimate' }))).toEqual({
        action: 'recompute',
      })
    })

    it('Julia c change → recompute', () => {
      expect(classifyTransition(JULIA, { ...JULIA, cRe: 0.285 })).toEqual({ action: 'recompute' })
      expect(classifyTransition(JULIA, { ...JULIA, cIm: 0.01 })).toEqual({ action: 'recompute' })
    })
  })

  describe('recolorize (visual-only, the ADR-0002 fast path)', () => {
    it('palette change → recolorize', () => {
      expect(classifyTransition(BASE, change({ palette: 'magma' }))).toEqual({
        action: 'recolorize',
      })
    })

    it('normalisation change → recolorize', () => {
      expect(classifyTransition(BASE, change({ normalisation: 'linear' }))).toEqual({
        action: 'recolorize',
      })
    })
  })

  describe('noop', () => {
    it('Mandelbrot c change → noop (c is carried but ignored)', () => {
      expect(classifyTransition(BASE, change({ cRe: 1.23, cIm: -0.5 }))).toEqual({ action: 'noop' })
    })

    it('orbit-only toggle → noop (overlay handled outside the render path)', () => {
      expect(classifyTransition(BASE, change({ orbit: true }))).toEqual({ action: 'noop' })
    })

    it('inspect-only toggle → noop (E2, #95: a view-only probe, no recompute)', () => {
      expect(classifyTransition(BASE, change({ inspect: true }))).toEqual({ action: 'noop' })
    })
  })

  describe('branch precedence (first matching axis wins)', () => {
    it('family change + palette change → reset-view, not recolorize', () => {
      expect(classifyTransition(BASE, change({ mode: 'julia', palette: 'magma' }))).toEqual({
        action: 'reset-view',
        view: { re: 0, im: 0, zoom: 1 },
      })
    })

    it('maxIter change + palette change → recompute, not recolorize', () => {
      expect(classifyTransition(BASE, change({ maxIter: 512, palette: 'magma' }))).toEqual({
        action: 'recompute',
      })
    })
  })
})

describe('sanitizeSettings', () => {
  it('passes finite c values through with no back-write', () => {
    const raw = { ...JULIA, cRe: 0.1, cIm: -0.2 }
    expect(sanitizeSettings(JULIA, raw)).toEqual({ next: raw, cBackWrite: false })
  })

  it('substitutes a NaN cRe from current and flags a back-write', () => {
    const raw = { ...JULIA, cRe: Number.NaN }
    const { next, cBackWrite } = sanitizeSettings(JULIA, raw)
    expect(cBackWrite).toBe(true)
    expect(next.cRe).toBe(JULIA.cRe)
    expect(next.cIm).toBe(raw.cIm)
  })

  it('substitutes both NaN components when both are blank', () => {
    const raw = { ...JULIA, cRe: Number.NaN, cIm: Number.NaN }
    const { next, cBackWrite } = sanitizeSettings(JULIA, raw)
    expect(cBackWrite).toBe(true)
    expect(next.cRe).toBe(JULIA.cRe)
    expect(next.cIm).toBe(JULIA.cIm)
  })

  it('preserves the finite invariant: a sanitised NaN classifies as a Julia no-op', () => {
    // Clearing c.re mid-edit (NaN) must sanitise to the current c, so the
    // commit is a no-op rather than a recompute on a NaN that would throw at
    // the WASM seam.
    const raw = { ...JULIA, cRe: Number.NaN }
    const { next } = sanitizeSettings(JULIA, raw)
    expect(classifyTransition(JULIA, next)).toEqual({ action: 'noop' })
  })
})
