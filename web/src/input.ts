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

// A pointerup whose total drag is below this many internal (post CSS→internal
// scaling) pixels on both axes is treated as a click/tap, not a pan: the commit
// is skipped so a plain click — e.g. the drawer's light-dismiss click — never
// restarts an in-flight deep render with an identical, no-op viewport (B3,
// #74). A sub-pixel pan is visually a no-op anyway (the image can't shift by
// less than a pixel), so suppressing it costs nothing.
export const PAN_DEADZONE_PX = 0.5

/**
 * Wires pointer events on a canvas into pan/zoom calls on a viewport.
 *
 * The controller speaks **Pointer Events** (`pointerdown/move/up/cancel`), not
 * mouse or touch events, so a single code path unifies mouse, trackpad, pen,
 * and touch (U1, #88): one finger pans, two fingers pinch-zoom, and a plain
 * tap is a click. The legacy `wheel` listener is kept — wheel has no pointer
 * equivalent and remains the desktop zoom (ADR-0012).
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
 * `'gesture'` on commit (pan pointerup, wheel/pinch Settle). It also subscribes
 * to the store: any write from *another* source (a refit, a mode-reset, a
 * future URL hydrator) refreshes its working copy and tears down a live
 * zoom Preview — the second job the old `setViewport` method carried.
 *
 * During an active wheel scrub (or pinch) the controller's working
 * `currentViewport` runs *ahead* of the store: per ADR-0012 each notch advances
 * the Preview without a recompute, so the store is not written until the Settle.
 * A pan begun mid-scrub therefore reads the accumulated zoom from
 * `currentViewport` (not the store) and carries it into the pan with no extra
 * render.
 *
 * ## Pointer capture
 *
 * On `pointerdown` the controller calls `setPointerCapture` so the rest of the
 * gesture (`pointermove`/`pointerup`) routes to the canvas even when a finger
 * or the cursor leaves the canvas box — replacing the old document-level
 * mousemove/mouseup listeners. The call is optional-chained because jsdom (the
 * test DOM) does not implement pointer capture; production browsers all do.
 *
 * ## Drag semantics (one pointer)
 *
 * On the first `pointerdown` the controller snapshots the canvas into a cached
 * offscreen canvas via `drawImage` (a GPU-path blit, not a CPU pixel
 * readback). Each `pointermove` blits that snapshot back into the canvas
 * buffer at the current drag offset, again via `drawImage` — no
 * recompute, just a shift of an already-rendered image. `drawImage`
 * stays on the GPU and is ~an order of magnitude cheaper than the
 * `putImageData` it replaced (#82), which wrote the full ~10 MB pixel
 * buffer on the main thread every move. The canvas DOM element
 * itself never moves. On `pointerup`, one `pan_by_pixels` call produces
 * the final viewport and one store write hands it off.
 *
 * ## Pinch semantics (two pointers)
 *
 * When a second pointer goes down the controller switches from pan to a
 * two-finger pinch (U1, #88). A pinch reuses the wheel-zoom Preview/Settle
 * machinery (ADR-0012): the change in inter-pointer distance between moves is
 * the zoom factor, anchored at the inter-pointer **midpoint**, fed through the
 * same `applyZoomNotch` path the wheel uses. The CSS transform updates live;
 * the store is written once on Settle when a finger lifts (a pinch has explicit
 * brackets like a pan, so it Settles immediately — no debounce timer).
 *
 * A real pinch almost always begins as a one-finger pan for a few milliseconds
 * before the second finger lands, so the pan→pinch transition restores the
 * canvas buffer to the un-panned frame (the pan never committed, so
 * `currentViewport` still depicts it) by re-blitting the snapshot at the
 * origin, then begins the pinch from `currentViewport`. A leftover finger after
 * a pinch ends does *not* resume a pan (that would jump); a new pan begins only
 * on a fresh `pointerdown` once all fingers have lifted.
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
 * for drag feedback. That approach was visually broken on pointerup:
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
 * No store write fires during the scrub; the single recompute is deferred
 * to a **Settle** `WHEEL_SETTLE_MS` after the wheel goes quiet. The fresh
 * frame replaces the Preview when it paints — `render-client`'s `paint`
 * clears the transform in the same tick, an atomic swap (so this file
 * never clears it). A new gesture (a pan `pointerdown`) inside the pending
 * Settle window tears the Preview down without rendering: the accumulated
 * zoom rides in the pan's start viewport, so the pan's pointerup issues a
 * single render rather than the zoom and the pan each issuing one.
 */
