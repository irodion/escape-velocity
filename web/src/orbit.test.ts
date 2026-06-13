import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitOverlay } from './orbit.js'
import type { ViewportStore } from './viewport-store.js'

// A 2D context stub that just tallies calls — the overlay's drawing is exercised
// for its state transitions, not its pixels (same spirit as drawer.test.ts under
// jsdom, where canvas has no real raster backend).
function makeCtx(): { ctx: CanvasRenderingContext2D; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        return () => {
          calls[prop] = (calls[prop] ?? 0) + 1
        }
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

// A sentinel viewport exposing only the accessors the overlay reads.
const viewport = () =>
  ({
    center_re: () => 0,
    center_im: () => 0,
    zoom: () => 1,
    width: () => 800,
    height: () => 600,
  }) as unknown as ReturnType<ViewportStore['get']>

// The animation loop is driven by rAF; stub it so a `start()` runs exactly one
// synchronous frame (drawn immediately) and then schedules a frame that never
// fires — the tests assert on that single deterministic frame.
let cancelSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  let id = 0
  vi.stubGlobal('requestAnimationFrame', () => {
    id += 1
    return id
  })
  cancelSpy = vi.fn()
  vi.stubGlobal('cancelAnimationFrame', cancelSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function setup(initialEnabled = true) {
  document.body.innerHTML = `
    <form id="controls"></form>
    <canvas id="surface"></canvas>
    <canvas id="overlay"></canvas>
  `
  const surface = document.getElementById('surface') as HTMLCanvasElement
  const overlay = document.getElementById('overlay') as HTMLCanvasElement
  const { ctx, calls } = makeCtx()
  overlay.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext']
  overlay.getBoundingClientRect = () =>
    ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect

  const store = { get: () => viewport() } as unknown as ViewportStore
  const drawer = { open: false }
  const overlayInstance = new OrbitOverlay(
    overlay,
    surface,
    store,
    { mode: 'mandelbrot', cRe: -0.7, cIm: 0.27015, maxIter: 64, enabled: initialEnabled },
    () => drawer.open,
  )
  // Dots/markers are drawn with arc(); use the tally as a proxy for "drew".
  const drew = (): number => calls.arc ?? 0
  return { overlayInstance, drew, surface, drawer }
}

describe('OrbitOverlay', () => {
  it('draws the orbit diagram when a point is pinned', () => {
    const { overlayInstance, drew } = setup()
    expect(drew()).toBe(0)
    overlayInstance.pin(400, 300)
    expect(drew()).toBeGreaterThan(0)
  })

  it('draws the orbit under the cursor on hover', () => {
    const { overlayInstance: _overlay, drew, surface } = setup()
    surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 150 }))
    expect(drew()).toBeGreaterThan(0)
  })

  it('stops and clears when disabled', () => {
    const { overlayInstance, drew } = setup()
    overlayInstance.pin(400, 300)
    const frozen = drew()
    overlayInstance.sync({
      mode: 'mandelbrot',
      cRe: -0.7,
      cIm: 0.27015,
      maxIter: 64,
      enabled: false,
    })
    expect(cancelSpy).toHaveBeenCalled()
    expect(drew()).toBe(frozen) // nothing drawn after the clear
  })

  it('clears the pin on a mode switch (the seed flips meaning)', () => {
    const { overlayInstance, drew } = setup()
    overlayInstance.pin(400, 300)
    const frozen = drew()
    // Mode change drops the pin; with nothing active, the overlay stops/clears.
    overlayInstance.sync({ mode: 'julia', cRe: -0.7, cIm: 0.27015, maxIter: 64, enabled: true })
    expect(drew()).toBe(frozen)
  })

  it('suppresses a pin while the drawer is open (light-dismiss, not a pin)', () => {
    const { overlayInstance, drew, drawer } = setup()
    drawer.open = true
    overlayInstance.pin(400, 300)
    expect(drew()).toBe(0)
  })

  it('un-pins on Escape when the drawer is closed', () => {
    const { overlayInstance, drew } = setup()
    overlayInstance.pin(400, 300)
    const frozen = drew()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drew()).toBe(frozen)
  })

  it('cancels the queued animation frame when the cursor leaves', () => {
    const { drew, surface } = setup()
    surface.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 150 }))
    const frozen = drew()
    surface.dispatchEvent(new MouseEvent('mouseleave'))
    expect(cancelSpy).toHaveBeenCalled()
    expect(drew()).toBe(frozen) // no stale frame repaints after leaving
  })
})
