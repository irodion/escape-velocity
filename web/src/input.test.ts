import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Viewport } from '../wasm/fractal_wasm.js'
import { InputController, WHEEL_SETTLE_MS } from './input.js'
import { createViewportStore, type ViewportStore } from './viewport-store.js'

// Plain JS double for Viewport. The InputController calls
// `pan_by_pixels` / `zoom_around` (which produce new viewports) and
// reads `zoom()` (for the Preview's realized ratio) and `width()` /
// `height()` (the logical grid it maps CSS deltas onto), so a structural
// double covers the surface. The pan/zoom methods are `vi.fn`s returning
// a sentinel viewport so we can assert which call produced the `onChange`
// argument; `width`/`height` report the logical 800×600 grid (the
// production display size); `zoom` defaults to 1.
function makeViewportDouble(): {
  pan_by_pixels: ReturnType<typeof vi.fn>
  zoom_around: ReturnType<typeof vi.fn>
  zoom: ReturnType<typeof vi.fn>
  width: ReturnType<typeof vi.fn>
  height: ReturnType<typeof vi.fn>
} {
  return {
    pan_by_pixels: vi.fn(),
    zoom_around: vi.fn(),
    zoom: vi.fn(() => 1),
    width: vi.fn(() => 800),
    height: vi.fn(() => 600),
  }
}