export class InputController {
  private currentViewport: Viewport
  private dragState: DragState | null = null
  // Pointers currently down on the canvas, keyed by `pointerId`, holding the
  // live client position of each. One entry → pan; two → pinch. Updated on
  // every pointerdown/move and pruned on pointerup/cancel.
  private activePointers = new Map<number, PointerPosition>()
  // The active two-finger pinch, or null when not pinching. Mutually exclusive
  // with `dragState`. Holds the two pinch pointer ids and the inter-pointer
  // distance from the previous move, so each move's zoom factor is the
  // incremental `distance / lastDistance` (mirroring per-notch wheel zoom).
  private pinch: PinchState | null = null
  // True from when a pinch Settles until the last finger lifts. The Settle
  // intentionally leaves the Preview transform on the canvas until the fresh
  // frame paints (an atomic swap), so a second finger landing on a leftover
  // finger *before* that paint would begin a new pinch that measures a
  // transformed `getBoundingClientRect` and re-bases the Preview to identity
  // over the wrong frame — a desynced zoom anchor. While set, every pointerdown
  // is tracked (so the count still drains) but starts no new gesture.
  private pinchLockout = false
  // The in-progress zoom Preview (wheel scrub or pinch), or null when none is
  // active. It survives a Settle so a follow-up notch landing before the fresh
  // frame paints continues the same matrix; it re-bases to identity once the
  // paint has cleared the canvas transform (see `handleWheel`).
  private zoomPreview: ZoomPreview | null = null
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  // The canvas's *untransformed* layout box, captured at the start of a
  // scrub/pinch. `getBoundingClientRect` reflects the live CSS transform, so
  // once the Preview has scaled the canvas, re-reading it would feed
  // drifting, scaled cursor coordinates into the zoom — see `handleWheel`.
  private scrubRect: DOMRect | null = null
  // Reusable offscreen canvas holding the drag snapshot. Cached across
  // gestures so a pan never allocates a fresh buffer; `captureSnapshot`
  // only resizes it when the render buffer's dimensions change.
  private snapshotCanvas: HTMLCanvasElement | null = null

  // Blit the current canvas into the cached offscreen buffer and return
  // it, sizing the buffer to match. Returns null if the offscreen 2D
  // context is unavailable (pointerdown then bails, as it does for a null
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

