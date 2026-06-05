import type { Viewport } from '../wasm/fractal_wasm.js'
import {
  applyZoomNotch,
  beginZoomPreview,
  type ZoomPreview,
  zoomPreviewTransform,
} from './zoom-preview.js'

// A wheel scrub fires no recompute until input goes quiet for this long;
// the Settle then commits one render for the accumulated viewport. ~150ms
// matches `RESIZE_DEBOUNCE_MS` in main.ts and reads as "instant" while
// still collapsing a fast scrub into a single compute (ADR-0012).
export const WHEEL_SETTLE_MS = 150

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
 * final viewport and one `onChange` call hands it off.
 *
 * ## Two pixel spaces
 *
 * The render buffer can be larger or smaller than the viewport's
 * logical (display) grid — the render-scale multiplier supersamples or
 * subsamples it (Slice 3). So CSS deltas map into two different spaces:
 *
 *  - The **drag preview** shifts the buffer-sized snapshot, so it scales
 *    CSS → buffer pixels using `canvas.width / boundingRect.width`.
 *  - **pan/zoom** operate on the viewport, whose dimensions are the
 *    logical grid, so they scale CSS → logical pixels using
 *    `viewport.width() / boundingRect.width`.
 *
 * When render scale is 1 (buffer == logical) the two ratios coincide,
 * which is the only case the original code had to handle.
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
 * through the same CSS→internal scaling and handed to `zoom_around`,
 * which keeps the complex-plane point under the cursor invariant.
 *
 * Wheel zoom mirrors pan's "respond now, compute once at the end"
 * shape (ADR-0012). A scrub shows an instant **Preview** — the on-screen
 * frame CSS-scaled under the cursor via `canvas.style.transform`, zero
 * compute — accumulated across notches by the `zoom-preview` module.
 * No `onChange` fires during the scrub; the single recompute is deferred
 * to a **Settle** `WHEEL_SETTLE_MS` after the wheel goes quiet. The fresh
 * frame replaces the Preview when it paints — `render-client`'s `paint`
 * clears the transform in the same tick, an atomic swap (so this file
 * never clears it). A new gesture (a pan `mousedown`) inside the pending
 * Settle window commits the zoom immediately so pan never double-renders.
 */
export class InputController {
  private currentViewport: Viewport
  private dragState: DragState | null = null
  // The in-progress wheel Preview, or null when no scrub has started. It
  // survives a Settle so a follow-up notch landing before the fresh frame
  // paints continues the same matrix; it re-bases to identity once the
  // paint has cleared the canvas transform (see `handleWheel`).
  private zoomPreview: ZoomPreview | null = null
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  // The canvas's *untransformed* layout box, captured at the start of a
  // scrub. `getBoundingClientRect` reflects the live CSS transform, so
  // once the Preview has scaled the canvas, re-reading it would feed
  // drifting, scaled cursor coordinates into the zoom — see `handleWheel`.
  private scrubRect: DOMRect | null = null

