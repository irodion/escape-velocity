import type { Viewport } from '../wasm/fractal_wasm.js'

/**
 * Wires pointer events on a canvas into pan/zoom calls on a viewport.
 *
 * The controller is deliberately presentation-free: it never calls
 * `render` directly, only emits viewport changes through the
 * `onChange` callback. Slice 6 swaps the dispatch target from
 * "render synchronously" to "post to Worker" without touching this
 * file.
 *
 * ## Drag semantics
 *
 * On mousedown the controller snapshots the canvas pixels via
 * `getImageData`. Each mousemove paints that snapshot back into the
 * canvas buffer at the current drag offset — no recompute, just a
 * shift of an already-rendered image. The canvas DOM element itself
 * never moves. On mouseup, one `pan_by_pixels` call produces the
 * final viewport and one `onChange` call hands it off. CSS pixels
 * (from `clientX`/`clientY`) are scaled to canvas-internal pixels
 * using `canvas.width / boundingRect.width` so a future
 * devicePixelRatio change does not need to retrofit the math.
 *
 * Earlier revisions used `canvas.style.transform = translate(...)`
 * for drag feedback. That approach was visually broken on mouseup:
 * the canvas element snapped from its dragged CSS position back to
 * the origin even though the rendered content was mathematically
 * continuous, so the user perceived a rectangle-jump. Shifting the
 * image inside the buffer keeps the canvas element stationary, so
 * only the content moves — same as a native pan.
 *
 * The pan sign matches `fractal_core::Viewport::pan_by_pixels`:
 * dragging the canvas right by `dx` CSS pixels corresponds to the
 * image shifting right by `dx_internal` pixels, which is exactly
 * `pan_by_pixels(+dx_internal, +dy_internal)`. (This deviates from
 * the literal `-dx_internal, -dy_internal` written in issue #9 — that
 * spec assumed the opposite convention from what Slice 2A landed.
 * The Slice 2A `pan_by_pixels` doc-comment and tests are the
 * authoritative source.)
 *
 * ## Wheel semantics
 *
 * `factor = 1.25 ^ (-deltaY / 100)` — a continuous exponential so
 * trackpads (many small deltas) and discrete wheel notches (one
 * `±100` per click) both feel right. The cursor position is mapped
 * through the same CSS→internal scaling and handed to
 * `zoom_around`, which keeps the complex-plane point under the
 * cursor invariant across the step.
 */
export class InputController {
  private currentViewport: Viewport
  private dragState: DragState | null = null

  private readonly handleMouseDown = (event: MouseEvent): void => {
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    this.dragState = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: this.currentViewport,
      snapshot: ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
    }
    this.canvas.classList.add('dragging')
    document.addEventListener('mousemove', this.handleMouseMove)
    document.addEventListener('mouseup', this.handleMouseUp)
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (this.dragState === null) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return

    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dxCss = event.clientX - this.dragState.startClientX
    const dyCss = event.clientY - this.dragState.startClientY
    const dxInternal = (dxCss * this.canvas.width) / rect.width
    const dyInternal = (dyCss * this.canvas.height) / rect.height

    // Fill black for the edges exposed by the drag — this matches the
    // Mandelbrot "outside the set" colour, so the strips look like
    // part of the fractal rather than blank canvas. `putImageData`
    // overwrites pixels (it doesn't blend), so the snapshot fully
    // covers the centre.
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.putImageData(this.dragState.snapshot, dxInternal, dyInternal)
  }

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (this.dragState === null) return
    const { startClientX, startClientY, startViewport } = this.dragState

    this.dragState = null
    this.canvas.classList.remove('dragging')
    document.removeEventListener('mousemove', this.handleMouseMove)
    document.removeEventListener('mouseup', this.handleMouseUp)

    const rect = this.canvas.getBoundingClientRect()
    // Cleanup above runs unconditionally; only the viewport update is
    // skipped when the canvas is degenerate (e.g. display:none or
    // detached). Without this, dxInternal/dyInternal would be
    // NaN/Infinity and the WASM seam would throw on the finite-input
    // check.
    if (rect.width <= 0 || rect.height <= 0) return
    const dxCss = event.clientX - startClientX
    const dyCss = event.clientY - startClientY
    const dxInternal = (dxCss * this.canvas.width) / rect.width
    const dyInternal = (dyCss * this.canvas.height) / rect.height

    const next = startViewport.pan_by_pixels(dxInternal, dyInternal)
    this.currentViewport = next
    this.onChange(next)
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const cssX = event.clientX - rect.left
    const cssY = event.clientY - rect.top
    const pixelX = (cssX * this.canvas.width) / rect.width
    const pixelY = (cssY * this.canvas.height) / rect.height
    const factor = 1.25 ** (-normalizeWheelDelta(event) / 100)

    const next = this.currentViewport.zoom_around(pixelX, pixelY, factor)
    this.currentViewport = next
    this.onChange(next)
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initialViewport: Viewport,
    private readonly onChange: (viewport: Viewport) => void,
  ) {
    this.currentViewport = initialViewport
    canvas.addEventListener('mousedown', this.handleMouseDown)
    // `passive: false` is required for `preventDefault()` to take
    // effect on wheel — modern browsers default wheel listeners to
    // passive, which silently no-ops `preventDefault`.
    canvas.addEventListener('wheel', this.handleWheel, { passive: false })
  }
}

interface DragState {
  readonly startClientX: number
  readonly startClientY: number
  readonly startViewport: Viewport
  readonly snapshot: ImageData
}

// Convert a WheelEvent's deltaY into a pixel-equivalent value so the
// zoom factor stays consistent across input devices. `deltaMode` is 0
// (pixel) on every modern trackpad and most mouse-wheel setups, but
// Firefox-on-Linux historically reports 1 (line) with deltaY ≈ ±3 per
// notch, and some assistive devices report 2 (page). Without
// normalization, a line-mode notch would compute factor ≈ 0.993 — a
// near-no-op zoom.
//
// The constants target ~100 normalized pixels per physical wheel
// notch: 3 lines × 40 px ≈ 120; 1 page × 800 px ≈ 800 (a single page-
// mode notch is a large zoom step, which matches user expectation for
// that mode).
function normalizeWheelDelta(event: WheelEvent): number {
  switch (event.deltaMode) {
    case 1:
      return event.deltaY * 40
    case 2:
      return event.deltaY * 800
    default:
      return event.deltaY
  }
}