  private readonly handlePointerDown = (event: PointerEvent): void => {
    // Only the primary (left) button starts a gesture on the *first* pointer.
    // Right- and middle-click belong to the browser (context menu, paste); they
    // would otherwise leave the controller in a stuck drag state. Touch and pen
    // always report `button === 0` on press, so this only filters mouse. A
    // second pointer (a pinch finger) is admitted unconditionally below.
    if (this.activePointers.size === 0 && event.button !== 0) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return

    this.activePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
    // Route the rest of this pointer's events to the canvas even if it leaves
    // the box. Optional-chained: jsdom has no pointer capture (see class doc).
    this.canvas.setPointerCapture?.(event.pointerId)

    // A finger from the just-Settled pinch is still down (see `pinchLockout`):
    // track this press so the count drains, but start nothing until all lift.
    if (this.pinchLockout) return

    // Second pointer → switch from pan to pinch. Extra (3rd+) pointers are
    // tracked (so counts stay accurate for teardown) but drive nothing.
    if (this.activePointers.size === 2) {
      this.beginPinch()
      return
    }
    if (this.activePointers.size > 2) return

    // First pointer → pan. A pan starting mid-zoom tears the Preview down
    // *without* rendering: the accumulated zoom already rides in
    // `currentViewport` (the start viewport below), so firing the zoom's Settle
    // here would only dispatch an intermediate frame that paints mid-drag and
    // clobbers the pan snapshot. The pan's pointerup issues the single render.
    // Clearing the transform also means the snapshot/measurement below read an
    // untransformed canvas (a live transform would scale the pan delta).
    this.clearZoomPreview()
    const snapshot = this.captureSnapshot()
    if (snapshot === null) return
    // Do NOT discard in-flight work here. A plain tap (pointerdown + pointerup
    // with no move — e.g. the drawer's light-dismiss click) must leave an
    // in-flight deep render untouched. The discard is deferred to the first
    // real `pointermove`, when an actual drag begins (B3, #74); `invalidated`
    // tracks whether it has fired yet for this drag.
    this.dragState = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      snapshot,
      invalidated: false,
    }
    this.canvas.classList.add('dragging')
  }

  // Switch an in-progress (or just-started) pan into a two-finger pinch.
  private beginPinch(): void {
    // A pinch supersedes any in-progress pan. The pan never committed, so
    // `currentViewport` still depicts the un-panned frame — restore the canvas
    // buffer to match by re-blitting the snapshot at the origin, then drop the
    // drag. (If no pointermove painted yet the buffer already matches, so the
    // blit is a harmless no-op.)
    if (this.dragState !== null) {
      const ctx = this.canvas.getContext('2d')
      if (ctx !== null) {
        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        ctx.drawImage(this.dragState.snapshot, 0, 0)
      }
      this.dragState = null
      this.canvas.classList.remove('dragging')
    }
    // Drop any in-flight render so a late frame can't paint mid-pinch and clear
    // the Preview transform out from under the gesture (ADR-0012, as the wheel
    // does per notch).
    this.onInvalidate()
    // Capture the untransformed layout box once, like the wheel scrubRect, so
    // every move maps the midpoint through a stable, unscaled box.
    this.scrubRect = this.canvas.getBoundingClientRect()
    this.zoomPreview = beginZoomPreview(this.currentViewport)
    const [pointerA, pointerB] = [...this.activePointers.keys()]
    this.pinch = {
      pointerA,
      pointerB,
      lastDistance: this.distanceBetween(pointerA, pointerB),
    }
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const tracked = this.activePointers.get(event.pointerId)
    if (tracked === undefined) return
    tracked.clientX = event.clientX
    tracked.clientY = event.clientY

    if (this.pinch !== null) {
      this.updatePinch()
      return
    }
    if (this.dragState !== null) {
      this.updateDrag(event)
    }
  }

  // Paint the drag preview: shift the snapshot inside the buffer by the
  // current drag offset. No recompute — just a blit of an already-rendered
  // image (see class doc, "Drag semantics").
  private updateDrag(event: PointerEvent): void {
    if (this.dragState === null) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return

    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    // First real movement of this drag: now discard any in-flight render so it
    // can't paint over the drag preview (ADR-0012 boundary rule). Deferred from
    // pointerdown so a plain tap never throws away in-flight work (B3, #74).
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

  // Fold one pinch move into the zoom Preview: the change in inter-pointer
  // distance since the last move is the zoom factor, anchored at the current
  // inter-pointer midpoint and fed through the same `applyZoomNotch` path the
  // wheel uses.
  private updatePinch(): void {
    if (this.pinch === null || this.zoomPreview === null) return
    const rect = this.scrubRect
    if (rect === null || rect.width <= 0 || rect.height <= 0) return
    const distance = this.distanceBetween(this.pinch.pointerA, this.pinch.pointerB)
    if (distance <= 0 || this.pinch.lastDistance <= 0) return
    // Drop any in-flight render on every move, mirroring the wheel's per-notch
    // discard so a late frame can't paint mid-pinch and clear the transform.
    this.onInvalidate()
    const factor = distance / this.pinch.lastDistance
    this.pinch.lastDistance = distance

    const [midX, midY] = this.midpointBetween(this.pinch.pointerA, this.pinch.pointerB)
    const cssX = midX - rect.left
    const cssY = midY - rect.top
    // zoom_around takes a point on the viewport's logical grid — scale by the
    // viewport dimensions, not the render buffer, so the anchored point is
    // correct at any render scale. (cssX, cssY) anchors the Preview transform;
    // they scale by the same ratio, so both hold the same on-screen point fixed.
    const pixelX = (cssX * this.currentViewport.width()) / rect.width
    const pixelY = (cssY * this.currentViewport.height()) / rect.height

    this.zoomPreview = applyZoomNotch(this.zoomPreview, pixelX, pixelY, cssX, cssY, factor)
    this.currentViewport = this.zoomPreview.viewport
    this.canvas.style.transform = zoomPreviewTransform(this.zoomPreview)
  }

  // Shared by `pointerup` and `pointercancel`: a cancel tears the gesture down
  // the same way a normal release does (committing what the Preview already
  // showed) so no dangling transform or ahead-of-store viewport is left behind.
  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.activePointers.has(event.pointerId)) return
    this.activePointers.delete(event.pointerId)
    this.canvas.releasePointerCapture?.(event.pointerId)
    // The last finger lifted: release the post-pinch lockout so the next press
    // begins a fresh gesture. (A no-op outside the lockout.) Runs before the
    // branches below; the pinch-Settle case never drains to zero here (it
    // leaves ≥ 1 finger), so it can't clear the lockout it is about to set.
    if (this.activePointers.size === 0) {
      this.pinchLockout = false
    }

    if (this.pinch !== null) {
      // A pinch ends when one of *its two* pointers lifts: Settle the zoom once
      // and tear it down. Checking the pair — not just the total count — is
      // load-bearing. With a third finger also down, the count can stay ≥ 2
      // after a pinch pointer lifts, which would leave `pinch` referencing a
      // removed pointer: `distanceBetween` then returns 0 and every later move
      // is a no-op, freezing the gesture. (The `size < 2` arm is a defensive
      // catch-all for the same end state.) A leftover finger does NOT resume a
      // pan or rebase to a new pinch — a new gesture begins only on a fresh
      // pointerdown once all fingers lift.
      if (
        event.pointerId === this.pinch.pointerA ||
        event.pointerId === this.pinch.pointerB ||
        this.activePointers.size < 2
      ) {
        this.settlePinch()
      }
      return
    }

    if (this.dragState !== null) {
      this.endDrag(event)
    }
  }

  // Commit (or discard, as a click) a one-pointer pan on release.
  private endDrag(event: PointerEvent): void {
    if (this.dragState === null) return
    const { startClientX, startClientY } = this.dragState

    this.dragState = null
    this.canvas.classList.remove('dragging')

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

    // A click/tap (or sub-pixel drag) commits nothing: the viewport is
    // unchanged, no move repainted the canvas, and a store write would only
    // restart an identical render — the exact waste B3 (#74) describes. Bail
    // before the commit. (Cleanup above already ran, so the drag is torn down.)
    if (Math.abs(dxInternal) < PAN_DEADZONE_PX && Math.abs(dyInternal) < PAN_DEADZONE_PX) {
      // This was a click/tap, not a pan — hand the CSS-pixel position to the
      // click consumer (the orbit visualizer, E1 #94; the Julia c-picker, O2
      // #92). Reuses this canonical click-vs-pan classification rather than a
      // separate `click` listener re-deriving its own threshold. The modifier
      // flags ride along so the consumer can route a plain click vs. a
      // modifier-click (Alt-click picks the Julia constant) without this layer
      // knowing either intent — it stays presentation-free.
      this.onClick(event.clientX - rect.left, event.clientY - rect.top, {
        altKey: event.altKey,
      })
      return
    }

    const next = base.pan_by_pixels(dxInternal, dyInternal)
    this.currentViewport = next
    this.store.set(next, 'gesture')
  }

  // Euclidean distance, in client (CSS) pixels, between two tracked pointers.
  // Returns 0 if either is no longer tracked (the caller treats 0 as a no-op).
  private distanceBetween(idA: number, idB: number): number {
    const a = this.activePointers.get(idA)
    const b = this.activePointers.get(idB)
    if (a === undefined || b === undefined) return 0
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  }

  // Midpoint, in client (CSS) pixels, between two tracked pointers.
  private midpointBetween(idA: number, idB: number): [number, number] {
    const a = this.activePointers.get(idA)
    const b = this.activePointers.get(idB)
    if (a === undefined || b === undefined) return [0, 0]
    return [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2]
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
   * Commit the accumulated pinch zoom on release. Like {@link settleZoom} it
   * writes the store once (`'gesture'`) and intentionally keeps `zoomPreview`
   * and the CSS transform — `render-client`'s paint clears the transform when
   * the fresh frame lands (an atomic swap), so clearing it here would flash the
   * old, unscaled frame for a tick. Only the pinch bookkeeping is dropped; the
   * gesture is over, so a leftover finger starts nothing until it lifts.
   */
  private settlePinch(): void {
    if (this.zoomPreview !== null) {
      this.store.set(this.zoomPreview.viewport, 'gesture')
    }
    this.pinch = null
    // Lock out new gestures until every finger lifts: the kept Preview transform
    // would otherwise desync a pinch begun by a finger re-landing before the
    // Settle frame paints (see `pinchLockout`).
    this.pinchLockout = true
  }

  /**
   * Tear down any zoom Preview (wheel scrub or pinch): cancel a pending Settle,
   * drop the accumulator, pinch state, and cached rect, and clear the CSS
   * transform. Writes **no** store update — the accumulated zoom already rides
   * in `currentViewport` (advanced per notch/move), so a caller (a starting
   * pan, or an external store write) carries it forward without an extra
   * render. Clearing the transform also lets a starting pan read an
   * untransformed `getBoundingClientRect` (a live transform would scale the pan
   * delta).
   */
  private clearZoomPreview(): void {
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    this.zoomPreview = null
    this.pinch = null
    this.scrubRect = null
    if (this.canvas.style.transform !== '') {
      this.canvas.style.transform = ''
    }
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: ViewportStore,
    // Called while a zoom Preview is active to discard any in-flight
    // render so it can't paint stale pixels mid-scrub/pinch (ADR-0012). Injected
    // (rather than importing the render client) to keep this controller
    // presentation-free. Defaults to a no-op for tests that don't wire it.
    private readonly onInvalidate: () => void = () => {},
    // Called on a click/tap (pointerdown + pointerup within the pan deadzone)
    // with the click's CSS-pixel position relative to the canvas and the
    // modifier-key state. Drives the orbit visualizer's pin (E1, #94) on a
    // plain click and the Julia c-picker (O2, #92) on an Alt-click; a no-op by
    // default, so the controller stays presentation-free and existing tests
    // need no wiring.
    private readonly onClick: (
      cssX: number,
      cssY: number,
      modifiers: { altKey: boolean },
    ) => void = () => {},
  ) {
    this.currentViewport = store.get()
    // Any viewport write the controller did *not* author (a refit, a
    // mode-reset, a future URL hydrator) supersedes whatever the controller
    // holds and any in-progress zoom scrub: mirror the new viewport into the
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
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    // With `setPointerCapture` (in `handlePointerDown`) these route to the
    // canvas for the whole gesture, even past the box edge — so they live on
    // the canvas, not `document`. `pointercancel` shares the up handler.
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    canvas.addEventListener('pointercancel', this.handlePointerUp)
    // `passive: false` is required for `preventDefault()` to take
    // effect on wheel — modern browsers default wheel listeners to
    // passive, which silently no-ops `preventDefault`.
    canvas.addEventListener('wheel', this.handleWheel, { passive: false })
  }
}

interface DragState {
  readonly startClientX: number
  readonly startClientY: number
  // The drag snapshot, held as an offscreen canvas so each move can
  // re-blit it with `drawImage` (GPU path) rather than `putImageData` (#82).
  readonly snapshot: HTMLCanvasElement
  // Whether the deferred in-flight-render discard has fired for this drag.
  // Starts false on pointerdown; set true on the first real move so the
  // discard runs once, when an actual drag begins (B3, #74).
  invalidated: boolean
}

interface PinchState {
  readonly pointerA: number
  readonly pointerB: number
  // Inter-pointer distance recorded at the previous move (CSS pixels), so each
  // move's zoom factor is the incremental `distance / lastDistance`.
  lastDistance: number
}

interface PointerPosition {
  clientX: number
  clientY: number
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