  private readonly handleMouseDown = (event: MouseEvent): void => {
    // Only the primary (left) button starts a pan. Right- and
    // middle-click belong to the browser (context menu, paste); they
    // would otherwise leave the controller in a stuck drag state
    // because the matching `mouseup` may never reach us — e.g. the
    // context menu swallows it.
    if (event.button !== 0) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    // A pan starting inside a pending zoom Settle commits the zoom now, so
    // the deferred Settle can't fire later and clobber the pan's viewport
    // (ADR-0012 boundary rule). The committed viewport is already exact.
    this.commitPendingZoom()
    // Drop any active Preview transform before snapshotting/measuring: a
    // live transform skews `getBoundingClientRect`, which would scale the
    // pan delta computed on mouseup (not just the preview). Pan operates on
    // an untransformed canvas.
    this.clearZoomPreview()
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
    // Pan operates on the viewport's logical grid, not the render
    // buffer — scale CSS deltas by the viewport dimensions so a pan
    // moves the same complex-plane distance regardless of render scale.
    const dxInternal = (dxCss * startViewport.width()) / rect.width
    const dyInternal = (dyCss * startViewport.height()) / rect.height

    const next = startViewport.pan_by_pixels(dxInternal, dyInternal)
    this.currentViewport = next
    this.onChange(next)
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // A Preview transform is already applied (a scrub is visually active)
    // exactly when the canvas transform is non-empty. In that state a paint
    // would clear the transform mid-gesture and snap the image to an older
    // viewport — most visibly when a premature Settle's render returns after
    // the scrub resumes. Discard any in-flight render so it can't paint
    // stale pixels under us; the final Settle issues the authoritative one
    // (ADR-0012). On the first notch of a scrub the transform is still
    // cleared, so the base frame is left to paint normally.
    const previewActive = this.canvas.style.transform !== ''
    if (previewActive) {
      this.onInvalidate()
    }
    // Begin a fresh Preview when no scrub is active, or when a paint has
    // cleared the transform (the buffer now matches `currentViewport`, so
    // the Preview re-bases to identity). Mid-scrub, continue the existing
    // matrix so it stays relative to the frame still on screen. The same
    // condition gates capturing the layout box: take it once at the start
    // of a scrub, while the transform is still cleared so the rect is
    // untransformed, then reuse it for every notch — this pins the cursor
    // anchor to the pointer. A mid-scrub `getBoundingClientRect` would
    // return the already-scaled box and the anchor would creep away (the
    // "shifted zoom centre" bug).
    let preview = this.zoomPreview
    if (preview === null || !previewActive) {
      this.scrubRect = this.canvas.getBoundingClientRect()
      preview = beginZoomPreview(this.currentViewport)
    }
    const rect = this.scrubRect
    if (rect === null || rect.width <= 0 || rect.height <= 0) return
    const cssX = event.clientX - rect.left
    const cssY = event.clientY - rect.top
    // zoom_around takes a point on the viewport's logical grid — scale
    // by the viewport dimensions, not the render buffer, so the cursor-
    // invariant point is correct at any render scale. The CSS-pixel
    // (cssX, cssY) anchors the Preview transform; they scale by the same
    // ratio, so both hold the same on-screen point fixed.
    const pixelX = (cssX * this.currentViewport.width()) / rect.width
    const pixelY = (cssY * this.currentViewport.height()) / rect.height
    const factor = 1.25 ** (-normalizeWheelDelta(event) / 100)

    this.zoomPreview = applyZoomNotch(preview, pixelX, pixelY, cssX, cssY, factor)
    this.currentViewport = this.zoomPreview.viewport
    this.canvas.style.transform = zoomPreviewTransform(this.zoomPreview)

    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
    }
    this.settleTimer = setTimeout(this.settleZoom, WHEEL_SETTLE_MS)
  }

  /**
   * Commit the accumulated wheel zoom: fire one `onChange` for the final
   * viewport. The fresh frame's paint clears the Preview transform
   * (`render-client`), so `zoomPreview` is intentionally kept here — a
   * notch arriving before that paint continues the same matrix.
   */
  private readonly settleZoom = (): void => {
    this.settleTimer = undefined
    if (this.zoomPreview === null) return
    this.onChange(this.zoomPreview.viewport)
  }

  /** Flush a pending Settle immediately (a new gesture is starting). */
  private commitPendingZoom(): void {
    if (this.settleTimer === undefined) return
    clearTimeout(this.settleTimer)
    this.settleZoom()
  }

  /**
   * Drop any active wheel Preview and clear its CSS transform. The
   * committed viewport is unchanged (it was advanced per notch); this only
   * tears down the visual Preview so a starting pan reads an untransformed
   * canvas. The eventual in-flight Settle render is superseded by the pan's
   * own `onChange` via the render epoch.
   */
  private clearZoomPreview(): void {
    this.zoomPreview = null
    this.scrubRect = null
    if (this.canvas.style.transform !== '') {
      this.canvas.style.transform = ''
    }
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initialViewport: Viewport,
    private readonly onChange: (viewport: Viewport) => void,
    // Called while a wheel Preview is active to discard any in-flight
    // render so it can't paint stale pixels mid-scrub (ADR-0012). Injected
    // (rather than importing the render client) to keep this controller
    // presentation-free. Defaults to a no-op for tests that don't wire it.
    private readonly onInvalidate: () => void = () => {},
  ) {
    this.currentViewport = initialViewport
    canvas.addEventListener('mousedown', this.handleMouseDown)
    // `passive: false` is required for `preventDefault()` to take
    // effect on wheel — modern browsers default wheel listeners to
    // passive, which silently no-ops `preventDefault`.
    canvas.addEventListener('wheel', this.handleWheel, { passive: false })
  }

  /**
   * Overwrite the controller's viewport. The next pan/zoom event will
   * derive its result from this viewport instead of the previous one.
   *
   * Slice 3 calls this after a resolution change so the controller
   * sees the resized viewport without rebuilding listener wiring. No
   * `onChange` fires — the caller already has the new viewport in
   * hand and is responsible for triggering the render.
   *
   * An external viewport supersedes any in-progress wheel scrub: a
   * pending Settle is cancelled and the Preview dropped, so the deferred
   * `onChange` can't later fire with a stale viewport. The caller's own
   * render repaints and clears the transform.
   */
  setViewport(viewport: Viewport): void {
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    this.zoomPreview = null
    this.currentViewport = viewport
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
