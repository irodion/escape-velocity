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
 * Drag during mousemove uses a CSS `translate` on the canvas — no
 * re-render, just visual feedback. On mouseup, one `pan_by_pixels`
 * call produces the final viewport and one `onChange` call hands it
 * off. CSS pixels (from `clientX`/`clientY`) are scaled to canvas-
 * internal pixels using `canvas.width / boundingRect.width` so a
 * future devicePixelRatio change does not need to retrofit the math.
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
    this.dragState = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: this.currentViewport,
    }
    this.canvas.classList.add('dragging')
    document.addEventListener('mousemove', this.handleMouseMove)
    document.addEventListener('mouseup', this.handleMouseUp)
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (this.dragState === null) return
    const dx = event.clientX - this.dragState.startClientX
    const dy = event.clientY - this.dragState.startClientY
    this.canvas.style.transform = `translate(${dx}px, ${dy}px)`
  }

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (this.dragState === null) return
    const { startClientX, startClientY, startViewport } = this.dragState

    this.dragState = null
    this.canvas.style.transform = ''
    this.canvas.classList.remove('dragging')
    document.removeEventListener('mousemove', this.handleMouseMove)
    document.removeEventListener('mouseup', this.handleMouseUp)

    const rect = this.canvas.getBoundingClientRect()
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
    const cssX = event.clientX - rect.left
    const cssY = event.clientY - rect.top
    const pixelX = (cssX * this.canvas.width) / rect.width
    const pixelY = (cssY * this.canvas.height) / rect.height
    const factor = 1.25 ** (-event.deltaY / 100)

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
}
