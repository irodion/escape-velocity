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

// Minimal 2D context stub. jsdom does not implement canvas painting,
// so `canvas.getContext('2d')` returns null by default. The
// InputController calls `getImageData` on mousedown and
// `fillRect` / `putImageData` on mousemove — these three are the only
// canvas-API touchpoints, so the stub only needs to spy on them.
function makeCtxStub(snapshot: ImageData): {
  ctx: CanvasRenderingContext2D
  getImageData: ReturnType<typeof vi.fn>
  putImageData: ReturnType<typeof vi.fn>
  fillRect: ReturnType<typeof vi.fn>
} {
  const getImageData = vi.fn().mockReturnValue(snapshot)
  const putImageData = vi.fn()
  const fillRect = vi.fn()
  const ctx = {
    getImageData,
    putImageData,
    fillRect,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D
  return { ctx, getImageData, putImageData, fillRect }
}

describe('InputController', () => {
  let canvas: HTMLCanvasElement
  let onChange: ReturnType<typeof vi.fn<(viewport: Viewport) => void>>
  let viewport: ReturnType<typeof makeViewportDouble>
  let snapshot: ImageData
  let ctxStub: ReturnType<typeof makeCtxStub>

  beforeEach(() => {
    canvas = document.createElement('canvas')
    canvas.id = 'fractal'
    // Internal resolution; rect (CSS size) is set per-test via setRect.
    canvas.width = 800
    canvas.height = 600
    document.body.appendChild(canvas)
    setRect(canvas, { width: 800, height: 600 })
    snapshot = {
      data: new Uint8ClampedArray(800 * 600 * 4),
      width: 800,
      height: 600,
      colorSpace: 'srgb',
    } as ImageData
    ctxStub = makeCtxStub(snapshot)
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctxStub.ctx)
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

  it('snapshots the canvas on mousedown and paints it at the drag offset on mousemove', () => {
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    expect(ctxStub.getImageData).toHaveBeenCalledWith(0, 0, 800, 600)

    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 130, clientY: 70, bubbles: true }),
    )
    // dx=30, dy=20; rect matches internal so no scaling. Each mousemove
    // re-paints the full canvas (fillRect black, then putImageData at
    // offset) — no CSS transform applied.
    expect(ctxStub.fillRect).toHaveBeenLastCalledWith(0, 0, 800, 600)
    expect(ctxStub.putImageData).toHaveBeenLastCalledWith(snapshot, 30, 20)
    expect(canvas.style.transform).toBe('')

    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 175, clientY: 100, bubbles: true }),
    )
    expect(ctxStub.putImageData).toHaveBeenLastCalledWith(snapshot, 75, 50)

    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 175, clientY: 100, bubbles: true }))
    // No transform was ever applied; nothing to clear.
    expect(canvas.style.transform).toBe('')
  })

  it('scales the drag offset to canvas-internal pixels', () => {
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    // Canvas is 800x600 internally but displayed at half size.
    setRect(canvas, { left: 0, top: 0, width: 400, height: 300 })
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 150, clientY: 80, bubbles: true }),
    )
    // 50 CSS px × (800/400) = 100 internal px; 30 CSS × (600/300) = 60.
    expect(ctxStub.putImageData).toHaveBeenLastCalledWith(snapshot, 100, 60)

    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 150, clientY: 80, bubbles: true }))
    expect(viewport.pan_by_pixels).toHaveBeenCalledWith(100, 60)
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

  it('wheel normalizes line-mode deltas (Firefox-on-Linux style)', () => {
    viewport.zoom_around.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    // Firefox-on-Linux historical wheel: deltaMode = 1 (line),
    // deltaY ≈ ±3 per notch. Without normalization, factor ≈ 0.993
    // — effectively no zoom. With ×40 line scaling, 3 lines → 120
    // normalized pixels → factor = 1.25 ** -1.2 (visible zoom step).
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 3,
        deltaMode: 1,
        clientX: 100,
        clientY: 50,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(viewport.zoom_around).toHaveBeenCalledWith(100, 50, 1.25 ** (-(3 * 40) / 100))
  })

  it('wheel normalizes page-mode deltas', () => {
    viewport.zoom_around.mockReturnValue({} as unknown as Viewport)
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 1,
        deltaMode: 2,
        clientX: 100,
        clientY: 50,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(viewport.zoom_around).toHaveBeenCalledWith(100, 50, 1.25 ** (-(1 * 800) / 100))
  })

  it('bails out cleanly when the canvas rect is 0×0 (display:none, detached)', () => {
    // A degenerate rect (display:none, detached element, etc.) would
    // otherwise divide by zero — producing NaN/Infinity which would
    // throw at the WASM finite-input seam. The guard turns this into
    // a no-op without crashing.
    setRect(canvas, { width: 0, height: 0 })
    new InputController(canvas, viewport as unknown as Viewport, onChange)

    // Wheel on a 0×0 canvas: no zoom_around, no onChange.
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 50,
        clientY: 50,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(viewport.zoom_around).not.toHaveBeenCalled()

    // Drag on a 0×0 canvas: cleanup still happens (class removed,
    // dragState reset implicitly via second mousedown not crashing),
    // but no pan_by_pixels / onChange.
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, bubbles: true }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 20, bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 30, clientY: 20, bubbles: true }))
    expect(viewport.pan_by_pixels).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(canvas.classList.contains('dragging')).toBe(false)
    expect(ctxStub.putImageData).not.toHaveBeenCalled()
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
