import type { Viewport } from '../wasm/fractal_wasm.js'
import type { GesturePhaseStore } from './gesture-phase.js'
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

// A press that stays within this many CSS pixels of where it went down, on both
// axes, is a click/tap, not a pan. ~4px tolerates the hand-jitter of a
// "stationary" mouse click, trackpad tap or touch without swallowing a real
// drag. Until a move leaves it the press starts nothing — no snapshot, no
// discard of in-flight work, no zoom-Preview teardown — so a click never
// restarts an in-flight deep render (B3, #74) or disturbs a live scrub. The
// drawer's light-dismiss uses the same slop, so one press never both dismisses
// the drawer and pans.
export const CLICK_SLOP_PX = 4

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
 * A press is a click until a move takes it more than `CLICK_SLOP_PX` from where
 * it went down. Then the pan starts: the controller snapshots the canvas into a
 * cached offscreen canvas via `drawImage` (a GPU-path blit, not a CPU pixel
 * readback), and each `pointermove` blits that snapshot back into the canvas
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
 * frame replaces the Preview when it paints — `render-client`'s `paint` calls
 * {@link InputController.onRenderPainted} in the same tick as `putImageData`,
 * which clears the transform: an atomic swap. A pan or pinch that starts inside
 * the pending Settle window tears the Preview down without rendering: the
 * accumulated zoom rides in the gesture's start viewport, so its commit issues
 * a single render rather than the zoom and the gesture each issuing one. A
 * press holds a pending Settle until it ends, since it may become such a pan.
 * A click leaves the Preview alone, and its Settle fires once the press is over.
 *
 * ## Gesture phase
 *
 * The controller publishes which gesture owns the canvas — `idle`, `dragging`
 * or `preview` — to the injected {@link GesturePhaseStore} (#159), so other
 * modules can hold off without reading the canvas's `.dragging` class or
 * inline `transform`. Both stay this file's business: the class drives the
 * drag cursor, the transform draws the Preview.
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
  // Whether the Preview is currently applied as the canvas's CSS transform.
  // Outlives `zoomPreview`'s gesture: a Settle keeps it until the fresh frame
  // paints (`onRenderPainted`).
  private previewShown = false
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  // The canvas's *untransformed* layout box, captured at the start of a
  // scrub/pinch. `getBoundingClientRect` reflects the live CSS transform, so
  // once the Preview has scaled the canvas, re-reading it would feed
  // drifting, scaled cursor coordinates into the zoom — see `handleWheel`. A
  // click on the Preview maps through it for the same reason (see `click`).
  private scrubRect: DOMRect | null = null
  // Reusable offscreen canvas holding the drag snapshot. Cached across
  // gestures so a pan never allocates a fresh buffer; `captureSnapshot`
  // only resizes it when the render buffer's dimensions change.
  private snapshotCanvas: HTMLCanvasElement | null = null

  // Blit the current canvas into the cached offscreen buffer and return
  // it, sizing the buffer to match. Returns null if the offscreen 2D
  // context is unavailable (`startDrag` then drops the press, as pointerdown
  // ignores one for a null main context). The full-surface `drawImage` at
  // (0,0) overwrites the whole buffer, so no clear is needed even when the
  // buffer is reused.
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

    // First pointer → a press that may become a pan. It starts nothing yet: a
    // click (e.g. the drawer's light-dismiss) must leave an in-flight deep
    // render and a live zoom Preview untouched (B3, #74). The pan starts when a
    // move leaves `CLICK_SLOP_PX` (see `startDrag`).
    this.dragState = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      snapshot: null,
    }
    this.canvas.classList.add('dragging')
    this.publishPhase()
  }

  // The press has left the click slop: start the pan. Returns the drag
  // snapshot, or null (dropping the press) if it can't be taken.
  private startDrag(drag: DragState): HTMLCanvasElement | null {
    // Snapshot now rather than at pointerdown, so a frame that painted while
    // the press sat still is the one the drag shifts (#184). A CSS transform
    // doesn't touch the buffer, so a live Preview can't leak into it.
    const snapshot = this.captureSnapshot()
    if (snapshot === null) {
      this.dropDrag()
      return null
    }
    drag.snapshot = snapshot
    // A pan starting mid-zoom tears the Preview down *without* rendering: the
    // accumulated zoom already rides in `currentViewport`, which the pan starts
    // from, so firing the zoom's Settle here would only dispatch an
    // intermediate frame that paints mid-drag and clobbers the snapshot. The
    // pan's pointerup issues the single render. Clearing the transform also
    // lets the drag measure an untransformed canvas (a live transform would
    // scale the pan delta).
    this.clearZoomPreview()
    // Discard any in-flight render so it can't paint over the drag preview
    // (ADR-0012 boundary rule). The pan's commit re-renders on release.
    this.onInvalidate()
    return snapshot
  }

  // End the one-pointer drag's bookkeeping (not its commit; see `endDrag`).
  private dropDrag(): void {
    this.dragState = null
    this.canvas.classList.remove('dragging')
    this.publishPhase()
  }

  // Publish the gesture phase from this controller's own state. A press counts
  // as dragging from pointerdown, even over a live Preview it may yet leave
  // alone as a click (see `GesturePhase`). Otherwise the states don't overlap:
  // a pan starts by tearing down any Preview, a pinch by dropping the pan, and
  // the wheel is ignored mid-press. A pinch counts as a Preview from its second finger,
  // before its first move scales anything.
  private publishPhase(): void {
    const previewing = this.previewShown || this.pinch !== null
    this.phase.set(this.dragState !== null ? 'dragging' : previewing ? 'preview' : 'idle')
  }

  // Apply `preview` as the canvas's CSS transform.
  private showPreview(preview: ZoomPreview): void {
    this.canvas.style.transform = zoomPreviewTransform(preview)
    this.previewShown = true
    this.publishPhase()
  }

  // Remove the Preview transform, if one is applied.
  private hidePreview(): void {
    if (!this.previewShown) return
    this.canvas.style.transform = ''
    this.previewShown = false
    this.publishPhase()
  }

  // Switch an in-progress (or just-pressed) pan into a two-finger pinch.
  private beginPinch(): void {
    // A pinch supersedes any in-progress pan. The pan never committed, so
    // `currentViewport` still depicts the un-panned frame — restore the canvas
    // buffer to match by re-blitting the snapshot at the origin, then drop the
    // drag. (A press that hasn't left the click slop drew nothing to undo.)
    const snapshot = this.dragState?.snapshot
    if (snapshot) {
      const ctx = this.canvas.getContext('2d')
      if (ctx !== null) {
        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        ctx.drawImage(snapshot, 0, 0)
      }
    }
    if (this.dragState !== null) this.dropDrag()
    // A press doesn't tear down a wheel Preview, so the pinch does, as a
    // starting pan would: the zoom rides in `currentViewport`, and the box
    // measured below must be untransformed.
    this.clearZoomPreview()
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
    this.publishPhase()
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
    const drag = this.dragState
    if (drag === null) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return

    const dxCss = event.clientX - drag.startClientX
    const dyCss = event.clientY - drag.startClientY
    // Inside the click slop the press may still be a click: draw nothing.
    let snapshot = drag.snapshot
    if (snapshot === null) {
      if (withinClickSlop(dxCss, dyCss)) return
      snapshot = this.startDrag(drag)
      if (snapshot === null) return
    }

    // Measured after `startDrag`, which may have just cleared a Preview.
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dxInternal = (dxCss * this.canvas.width) / rect.width
    const dyInternal = (dyCss * this.canvas.height) / rect.height

    // Fill black for the edges exposed by the drag — this matches the
    // Mandelbrot "outside the set" colour, so the strips look like
    // part of the fractal rather than blank canvas. `drawImage` of the
    // opaque snapshot fully covers the centre, so the black only shows
    // through at the shifted-in edges.
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.drawImage(snapshot, dxInternal, dyInternal)
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
    // The logical-grid sample under the midpoint anchors the zoom; the raw
    // (cssX, cssY) anchors the Preview transform (see `cssToGridSample`).
    const [pixelX, pixelY] = this.cssToGridSample(cssX, cssY, rect)

    this.zoomPreview = applyZoomNotch(this.zoomPreview, pixelX, pixelY, cssX, cssY, factor)
    this.currentViewport = this.zoomPreview.viewport
    this.showPreview(this.zoomPreview)
  }

  // Shared by `pointerup` and `pointercancel`: a cancel tears the gesture down
  // the same way a normal release does (committing what the Preview already
  // showed) so no dangling transform or ahead-of-store viewport is left behind.
  // The one difference: a cancelled press is never a click (see `endDrag`).
  private readonly handlePointerUp = (event: PointerEvent): void => {
    // The pointer's last tracked position: where a cancelled pan's preview was.
    const last = this.activePointers.get(event.pointerId)
    if (last === undefined) return
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
      this.endDrag(event, last)
    }
  }

  // End a one-pointer press: a click if it never left the click slop,
  // otherwise a pan, committed. `last` is the pointer's last tracked position.
  private endDrag(event: PointerEvent, last: PointerPosition): void {
    const drag = this.dragState
    if (drag === null) return
    this.dropDrag()

    // A cancel's own coordinates can be zeroed; the last move is reliable.
    const at = event.type === 'pointercancel' ? last : event
    const dxCss = at.clientX - drag.startClientX
    const dyCss = at.clientY - drag.startClientY
    if (drag.snapshot === null) {
      // No move took the press out of the click slop, so it started nothing.
      // A cancelled press is not a tap: the OS took the pointer, the user
      // didn't click (the drawer's light-dismiss agrees).
      if (event.type === 'pointercancel') return
      if (withinClickSlop(dxCss, dyCss)) {
        this.click(event)
        return
      }
      // Released far from the press with no move in between (a fast flick):
      // a pan with no drag preview. Tear down a Preview as `startDrag` would.
      this.clearZoomPreview()
    }

    // Once started, a drag always commits, even one released back at its
    // start: it discarded the in-flight render, and may have torn down a
    // Preview whose zoom rides only in `currentViewport` (#180).
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      // A degenerate box (display:none, detached) can't scale the delta — it
      // would reach the WASM seam as NaN/Infinity and fail its finite-input
      // check — so commit the viewport unpanned.
      this.store.set(this.currentViewport, 'gesture')
      return
    }
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
    const next = base.pan_by_pixels(dxInternal, dyInternal)
    this.currentViewport = next
    this.store.set(next, 'gesture')
  }

  // A press released inside the click slop: hand its CSS-pixel position to the
  // click consumer (the orbit visualizer, E1 #94; the Julia c-picker, O2 #92).
  // Reuses this canonical click-vs-pan classification rather than a separate
  // `click` listener re-deriving its own threshold. The modifier flags ride
  // along so the consumer can route a plain click vs. a modifier-click
  // (Alt-click picks the Julia constant) without this layer knowing either
  // intent — it stays presentation-free.
  //
  // The click commits nothing and leaves a live zoom Preview alone, so it maps
  // through the frame as displayed: `currentViewport` over the untransformed
  // box, which the Preview transform makes the old frame show. Neither the
  // store nor the live box will do. The store lags a scrub until the Settle,
  // and again if a notch lands before the Settle's frame paints. The live box
  // is scaled by the transform.
  private click(event: PointerEvent): void {
    // `scrubRect` is the box measured, untransformed, when the Preview began.
    const rect = (this.previewShown ? this.scrubRect : null) ?? this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    this.onClick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      { viewport: this.currentViewport, rect },
      { altKey: event.altKey },
    )
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

  /**
   * Map a CSS-pixel cursor position to the logical-grid sample point that
   * `Viewport.zoom_around` (and `pixel_to_complex_f`) consume. Both the wheel
   * and pinch zoom feeders go through here, so the convention lives in one
   * place (B5, #76).
   *
   * Two corrections are folded in:
   *  - Scale by the viewport's *logical* dimensions over `rect`, not the
   *    render buffer, so the anchored point is correct at any render scale.
   *  - Subtract a half-pixel. `pixel_to_complex_f` samples index j at
   *    coordinate j, so the sample for buffer pixel j is displayed across the
   *    screen cell [j, j+1) centred at j+0.5. The cursor's CSS coordinate is
   *    cell-edge, so the buffer position under it is `cssX·scale`; the −0.5
   *    names the *sample* drawn there — the point that must stay put.
   *
   * The raw `(cssX, cssY)` is kept separately by callers to anchor the CSS
   * Preview transform: that pins the true on-screen position, not a grid
   * sample, so it must not get the −0.5.
   */
  private cssToGridSample(cssX: number, cssY: number, rect: DOMRect): [number, number] {
    return [
      (cssX * this.currentViewport.width()) / rect.width - 0.5,
      (cssY * this.currentViewport.height()) / rect.height - 0.5,
    ]
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // A notch mid-drag (mouse button held) is ignored: a Preview transform
    // under a live drag would scale its pointer deltas, and the Settle would
    // later commit the zoomed-but-unpanned viewport over the pan's commit.
    if (this.dragState !== null) return
    // Whether a Preview transform is already applied (a scrub is visually
    // active). This gates only whether the Preview re-bases below — it no
    // longer gates the in-flight discard.
    const previewActive = this.previewShown
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
    // The cursor's logical-grid sample anchors the zoom; the raw (cssX, cssY)
    // anchors the Preview transform (see `cssToGridSample`).
    const [pixelX, pixelY] = this.cssToGridSample(cssX, cssY, rect)
    const factor = 1.25 ** (-normalizeWheelDelta(event) / 100)

    this.zoomPreview = applyZoomNotch(preview, pixelX, pixelY, cssX, cssY, factor)
    this.currentViewport = this.zoomPreview.viewport
    this.showPreview(this.zoomPreview)

    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
    }
    this.settleTimer = setTimeout(this.settleZoom, WHEEL_SETTLE_MS)
  }

  /**
   * Commit the accumulated wheel zoom: `set` the store once (source
   * `'gesture'`) for the final viewport, which triggers the recompute. The
   * fresh frame's paint clears the Preview transform (`onRenderPainted`), so
   * `zoomPreview` is intentionally kept here — a notch arriving before that
   * paint continues the same matrix. The store subscription skips this
   * `'gesture'` write, so it does not tear the kept Preview down.
   */
  private readonly settleZoom = (): void => {
    // A press is down: hold the Settle until it ends. If the press becomes a
    // pan, `startDrag` tears the Preview down and the pan's commit carries the
    // zoom, so a render dispatched now would only be discarded.
    if (this.dragState !== null) {
      this.settleTimer = setTimeout(this.settleZoom, WHEEL_SETTLE_MS)
      return
    }
    this.settleTimer = undefined
    if (this.zoomPreview === null) return
    this.store.set(this.zoomPreview.viewport, 'gesture')
  }

  /**
   * Commit the accumulated pinch zoom on release. Like {@link settleZoom} it
   * writes the store once (`'gesture'`) and intentionally keeps `zoomPreview`
   * and the CSS transform — the fresh frame's paint clears it
   * (`onRenderPainted`, an atomic swap), so clearing it here would flash the
   * old, unscaled frame for a tick. Only the pinch bookkeeping is dropped; the
   * gesture is over, so a leftover finger starts nothing until it lifts.
   */
  private settlePinch(): void {
    if (this.zoomPreview !== null) {
      this.store.set(this.zoomPreview.viewport, 'gesture')
    }
    this.pinch = null
    this.publishPhase()
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
    this.hidePreview()
    this.publishPhase()
  }

  /**
   * A fresh *render* is being painted onto the canvas (not a recolorize: that
   * re-tints the cached frame without moving it). The render client calls this
   * synchronously right before `putImageData`, so ending the Preview here makes
   * the Preview→true-frame swap atomic, in one tick (ADR-0012). `zoomPreview`
   * is kept, as at a Settle; with the transform gone, the next wheel notch
   * re-bases it to the new frame.
   */
  onRenderPainted(): void {
    this.hidePreview()
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: ViewportStore,
    // Where the controller publishes its gesture phase (#159); main.ts shares
    // it with the modules that must hold off mid-gesture. Required, so a call
    // site can't silently publish to a store nobody reads.
    private readonly phase: GesturePhaseStore,
    // Called while a zoom Preview is active to discard any in-flight
    // render so it can't paint stale pixels mid-scrub/pinch (ADR-0012). Injected
    // (rather than importing the render client) to keep this controller
    // presentation-free. Defaults to a no-op for tests that don't wire it.
    private readonly onInvalidate: () => void = () => {},
    // Called on a click/tap (a press released within `CLICK_SLOP_PX`)
    // with the click's CSS-pixel position relative to `frame.rect`, the frame
    // that position lands on (see `click`), and the modifier-key state. Drives
    // the orbit visualizer's pin (E1, #94) on a plain click and the Julia
    // c-picker (O2, #92) on an Alt-click; a no-op by default, so the controller
    // stays presentation-free and existing tests need no wiring.
    private readonly onClick: (
      cssX: number,
      cssY: number,
      frame: ClickFrame,
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
  // Null until a move leaves the click slop and the pan starts (`startDrag`).
  snapshot: HTMLCanvasElement | null
}

/**
 * The frame a click landed on: `viewport` as drawn over `rect`, the CSS box
 * (untransformed) that the click's position is relative to. The consumer maps
 * the click through these rather than the store and a box it measures itself.
 */
export interface ClickFrame {
  readonly viewport: Viewport
  readonly rect: DOMRect
}

// Whether a press displaced by (dxCss, dyCss) is still a click (see
// `CLICK_SLOP_PX`). Shared with the drawer's light-dismiss.
export function withinClickSlop(dxCss: number, dyCss: number): boolean {
  return Math.abs(dxCss) <= CLICK_SLOP_PX && Math.abs(dyCss) <= CLICK_SLOP_PX
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
