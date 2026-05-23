import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Viewport } from '../wasm/fractal_wasm.js'
import { InputController } from './input.js'

// Plain JS double for Viewport. The InputController only ever calls
// `pan_by_pixels` and `zoom_around` on its viewport, so a structural
// double covers the surface. Each method is a `vi.fn` returning a
// sentinel viewport so we can assert which call produced the
// `onChange` argument.
function makeViewportDouble(): {
  pan_by_pixels: ReturnType<typeof vi.fn>
  zoom_around: ReturnType<typeof vi.fn>
} {
  return {
    pan_by_pixels: vi.fn(),
    zoom_around: vi.fn(),
  }
}

function setRect(
  canvas: HTMLCanvasElement,
  rect: { left?: number; top?: number; width: number; height: number },
): void {
  const { left = 0, top = 0, width, height } = rect
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect)
}

describe('InputController', () => {
  let canvas: HTMLCanvasElement
  let onChange: ReturnType<typeof vi.fn<(viewport: Viewport) => void>>
  let viewport: ReturnType<typeof makeViewportDouble>

  beforeEach(() => {
    canvas = document.createElement('canvas')
    canvas.id = 'fractal'
    // Internal resolution; rect (CSS size) is set per-test via setRect.
    canvas.width = 800
    canvas.height = 600
    document.body.appendChild(canvas)
    setRect(canvas, { width: 800, height: 600 })
    onChange = vi.fn<(viewport: Viewport) => void>()
    viewport = makeViewportDouble()
  })

  afterEach(() => {
    document.body.removeChild(canvas)
    vi.restoreAllMocks()
  })

  it('emits exactly one onChange on mouseup, none during mousemove', () => {
    const panned = { sentinel: 'panned' } as unknown as Viewport
    viewport.pan_by_pixels.mockReturnValue(panned)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 130, clientY: 70, bubbles: true }),
    )
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 150, clientY: 90, bubbles: true }),
    )
    expect(onChange).not.toHaveBeenCalled()

    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 150, clientY: 90, bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(panned)
    // dx = 150 - 100 = 50, dy = 90 - 50 = 40. Rect matches internal,
    // so internal deltas equal CSS deltas. Sign matches Slice 2A:
    // positive delta = image shifts in that direction.
    expect(viewport.pan_by_pixels).toHaveBeenCalledTimes(1)
    expect(viewport.pan_by_pixels).toHaveBeenCalledWith(50, 40)
  })

  it('applies a CSS translate during mousemove and clears it on mouseup', () => {
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 130, clientY: 70, bubbles: true }),
    )
    expect(canvas.style.transform).toBe('translate(30px, 20px)')

    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 175, clientY: 100, bubbles: true }),
    )
    expect(canvas.style.transform).toBe('translate(75px, 50px)')

    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 175, clientY: 100, bubbles: true }))
    expect(canvas.style.transform).toBe('')
  })

  it('completes the drag when mouseup is dispatched on document outside the canvas', () => {
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    // Coordinates far outside the canvas — document still routes the
    // mouseup to the controller because the listener is on `document`.
    document.dispatchEvent(
      new MouseEvent('mouseup', { clientX: 5000, clientY: 5000, bubbles: true }),
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(viewport.pan_by_pixels).toHaveBeenCalledTimes(1)
  })

  it('toggles the dragging class on mousedown / mouseup', () => {
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    expect(canvas.classList.contains('dragging')).toBe(false)
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, bubbles: true }))
    expect(canvas.classList.contains('dragging')).toBe(true)
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, bubbles: true }))
    expect(canvas.classList.contains('dragging')).toBe(false)
  })

  it('wheel emits one onChange with zoom_around at the cursor and the expected factor', () => {
    const zoomed = { sentinel: 'zoomed' } as unknown as Viewport
    viewport.zoom_around.mockReturnValue(zoomed)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    // factor = 1.25 ^ (-100 / 100) = 1 / 1.25 = 0.8
    expect(viewport.zoom_around).toHaveBeenCalledTimes(1)
    expect(viewport.zoom_around).toHaveBeenCalledWith(200, 150, 1.25 ** -1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(zoomed)
  })

  it('wheel respects canvas-CSS-vs-internal scaling', () => {
    viewport.zoom_around.mockReturnValue({} as unknown as Viewport)
    // Canvas is 800x600 internally but displayed at half size.
    setRect(canvas, { left: 0, top: 0, width: 400, height: 300 })
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    // CSS-centre cursor at (200, 150) ⇒ internal pixel (400, 300).
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 0,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(viewport.zoom_around).toHaveBeenCalledWith(400, 300, 1)
  })

  it('wheel calls preventDefault', () => {
    viewport.zoom_around.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    const event = new WheelEvent('wheel', {
      deltaY: 100,
      clientX: 0,
      clientY: 0,
      bubbles: true,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    canvas.dispatchEvent(event)
    expect(preventDefault).toHaveBeenCalled()
  })
})
