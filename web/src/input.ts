import type { Viewport } from '../wasm/fractal_wasm.js'
import type { ViewportStore } from './viewport-store.js'
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

// A mouseup whose total drag is below this many internal (post CSS→internal
// scaling) pixels on both axes is treated as a click, not a pan: the commit is
// skipped so a plain click — e.g. the drawer's light-dismiss click — never
// restarts an in-flight deep render with an identical, no-op viewport (B3,
// #74). A sub-pixel pan is visually a no-op anyway (the image can't shift by
// less than a pixel), so suppressing it costs nothing.
export const PAN_DEADZONE_PX = 0.5

/**
 * Wires pointer events on a canvas into pan/zoom calls on a viewport.
 *
 * The controller is deliberately presentation-free: it never calls
 * `render` directly, only writes committed viewports into the shared
 * `ViewportStore` (A2, #85), whose subscribers trigger the render. Slice 6
 * swaps the dispatch target from "render synchronously" to "post to Worker"
 * without touching this file.
 *
 * ## Viewport ownership
 *
 * The authoritative viewport lives in the `ViewportStore`. The controller
 * reads it at gesture start and writes the result back with source
 * `'gesture'` on commit (pan mouseup, wheel Settle). It also subscribes to
 * the store: any write from *another* source (a refit, a mode-reset, a
 * future URL hydrator) refreshes its working copy and tears down a live
 * wheel Preview — the second job the old `setViewport` method carried.
 *
 * During an active wheel scrub the controller's working `currentViewport`
 * runs *ahead* of the store: per ADR-0012 each notch advances the Preview
 * without a recompute, so the store is not written until the Settle. A pan
 * begun mid-scrub therefore reads the accumulated zoom from `currentViewport`
 * (not the store) and carries it into the pan with no extra render.
 *
 * ## Drag semantics
 *
 * On mousedown the controller snapshots the canvas into a cached
 * offscreen canvas via `drawImage` (a GPU-path blit, not a CPU pixel
 * readback). Each mousemove blits that snapshot back into the canvas
 * buffer at the current drag offset, again via `drawImage` — no
 * recompute, just a shift of an already-rendered image. `drawImage`
 * stays on the GPU and is ~an order of magnitude cheaper than the
 * `putImageData` it replaced (#82), which wrote the full ~10 MB pixel
 * buffer on the main thread every mousemove. The canvas DOM element
 * itself never moves. On mouseup, one `pan_by_pixels` call produces
 * the final viewport and one `onChange` call hands it off.
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
 * Settle window tears the Preview down without rendering: the accumulated
 * zoom rides in the pan's start viewport, so the pan's mouseup issues a
 * single render rather than the zoom and the pan each issuing one.
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
  // Reusable offscreen canvas holding the drag snapshot. Cached across
  // gestures so a pan never allocates a fresh buffer; `captureSnapshot`
  // only resizes it when the render buffer's dimensions change.
  private snapshotCanvas: HTMLCanvasElement | null = null

  // Blit the current canvas into the cached offscreen buffer and return
  // it, sizing the buffer to match. Returns null if the offscreen 2D
  // context is unavailable (mousedown then bails, as it does for a null
  // main context). The full-surface `drawImage` at (0,0) overwrites the
  // whole buffer, so no clear is needed even when the buffer is reused.
  private captureSnapshot(): HTMLCanvasElement | null {
    const off = this.snapshotCanvas ?? document.createElement('canvas')
    this.snapshotCanvas = off
    if (off.width !== this.canvas.width) off.width = this.canvas.width
    if (off.height !== this.canvas.height) off.height = this.canvas.height
    const offCtx = off.getContext('2d')
    if (offCtx === null) return null
    offCtx.drawImage(this.canvas, 0, 0)
    return off
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    // Only the primary (left) button starts a pan. Right- and
    // middle-click belong to the browser (context menu, paste); they
    // would otherwise leave the controller in a stuck drag state
    // because the matching `mouseup` may never reach us — e.g. the
    // context menu swallows it.
    if (event.button !== 0) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    // A pan starting mid-zoom tears the Preview down *without* rendering: the
    // accumulated zoom already rides in `currentViewport` (the start viewport
    // below), so firing the zoom's Settle here would only dispatch an
    // intermediate frame that paints mid-drag and clobbers the pan snapshot.
    // The pan's mouseup issues the single render. Clearing the transform also
    // means the snapshot/measurement below read an untransformed canvas (a
    // live transform would scale the pan delta).
    this.clearZoomPreview()
    const snapshot = this.captureSnapshot()
    if (snapshot === null) return
    // Do NOT discard in-flight work here. A plain click (mousedown + mouseup
    // with no move — e.g. the drawer's light-dismiss click) must leave an
    // in-flight deep render untouched. The discard is deferred to the first
    // real `mousemove`, when an actual drag begins (B3, #74); `invalidated`
    // tracks whether it has fired yet for this drag.
    this.dragState = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      snapshot,
      invalidated: false,
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

    // First real movement of this drag: now discard any in-flight render so it
    // can't paint over the drag preview (ADR-0012 boundary rule). Deferred from
    // mousedown so a plain click never throws away in-flight work (B3, #74).
    if (!this.dragState.invalidated) {
      this.onInvalidate()
      this.dragState.invalidated = true
    }

    const dxCss = event.clientX - this.dragState.startClientX
    const dyCss = event.clientY - this.dragState.startClientY
    const dxInternal = (dxCss * this.canvas.width) / rect.width
    const dyInternal = (dyCss * this.canvas.height) / rect.height

    // Fill black for the edges exposed by the drag — this matches the
    // Mandelbrot "outside the set" colour, so the strips look like
    // part of the fractal rather than blank canvas. `drawImage` of the
    // opaque snapshot fully covers the centre, so the black only shows
    // through at the shifted-in edges.
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(this.dragState.snapshot, dxInternal, dyInternal)
  }

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (this.dragState === null) return
    const { startClientX, startClientY } = this.dragState

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
    // Pan from `currentViewport`, not the drag-start snapshot. They are
    // the same object for a drag with no concurrent resize, but a debounced
    // `refitToCanvas` (ResizeObserver) can fire mid-drag and `set` a viewport
    // at new dimensions — which our store subscription has already mirrored
    // into `currentViewport`. `with_resolution` preserves center and zoom, so
    // `currentViewport` still depicts the same framing the dragged snapshot
    // shows — only its width/height are refreshed to the live box. Panning
    // from the stale snapshot instead would commit its old dimensions,
    // reverting the refit: the buffer would be computed for the old size and
    // CSS-stretched onto the new box (non-square pixels), and since the box
    // hasn't changed again the ResizeObserver never re-fires to correct it.
    // (With the store as the single owner this B1 desync is now structurally
    // hard to reintroduce: gestures always read live state.)
    //
    // The deltas scale by the viewport's logical grid (not the render
    // buffer) so a pan moves the same complex-plane distance regardless
    // of render scale — and by the *live* dimensions, matching the
    // post-resize `rect`.
    const base = this.currentViewport
    const dxInternal = (dxCss * base.width()) / rect.width
    const dyInternal = (dyCss * base.height()) / rect.height

    // A click (or sub-pixel drag) commits nothing: the viewport is unchanged,
    // no mousemove repainted the canvas, and `onChange` would only restart an
    // identical render — the exact waste B3 (#74) describes. Bail before the
    // commit. (Cleanup above already ran, so the drag is fully torn down.)
    if (Math.abs(dxInternal) < PAN_DEADZONE_PX && Math.abs(dyInternal) < PAN_DEADZONE_PX) {
      return
    }

    const next = base.pan_by_pixels(dxInternal, dyInternal)
    this.currentViewport = next
    this.store.set(next, 'gesture')
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // A Preview transform is already applied (a scrub is visually active)
    // exactly when the canvas transform is non-empty. This gates only whether
    // the Preview re-bases below — it no longer gates the in-flight discard.
    const previewActive = this.canvas.style.transform !== ''
    // Discard any in-flight render on *every* notch, the first included. A
    // render already in flight when the scrub begins — a pan commit, a resize
    // refit, or a slider change, all slowest exactly at deep zoom / high
    // iterations — would otherwise paint mid-gesture, and `render-client`'s
    // `paint` clears the Preview transform in the same tick: the image snaps
    // back to that older viewport, and the next notch (seeing no transform)
    // re-bases the Preview a notch behind, so the rest of the scrub previews
    // at the wrong scale until a second jump at Settle. Gating this on
    // `previewActive` left the *first* notch exposed — nothing guarantees the
    // base frame painted before it. The Settle re-renders the accumulated
    // viewport regardless, so dropping the base frame costs nothing (ADR-0012).
    this.onInvalidate()
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
   * Commit the accumulated wheel zoom: `set` the store once (source
   * `'gesture'`) for the final viewport, which triggers the recompute. The
   * fresh frame's paint clears the Preview transform (`render-client`), so
   * `zoomPreview` is intentionally kept here — a notch arriving before that
   * paint continues the same matrix. The store subscription skips this
   * `'gesture'` write, so it does not tear the kept Preview down.
   */
  private readonly settleZoom = (): void => {
    this.settleTimer = undefined
    if (this.zoomPreview === null) return
    this.store.set(this.zoomPreview.viewport, 'gesture')
  }

  /**
   * Tear down any wheel Preview: cancel a pending Settle, drop the
   * accumulator and cached rect, and clear the CSS transform. Writes **no**
   * store update — the accumulated zoom already rides in `currentViewport`
   * (advanced per notch), so a caller (a starting pan, or an external
   * store write) carries it forward without an extra render. Clearing the
   * transform also lets a starting pan read an untransformed
   * `getBoundingClientRect` (a live transform would scale the pan delta).
   */
  private clearZoomPreview(): void {
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    this.zoomPreview = null
    this.scrubRect = null
    if (this.canvas.style.transform !== '') {
      this.canvas.style.transform = ''
    }
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: ViewportStore,
    // Called while a wheel Preview is active to discard any in-flight
    // render so it can't paint stale pixels mid-scrub (ADR-0012). Injected
    // (rather than importing the render client) to keep this controller
    // presentation-free. Defaults to a no-op for tests that don't wire it.
    private readonly onInvalidate: () => void = () => {},
  ) {
    this.currentViewport = store.get()
    // Any viewport write the controller did *not* author (a refit, a
    // mode-reset, a future URL hydrator) supersedes whatever the controller
    // holds and any in-progress wheel scrub: mirror the new viewport into the
    // working copy and tear down a live Preview — including its CSS transform,
    // so the next scrub measures an untransformed canvas rather than the
    // still-scaled box (a wheel event landing before the writer's render
    // paints would otherwise anchor the new zoom to the wrong box). Self
    // (`'gesture'`) writes are skipped: `currentViewport` already holds them,
    // and the Settle deliberately keeps its Preview alive across the commit.
    store.subscribe((viewport, source) => {
      if (source === 'gesture') return
      this.clearZoomPreview()
      this.currentViewport = viewport
    })
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
  // The drag snapshot, held as an offscreen canvas so each mousemove can
  // re-blit it with `drawImage` (GPU path) rather than `putImageData` (#82).
  readonly snapshot: HTMLCanvasElement
  // Whether the deferred in-flight-render discard has fired for this drag.
  // Starts false on mousedown; set true on the first real mousemove so the
  // discard runs once, when an actual drag begins (B3, #74).
  invalidated: boolean
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