// A zoom_around result that carries its own `zoom()` (the Preview reads
// it to compute the realized ratio) and is itself a full double so a
// follow-up notch in the same scrub can zoom from it.
function makeZoomResult(zoom: number): ReturnType<typeof makeViewportDouble> {
  const vp = makeViewportDouble()
  vp.zoom.mockReturnValue(zoom)
  return vp
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

// Construct a controller wired to a real `ViewportStore` seeded with the
// viewport double, and bridge the controller's gesture commits
// (`store.set(vp, 'gesture')`) to the `onChange` spy the assertions read.
// This is the production shape (A2, #85): the controller no longer takes an
// `onChange`/`initialViewport` — it reads and writes the store. Non-gesture
// writes (a test simulating a refit / mode-reset via `store.set(vp, 'refit')`)
// are intentionally *not* bridged to `onChange`, matching main.ts, where a
// separate subscription owns the rerender and `onChange` modelled only the
// controller's own commits. Returns the store so a test can simulate an
// external viewport change.
function mount(
  canvas: HTMLCanvasElement,
  vp: ReturnType<typeof makeViewportDouble>,
  onChange: (viewport: Viewport) => void,
  onInvalidate?: () => void,
): { controller: InputController; store: ViewportStore } {
  const store = createViewportStore(vp as unknown as Viewport)
  store.subscribe((next, source) => {
    if (source === 'gesture') onChange(next)
  })
  const controller = new InputController(canvas, store, onInvalidate)
  return { controller, store }
}

describe('InputController', () => {
  let canvas: HTMLCanvasElement
  let onChange: ReturnType<typeof vi.fn<(viewport: Viewport) => void>>
  let viewport: ReturnType<typeof makeViewportDouble>
  let snapshot: ImageData
  let ctxStub: ReturnType<typeof makeCtxStub>

  beforeEach(() => {
    // Wheel zoom defers its recompute to a debounced Settle, so the wheel
    // tests drive the clock with fake timers. Pan tests use no timers and
    // are unaffected.
    vi.useFakeTimers()
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
    vi.useRealTimers()
  })

  it('emits exactly one onChange on mouseup, none during mousemove', () => {
    const panned = { sentinel: 'panned' } as unknown as Viewport
    viewport.pan_by_pixels.mockReturnValue(panned)
    mount(canvas, viewport, onChange)

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

  it('maps pan by the logical viewport grid, not the render buffer, when they differ', () => {
    // Slice 3: at render scale 2 the canvas buffer (1600×1200) is twice
    // the viewport's logical grid (800×600), while the CSS display stays
    // 800×600. A drag must move the viewport by *logical* pixels (so the
    // pan distance is independent of render scale) — i.e. scaled by
    // viewport.width()/rect.width (= 1 here), NOT canvas.width/rect.width
    // (= 2), which would double the pan.
    canvas.width = 1600
    canvas.height = 1200
    setRect(canvas, { width: 800, height: 600 })
    const panned = { sentinel: 'panned' } as unknown as Viewport
    viewport.pan_by_pixels.mockReturnValue(panned)
    mount(canvas, viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 150, clientY: 90, bubbles: true }))
    // dx = 50, dy = 40 CSS; logical mapping (800/800, 600/600) leaves
    // them unchanged. Buffer mapping would have produced (100, 80).
    expect(viewport.pan_by_pixels).toHaveBeenCalledWith(50, 40)
  })

  it('commits the pan from the live (refitted) viewport when a resize fires mid-drag', () => {
    // B1 regression. A debounced `refitToCanvas` (ResizeObserver) can fire
    // mid-drag and `store.set` a viewport at new dimensions —
    // `with_resolution` preserves center/zoom but updates width/height to
    // the live box. `handleMouseUp` must commit the pan from that live
    // viewport, not the drag-start snapshot: panning from the snapshot
    // would re-commit the *old* dimensions, reverting the refit and
    // leaving the buffer CSS-stretched onto the new box (non-square
    // pixels) until the next resize — which never comes, the box is stable.
    const refitPanned = { sentinel: 'refit-panned' } as unknown as Viewport
    const refitted = makeViewportDouble()
    refitted.width.mockReturnValue(1000)
    refitted.height.mockReturnValue(700)
    refitted.pan_by_pixels.mockReturnValue(refitPanned)
    const { store } = mount(canvas, viewport, onChange)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    // Resize lands mid-drag: the canvas box grows and the viewport is
    // refitted to 1000×700 via a non-gesture store write — the controller's
    // subscription mirrors it into its working viewport. The CSS box now
    // measures 1000×700 too.
    store.set(refitted as unknown as Viewport, 'refit')
    setRect(canvas, { width: 1000, height: 700 })

    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 150, clientY: 90, bubbles: true }))

    // dx=50, dy=40 CSS; scaled by the live grid (1000/1000, 700/700) → 50,40.
    // The pan must run on the refitted viewport, never the stale snapshot.
    expect(refitted.pan_by_pixels).toHaveBeenCalledTimes(1)
    expect(refitted.pan_by_pixels).toHaveBeenCalledWith(50, 40)
    expect(viewport.pan_by_pixels).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(refitPanned)
  })

  it('snapshots the canvas on mousedown and paints it at the drag offset on mousemove', () => {
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    mount(canvas, viewport, onChange)

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
    mount(canvas, viewport, onChange)

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
    mount(canvas, viewport, onChange)

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
    mount(canvas, viewport, onChange)

    expect(canvas.classList.contains('dragging')).toBe(false)
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, bubbles: true }))
    expect(canvas.classList.contains('dragging')).toBe(true)
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0, clientY: 0, bubbles: true }))
    expect(canvas.classList.contains('dragging')).toBe(false)
  })

  it('a plain click neither discards in-flight work nor commits a pan (B3, #74)', () => {
    // The drawer's light-dismiss is a true click on the canvas: mousedown then
    // mouseup at the same point, no mousemove. It must leave an in-flight deep
    // render untouched (no `onInvalidate`) and never restart it with an
    // identical viewport (no `onChange` / no `pan_by_pixels`) — it is a pure
    // visual no-op. The drag is still torn down.
    const onInvalidate = vi.fn()
    mount(canvas, viewport, onChange, onInvalidate)

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 120, clientY: 80, bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 120, clientY: 80, bubbles: true }))

    expect(onInvalidate).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(viewport.pan_by_pixels).not.toHaveBeenCalled()
    expect(canvas.classList.contains('dragging')).toBe(false)
  })

  it('previews instantly on a wheel notch and defers a single onChange to the Settle', () => {
    const zoomed = makeZoomResult(0.8)
    viewport.zoom_around.mockReturnValue(zoomed)
    mount(canvas, viewport, onChange)

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    // factor = 1.25 ^ (-100 / 100) = 1 / 1.25 = 0.8. zoom_around runs
    // immediately to advance the authoritative viewport...
    expect(viewport.zoom_around).toHaveBeenCalledTimes(1)
    expect(viewport.zoom_around).toHaveBeenCalledWith(200, 150, 1.25 ** -1)
    // ...the Preview transform is applied instantly (cursor-anchored
    // scale) — exact matrix is covered in zoom-preview.test.ts...
    expect(canvas.style.transform).not.toBe('')
    expect(canvas.style.transform).toContain('scale(0.8)')
    // ...but no recompute fires until the wheel goes quiet.
    expect(onChange).not.toHaveBeenCalled()

    vi.advanceTimersByTime(WHEEL_SETTLE_MS)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(zoomed)
  })

  it('coalesces a multi-notch scrub into one onChange at the Settle', () => {
    const afterFirst = makeZoomResult(0.8)
    const afterSecond = makeZoomResult(0.64)
    viewport.zoom_around.mockReturnValue(afterFirst)
    afterFirst.zoom_around.mockReturnValue(afterSecond)
    mount(canvas, viewport, onChange)

    const notch = (): void => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 100,
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    notch()
    notch() // second notch zooms from the first notch's viewport
    expect(viewport.zoom_around).toHaveBeenCalledTimes(1)
    expect(afterFirst.zoom_around).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()

    vi.advanceTimersByTime(WHEEL_SETTLE_MS)
    // Exactly one recompute, for the final accumulated viewport.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(afterSecond)
  })

  it('anchors every notch to the untransformed layout box, not the live transformed rect', () => {
    // Regression: getBoundingClientRect reflects the live CSS transform, so
    // after the first notch scales the canvas a re-read returns a
    // scaled/translated box. The controller must keep using the box it
    // captured at scrub start, or the cursor anchor drifts off the pointer.
    const afterFirst = makeZoomResult(1.25)
    const afterSecond = makeZoomResult(1.5625)
    viewport.zoom_around.mockReturnValue(afterFirst)
    afterFirst.zoom_around.mockReturnValue(afterSecond)

    const layout = {
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
    // What getBoundingClientRect would report once the canvas is scaled up
    // and translated by the Preview — left/width shifted and enlarged.
    const transformed = { ...layout, left: -100, width: 1000, right: 900 } as DOMRect
    const rectSpy = vi.spyOn(canvas, 'getBoundingClientRect')
    rectSpy.mockReturnValue(transformed)
    rectSpy.mockReturnValueOnce(layout) // only the scrub-start read sees the true box
    mount(canvas, viewport, onChange)

    const notch = (): void => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -100,
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    notch()
    notch()
    // factor = 1.25 ^ (100/100) = 1.25 (zoom in). Both notches map the
    // cursor through the layout box: pixelX = 200·800/800 = 200. The
    // transformed box would have given (200−(−100))·800/1000 = 240.
    expect(viewport.zoom_around).toHaveBeenCalledWith(200, 150, 1.25)
    expect(afterFirst.zoom_around).toHaveBeenCalledWith(200, 150, 1.25)
  })

  it('re-bases the Preview to the committed viewport once a paint clears the transform', () => {
    const committed = makeZoomResult(0.8)
    const next = makeZoomResult(0.64)
    viewport.zoom_around.mockReturnValue(committed)
    committed.zoom_around.mockReturnValue(next)
    mount(canvas, viewport, onChange)

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    vi.advanceTimersByTime(WHEEL_SETTLE_MS) // Settle commits `committed`
    // Simulate render-client's paint clearing the Preview transform: the
    // buffer now matches `committed`.
    canvas.style.transform = ''

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    // The new scrub zooms from the committed viewport, not the original.
    expect(committed.zoom_around).toHaveBeenCalledTimes(1)
    expect(viewport.zoom_around).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(WHEEL_SETTLE_MS)
    expect(onChange).toHaveBeenLastCalledWith(next)
  })

  it('a pan starting mid-zoom carries the zoom into the pan without an extra render', () => {
    const zoomed = makeZoomResult(0.8)
    viewport.zoom_around.mockReturnValue(zoomed)
    const panned = { sentinel: 'panned' } as unknown as Viewport
    zoomed.pan_by_pixels.mockReturnValue(panned)
    const onInvalidate = vi.fn()
    mount(canvas, viewport, onChange, onInvalidate)

    // Zoom scrub: Settle pending, currentViewport advanced to `zoomed`.
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(onChange).not.toHaveBeenCalled()

    // Pan starts before the Settle fires: no render is issued here (firing the
    // zoom's Settle would paint an intermediate frame mid-drag). The mousedown
    // no longer discards in-flight work — that is deferred to the first real
    // mousemove (B3, #74) — so the count still reflects only the wheel notch's
    // own discard (B2).
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    expect(onChange).not.toHaveBeenCalled()
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    // The cancelled Settle can't fire later either.
    vi.advanceTimersByTime(WHEEL_SETTLE_MS)
    expect(onChange).not.toHaveBeenCalled()

    // The drag actually begins: the first mousemove discards any in-flight
    // render so it can't clobber the pan snapshot (bringing the total to two).
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 115, clientY: 60, bubbles: true }),
    )
    expect(onInvalidate).toHaveBeenCalledTimes(2)
    expect(onChange).not.toHaveBeenCalled()

    // Mouseup issues the single render: the zoomed viewport, panned. The pan
    // operates on the accumulated zoom carried in `currentViewport`.
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 130, clientY: 70, bubbles: true }))
    expect(zoomed.pan_by_pixels).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(panned)
  })

  it('discards in-flight renders on every notch, the first included (B2)', () => {
    // A paint landing mid-scrub clears the Preview transform and snaps the
    // image to an older viewport (e.g. a premature Settle's render returning
    // after the scrub resumes). The controller signals the render pipeline to
    // drop any in-flight render on every notch. The first notch must discard
    // too: a render in flight when the scrub begins (a pan commit, resize, or
    // slider at deep zoom) would otherwise paint after notch 1 applied its
    // transform, clear it, and desync the rest of the scrub. Gating the
    // discard on an already-applied transform left that first notch exposed.
    const onInvalidate = vi.fn()
    const z1 = makeZoomResult(0.8)
    const z2 = makeZoomResult(0.64)
    viewport.zoom_around.mockReturnValue(z1)
    z1.zoom_around.mockReturnValue(z2)
    mount(canvas, viewport, onChange, onInvalidate)

    const notch = (): void => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -100,
          clientX: 200,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    notch() // first notch, transform still '' → must still discard
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    notch() // Preview now active → discard again
    expect(onInvalidate).toHaveBeenCalledTimes(2)
  })

  it('clears the zoom Preview transform when a pan starts (pan reads an untransformed box)', () => {
    const z1 = makeZoomResult(1.25)
    viewport.zoom_around.mockReturnValue(z1)
    viewport.pan_by_pixels.mockReturnValue({} as unknown as Viewport)
    mount(canvas, viewport, onChange)

    // Active zoom Preview (transform applied), Settle still pending.
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(canvas.style.transform).not.toBe('')

    // A pan starting before the fresh frame paints must clear the transform,
    // or the pan delta on mouseup would be scaled by the live transform.
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 50, bubbles: true }))
    expect(canvas.style.transform).toBe('')
  })

  it('wheel respects canvas-CSS-vs-internal scaling', () => {
    viewport.zoom_around.mockReturnValue(makeZoomResult(1))
    // Canvas is 800x600 internally but displayed at half size.
    setRect(canvas, { left: 0, top: 0, width: 400, height: 300 })
    mount(canvas, viewport, onChange)

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
    viewport.zoom_around.mockReturnValue(makeZoomResult(1))
    mount(canvas, viewport, onChange)

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
    viewport.zoom_around.mockReturnValue(makeZoomResult(1))
    mount(canvas, viewport, onChange)

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

  it('ignores non-primary mouse buttons on mousedown', () => {
    mount(canvas, viewport, onChange)

    // Right-click (button 2) and middle-click (button 1) should not
    // start a drag. No snapshot, no class toggle, no document
    // listeners (so a later mousemove/mouseup is also a no-op).
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 2, clientX: 50, clientY: 50, bubbles: true }),
    )
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 1, clientX: 50, clientY: 50, bubbles: true }),
    )
    expect(ctxStub.getImageData).not.toHaveBeenCalled()
    expect(canvas.classList.contains('dragging')).toBe(false)

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 70, bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 70, bubbles: true }))
    expect(viewport.pan_by_pixels).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('bails out cleanly when the canvas rect is 0×0 (display:none, detached)', () => {
    // A degenerate rect (display:none, detached element, etc.) would
    // otherwise divide by zero — producing NaN/Infinity which would
    // throw at the WASM finite-input seam. The guard turns this into
    // a no-op without crashing.
    setRect(canvas, { width: 0, height: 0 })
    mount(canvas, viewport, onChange)

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

  it('a non-gesture store write redirects subsequent wheel events to the new viewport without firing onChange', () => {
    const next = makeViewportDouble()
    next.zoom_around.mockReturnValue(makeZoomResult(0.8))
    viewport.zoom_around.mockReturnValue(makeZoomResult(0.8))
    const { store } = mount(canvas, viewport, onChange)

    store.set(next as unknown as Viewport, 'refit')
    // The controller's subscription to non-gesture writes is side-effect-free
    // toward `onChange` — main.ts owns the render via a separate store
    // subscription, so the controller must not also emit a commit here or the
    // frame would render twice.
    expect(onChange).not.toHaveBeenCalled()

    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 100,
        clientY: 50,
        bubbles: true,
        cancelable: true,
      }),
    )
    // The scrub zooms from the redirected viewport; the recompute lands
    // at the Settle.
    expect(next.zoom_around).toHaveBeenCalledTimes(1)
    expect(viewport.zoom_around).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WHEEL_SETTLE_MS)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('a non-gesture store write clears an active Preview transform so the next scrub measures an untransformed box', () => {
    const z1 = makeZoomResult(0.8)
    viewport.zoom_around.mockReturnValue(z1)
    const { store } = mount(canvas, viewport, onChange)

    // Active zoom Preview transform on the canvas.
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        clientX: 200,
        clientY: 150,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(canvas.style.transform).not.toBe('')

    // An external viewport change (resize / mode switch) arriving while the
    // Preview is still on screen must tear down the transform too — leaving
    // it would make the next wheel event capture a transformed rect.
    const next = makeViewportDouble()
    store.set(next as unknown as Viewport, 'refit')
    expect(canvas.style.transform).toBe('')
  })

  it('wheel calls preventDefault', () => {
    viewport.zoom_around.mockReturnValue(makeZoomResult(1))
    mount(canvas, viewport, onChange)

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
