import { connectWorker, type WorkerReply } from './worker/connection.js'
import type {
  CancelRequest,
  Field,
  FractalKind,
  NormalizationMode,
  Palette,
  ProbeRequest,
  ProbeResponse,
  RecolorizeRequest,
  RenderRequest,
  RenderResponse,
} from './worker/protocol.js'

/**
 * One traced pixel handed to the inspector (E2, #95) — the {@link ProbeResponse}
 * payload minus the wire fields. `inside` means the NaN inside-set sentinel (so
 * `t` is meaningless and the swatch black); otherwise `raw` is the Field scalar,
 * `t ∈ [0, 1]` where it landed after normalisation, and `r`/`g`/`b` the painted
 * colour.
 */
export interface PixelProbe {
  readonly raw: number
  readonly t: number
  readonly inside: boolean
  readonly r: number
  readonly g: number
  readonly b: number
}

/**
 * Determinate progress sink for a slow render (P2, #78). The client reports
 * the lifecycle of the *in-flight render* — `begin` when it is dispatched,
 * `report(fraction)` on each band heartbeat, `end` when it resolves (painted,
 * superseded, or errored). The implementation (see `progress.ts`) owns the
 * debounce that keeps the indicator from flashing on fast frames, so the
 * client stays DOM-free. Recolorizes never report (no per-band work).
 */
export interface ProgressReporter {
  readonly begin: () => void
  readonly report: (fraction: number) => void
  readonly end: () => void
}

const NOOP_PROGRESS: ProgressReporter = {
  begin: () => {},
  report: () => {},
  end: () => {},
}

/**
 * Main-thread half of the Slice 6 render pipeline. Replaces the
 * synchronous `render.ts`: presents the same fire-and-forget
 * `render` / `recolorize` surface to the `main.ts` dispatcher, but
 * dispatches the work to a Web Worker and paints the result when it
 * comes back. The UI thread is never blocked by a long `compute`, so
 * the cursor and controls stay live through a deep render.
 *
 * ## Coalescing
 *
 * The worker processes one request at a time. Rapid input (a
 * mouse-wheel scrub, a slider drag) can issue requests far faster than
 * the worker drains them; replaying every one would render a flipbook
 * of stale frames the user already scrolled past. Instead this client
 * keeps a single pending slot — at most one queued request. When the
 * in-flight response returns, only the latest queued request is
 * dispatched; everything in between is dropped. The user always
 * converges on the last viewport they actually asked for.
 *
 * Collapsing into one slot is *not* a blind overwrite, because the two
 * request kinds are not interchangeable. A render recomputes the
 * iteration buffer for a viewport and colourises it; a recolorize only
 * re-tints whatever buffer the worker last computed. So a render can
 * supersede anything queued — it is a superset, carrying its own
 * current colours — but a recolorize must never *replace* a queued
 * render: doing so would strand the user's latest pan/zoom and leave
 * the worker re-colourising a stale viewport (or, before the first
 * render completes, recolourising a buffer that does not exist yet).
 * Instead a recolorize *folds* its palette/mode into a pending render,
 * which already carries colour fields, so the single eventual dispatch
 * both recomputes the right frame and paints it in the right colours.
 *
 * Each issued request carries a monotonically increasing `epoch`. A
 * response for a superseded request is discarded. This is belt-and-
 * braces alongside the single-slot queue: even though we never have two
 * requests in flight at once, the epoch check guarantees a slow
 * response can't repaint a frame the user has already moved past. What
 * supersedes differs by kind (#182). A recolorize response paints only if
 * nothing was issued after it. A render response stands unless a newer
 * render or a `discardInFlight` has moved the frame on. A recolorize issued
 * while it ran doesn't supersede it: it takes over the render's paint,
 * re-tinting the fresh frame so it lands once, in the new colours, and that
 * paint ends a zoom Preview as the render's would have. The client also
 * tracks which render's frame the worker holds and which is on screen, so it
 * never re-tints or probes a frame the user hasn't seen.
 *
 * ## Boot ordering
 *
 * The worker bootstraps its own WASM instance asynchronously and posts
 * `{ kind: 'ready' }` when done. Requests issued before `ready` (the
 * boot-time `rerender()` in `main.ts` is one) are buffered in the same
 * pending slot and flushed the moment `ready` arrives.
 */

type ClientRequest = RenderRequest | RecolorizeRequest

// How long to wait for the worker's `ready` before declaring boot failed.
// The worker bootstraps WASM + a rayon thread pool; on a cold cache that is
// well under a second, so 5 s is generous headroom that still surfaces a
// stuck boot (a stripped cross-origin-isolation header, a LinkError) rather
// than hanging on a black screen forever.
const BOOT_TIMEOUT_MS = 5000

/**
 * Construction-time collaborators for the render client. Injected here (rather
 * than reached for via setters after the fact) so the client owns its worker
 * and surfaces from birth — `pwa-lifecycle.ts` follows the same ports-and-
 * adapters shape. Tests pass a fake `workerFactory` and, where relevant, fakes
 * for the two optional surfaces; no global patching or module resets.
 */
export interface RenderClientDeps {
  /**
   * Builds the Web Worker the client drives. In production this is a thunk
   * around `new Worker(new URL('./worker/worker.ts', import.meta.url), { type:
   * 'module' })` — that expression must stay syntactically intact at the call
   * site (it lives in `main.ts`) for Vite's static worker-bundling analysis,
   * which is why the *factory*, not a ready-made worker, is injected.
   */
  readonly workerFactory: () => Worker
  /**
   * Unrecoverable-boot-failure surface (`main.ts` wires `showFatal`). When
   * provided, the boot watchdog is armed at construction; when omitted,
   * `reportFatal` only logs and no watchdog runs (so a test that doesn't care
   * leaves no stray timer).
   */
  readonly onFatal?: (message: string) => void
  /**
   * Determinate-progress sink for the in-flight render (P2). Defaults to a
   * no-op; recolorizes never drive it. See `ProgressReporter`.
   */
  readonly progress?: ProgressReporter
  /**
   * Pixel-inspector sink (E2, #95). Called with the traced pixel for the most
   * recent `probe()` whose response has come back. Omitted when the inspector
   * is not wired (tests, headless), in which case probe responses are dropped.
   */
  readonly onProbeResult?: (probe: PixelProbe) => void
  /**
   * Whether a gesture currently owns the canvas (`main.ts` reads the
   * InputController's gesture phase, #159). `probe` refuses while it does:
   * mid-gesture the image on screen is shifted or scaled away from the cached
   * frame. Defaults to never.
   */
  readonly isGestureActive?: () => boolean
  /**
   * Called synchronously right before a *render* response is painted — not a
   * recolorize. `main.ts` wires the InputController's `onRenderPainted`, which
   * ends a live zoom Preview, so the Preview→true-frame swap is atomic
   * (ADR-0012). Defaults to a no-op.
   */
  readonly onRenderPainted?: () => void
}

/**
 * The fire-and-forget surface `main.ts` dispatches against. All pipeline state
 * (epoch counter, in-flight/pending slots, boot status) lives in the closure,
 * so each client owns exactly one worker — constructing a second instance is
 * the seam a future side-by-side view would use.
 */
export interface RenderClient {
  readonly render: (
    viewport: { centerRe: number; centerIm: number; zoom: number; width: number; height: number },
    ctx: CanvasRenderingContext2D,
    maxIter: number,
    palette: Palette,
    mode: NormalizationMode,
    kind: FractalKind,
    cRe: number,
    cIm: number,
    field: Field,
  ) => void
  readonly recolorize: (
    ctx: CanvasRenderingContext2D,
    palette: Palette,
    mode: NormalizationMode,
  ) => void
  /**
   * Read one render-buffer pixel `(x, y)` of the cached frame for the
   * inspector (E2, #95). The result lands on a later `onProbeResult`. Returns
   * `false` without sending when the cached buffer is not stable — booting, a
   * compute in flight rewriting it, a cached frame that isn't the one on
   * screen, or a gesture owning the canvas — so the
   * caller can keep its last reading rather than pairing it with a fresh
   * coordinate.
   */
  readonly probe: (x: number, y: number, palette: Palette, mode: NormalizationMode) => boolean
  readonly discardInFlight: () => void
}

export function createRenderClient(deps: RenderClientDeps): RenderClient {
  let latestEpoch = 0
  // The epoch of the newest request that moves the frame: a render (including
  // one a recolorize folded into) or a discard. A render response stands only
  // if it carries this epoch (see the module doc, #182).
  let latestFrameEpoch = 0
  // Which render's frame the worker's cache holds, and which is on the canvas,
  // by epoch (#182). They differ after a render the client dropped as
  // superseded, or one whose paint a queued recolorize took over. Re-tinting a
  // cached frame that isn't on screen would paint geometry the user isn't
  // looking at, under a Preview scaling a different frame, unless it is the
  // frame they're waiting for. `cachedFrameEpoch` is null when the cache holds
  // nothing to trust: before the first render, after one the worker
  // abandoned partway, or after one that failed.
  let cachedFrameEpoch: number | null = null
  let shownFrameEpoch: number | null = null
  let inFlight = false
  // The kind of the request currently on the worker, captured at dispatch.
  // `onmessage` reads it to tell which epoch a response must match and what
  // it does to the cache: a `render` replaces the cached frame; a
  // `recolorize` re-tints it without moving it (see `paint`).
  let inFlightKind: ClientRequest['kind'] | null = null
  let pending: ClientRequest | null = null
  let ready = false
  // Set once the connection reports the worker unusable (see `reportFatal`).
  // A dead worker will never respond, so `flush` sends nothing more: a request
  // issued after it waits in the pending slot for good.
  let dead = false
  // The canvas context to paint the next fresh response onto. Only a current
  // response paints (see the module doc), and `targetCtx` always tracks the
  // latest request's context, so a single reference suffices (in practice
  // it is the one canvas for this client's lifetime).
  let targetCtx: CanvasRenderingContext2D | null = null

  // Progress sink for the in-flight render (P2). No-op when not injected;
  // recolorizes never drive it. See `ProgressReporter`.
  const progress: ProgressReporter = deps.progress ?? NOOP_PROGRESS

  // Pixel-inspector sink + a monotonic probe generation (E2, #95). A response
  // is delivered only if its seq still equals `latestProbeSeq`; the seq advances
  // both when a newer probe is issued (a hover fires many — drop the ones the
  // cursor moved past) AND whenever the cached frame changes under an
  // outstanding probe (a render/recolorize/discard — see `invalidateProbes`), so
  // a response computed against a superseded frame never paints stale
  // values/colours into the HUD. Independent of the render epoch — a probe never
  // enters the render slot.
  const onProbeResult: ((probe: PixelProbe) => void) | null = deps.onProbeResult ?? null
  let latestProbeSeq = 0

  // The input layer's gesture state (#159); see `RenderClientDeps`.
  const isGestureActive = deps.isGestureActive ?? (() => false)
  const onRenderPainted = deps.onRenderPainted ?? (() => {})

  // Advance the probe generation so any probe response still in flight is
  // dropped on arrival. Called whenever the cached frame is about to change.
  function invalidateProbes(): void {
    latestProbeSeq += 1
  }

  // Everything the worker posts once booted (see `connectWorker`).
  function handleReply(msg: WorkerReply): void {
    if (msg.kind === 'probe-response') {
      // A read-only side query's reply (E2, #95): independent of the render
      // slot, so handled before the in-flight guard. Deliver only the newest
      // probe — responses return in order, so any older seq is one the user has
      // already hovered past.
      if (msg.seq === latestProbeSeq) {
        onProbeResult?.({
          raw: msg.raw,
          t: msg.t,
          inside: msg.inside,
          r: msg.r,
          g: msg.g,
          b: msg.b,
        })
      }
      return
    }
    if (msg.kind === 'progress') {
      // A non-terminal heartbeat from a banded render (P2): it does NOT free
      // the slot. Drive the indicator only for the frame the user is still
      // waiting on — a heartbeat for an already-superseded render is ignored,
      // so a doomed frame never moves the bar. A recolorize queued behind the
      // render doesn't supersede it.
      if (msg.epoch === latestFrameEpoch) {
        progress.report(msg.rowsTotal > 0 ? msg.rowsDone / msg.rowsTotal : 0)
      }
      return
    }

    // Ignore a terminal message with nothing outstanding — there is no request
    // it could belong to (e.g. a stray message before `ready`). Without this
    // guard a spurious response could paint a frame that was never dispatched.
    if (!inFlight) {
      return
    }
    // A response, error, or abort is terminal for the in-flight request: it
    // frees the worker for the next one and ends any progress indicator.
    inFlight = false
    progress.end()
    if (msg.kind === 'aborted') {
      // The worker abandoned this render because a newer one superseded it
      // (P2). There is no frame to paint — just dispatch whatever overtook it.
      // Its partial frame is now the worker's cache.
      cachedFrameEpoch = null
      flush()
      return
    }
    if (msg.kind === 'error') {
      // A render/recolorize threw inside the worker (a boundary-validation
      // JsError, or WASM refusing to colour a missing or partial frame). The
      // worker stays alive and idle, so this is recoverable: free the slot,
      // log, and dispatch whatever queued — a single dropped frame, not a
      // permanent freeze. The canvas keeps its last good frame, and a zoom
      // Preview over it stays up: the transform is still the closest the old
      // frame comes to the viewport the store now holds, so the phase stays
      // `preview` (probes hold off) until a render paints.
      console.error(`render worker error (epoch ${msg.epoch}): ${msg.message}`)
      // A failed render may leave the cache as it was, partial, or complete
      // but never shown (colorize or the RGBA copy failing after the bands),
      // so trust none of it until a render lands. A failed recolorize leaves
      // the frame alone.
      if (inFlightKind === 'render') {
        cachedFrameEpoch = null
      }
      flush()
      return
    }
    // Paint it only if it is still the frame the user wants (see the module
    // doc); then dispatch whatever queued up while it ran. The cache is
    // recorded before the paint and the screen after it, so a paint that
    // throws leaves the two apart, and a recolorize re-tints that frame.
    if (inFlightKind === 'render') {
      cachedFrameEpoch = msg.epoch
      // A recolorize queued behind it paints this frame instead, in the new
      // colours, so it doesn't show in the old ones first.
      if (msg.epoch === latestFrameEpoch && pending?.kind !== 'recolorize' && targetCtx !== null) {
        paint(targetCtx, msg, true)
        shownFrameEpoch = msg.epoch
      }
    } else if (msg.epoch === latestEpoch && targetCtx !== null) {
      // A recolorize that took over a render's paint brings that frame's
      // geometry to the canvas; one re-tinting the frame on screen doesn't.
      paint(targetCtx, msg, cachedFrameEpoch !== shownFrameEpoch)
      shownFrameEpoch = cachedFrameEpoch
    }
    flush()
  }

  /**
   * The connection found the worker unusable (its boot failed or hung, or it
   * threw at the top level; called at most once): mark it dead, log, and hand
   * the message to the host surface, if injected. A request in flight gets no
   * reply now, so end its progress indicator here.
   */
  function reportFatal(message: string): void {
    dead = true
    if (inFlight) {
      inFlight = false
      progress.end()
    }
    console.error(`render worker fatal: ${message}`)
    deps.onFatal?.(message)
  }

  // The worker and its boot handshake (#160). The boot watchdog runs only when
  // a fatal surface was injected: with no `onFatal` there is nothing to
  // surface to, so a client built without one leaves no stray timer running.
  const connection = connectWorker(
    deps.workerFactory,
    {
      onReady: () => {
        ready = true
        flush()
      },
      onMessage: handleReply,
      onFatal: reportFatal,
    },
    { timeoutMs: deps.onFatal === undefined ? undefined : BOOT_TIMEOUT_MS },
  )

  /**
   * Dispatch the pending request if the worker is ready and idle. A no-op
   * when still booting, busy, or nothing is queued — the response handler
   * and the `ready` handler both call it, so a queued request is never
   * stranded.
   */
  function flush(): void {
    if (dead || !ready || inFlight || pending === null) {
      return
    }
    if (
      pending.kind === 'recolorize' &&
      (cachedFrameEpoch === null ||
        (cachedFrameEpoch !== shownFrameEpoch && cachedFrameEpoch !== latestFrameEpoch))
    ) {
      // The worker's cached frame is neither on screen nor the one the user is
      // waiting for (see `cachedFrameEpoch`), so drop the re-tint rather than
      // paint that frame. The render that replaces it (the Settle, a pan's
      // commit) reads the current colours. Before the first frame this also
      // spares the worker a recolorize it would reject.
      pending = null
      return
    }
    inFlight = true
    const req = pending
    pending = null
    inFlightKind = req.kind
    // Arm the progress indicator at the true dispatch time so its debounce
    // measures from when the worker actually starts (P2). Only a render does
    // per-band work; a recolorize is the fast path and never reports.
    if (req.kind === 'render') {
      progress.begin()
    }
    connection.post(req)
  }

  /**
   * Tell the worker that a render now on it is superseded, so it abandons its
   * remaining bands instead of grinding the doomed frame to completion (P2,
   * #78). Sent only when something is actually in flight — otherwise the new
   * request just dispatches immediately and there is nothing to cancel. The
   * worker tracks the max epoch it has seen, so the bare epoch is all it needs.
   */
  function postCancel(): void {
    if (dead || !inFlight) {
      return
    }
    const cancel: CancelRequest = { kind: 'cancel', epoch: latestEpoch }
    connection.post(cancel)
  }

  /**
   * Stamp a request with the next epoch, record its target context, place
   * it in the single pending slot, then try to flush.
   *
   * Coalescing rule (see the module doc): a recolorize folds its colours
   * into a pending render rather than replacing it, so the queued compute
   * is never lost. Every other case is newest-wins.
   */
  function issue(req: ClientRequest, ctx: CanvasRenderingContext2D): void {
    latestEpoch += 1
    targetCtx = ctx
    // A new compute/recolorize will change the cached frame, so any probe
    // response still in flight describes a frame about to be superseded — drop it.
    invalidateProbes()
    if (req.kind === 'recolorize' && pending !== null && pending.kind === 'render') {
      // Keep the queued render's compute (its newer viewport); swap only
      // the colours it will be painted with. Bump the epoch onto the
      // merged render so its eventual response is recognised as the latest
      // frame and paints.
      pending = { ...pending, palette: req.palette, mode: req.mode, epoch: latestEpoch }
    } else {
      pending = { ...req, epoch: latestEpoch }
    }
    // A queued render is the newest frame. Cancel the in-flight render, which
    // it makes obsolete, so the queued frame starts sooner instead of after
    // the doomed one finishes (P2). A queued recolorize is the opposite: it
    // re-tints whatever the in-flight render is computing, so it must let that
    // render finish. (It also must not abort it: an aborted render leaves a
    // partial iteration buffer that the recolorize would then read.) Once the
    // render completes, the recolorize dispatches against its whole, fresh
    // buffer.
    if (pending.kind === 'render') {
      latestFrameEpoch = latestEpoch
      postCancel()
    }
    flush()
  }

  /**
   * Discard any in-flight *or queued* render so it neither paints nor wastes
   * worker time. Bumping the epoch (and the frame epoch) past everything
   * outstanding makes the in-flight response stale in `onmessage`, so an
   * in-flight render is dropped on arrival; clearing the pending slot stops
   * a queued render from ever dispatching (it could otherwise run to
   * completion on the worker, delaying the frame that will actually paint).
   * The canvas keeps whatever it currently shows.
   *
   * The input controller calls this while a wheel-zoom Preview is active
   * (ADR-0012): a render committed by a premature Settle must not paint
   * mid-scrub and clear the Preview transform out from under the gesture. The
   * next real `issue()` (the final Settle, or a pan's commit) bumps the epoch
   * again and paints normally, so this only suppresses the stale frame.
   */
  function discardInFlight(): void {
    latestEpoch += 1
    latestFrameEpoch = latestEpoch
    pending = null
    // A Preview is taking over the canvas; the buffer a probe would describe is
    // about to be stale, so invalidate any outstanding probe response too.
    invalidateProbes()
    // Also stop the in-flight render's *work*, not just its paint: bumping the
    // epoch already guarantees its response won't paint, and this makes the
    // worker abandon the remaining bands so it is free for the next real issue
    // (the Settle render, or a pan commit) immediately (P2).
    postCancel()
  }

  // `newFrame`: whether this paint puts a different render's frame on the
  // canvas (see the Preview note below).
  function paint(ctx: CanvasRenderingContext2D, response: RenderResponse, newFrame: boolean): void {
    // Size the canvas backing store to the frame being painted, here at
    // paint time rather than at dispatch. The buffer dimensions can change
    // between requests (a window resize or a render-scale change), and
    // resizing a canvas clears it — doing that at dispatch would blank the
    // canvas for the whole duration of the compute. Deferring to paint
    // keeps the previous frame on screen (CSS-stretched to the new display
    // size as a live preview) until the fresh, correctly-sized frame is
    // ready to replace it in one step. The guard avoids a needless clear
    // when the dimensions are unchanged (the common pan/zoom case).
    const canvas = ctx.canvas
    if (canvas.width !== response.width) {
      canvas.width = response.width
    }
    if (canvas.height !== response.height) {
      canvas.height = response.height
    }
    // End any wheel-zoom Preview before painting (ADR-0012), but only for a
    // new frame. A render carries fresh geometry — the Settle frame, a
    // pan/resize commit, boot — so ending the Preview in the same tick as
    // `putImageData` makes the Preview→true-frame swap atomic (no snap-back);
    // so does a recolorize that took over a render's paint (#182). A
    // recolorize of the frame on screen is different: it re-tints the
    // *cached* (pre-scrub) buffer without moving it, so if a palette change
    // lands mid-scrub (within the settle window) the Preview scale still
    // applies to the same image — ending it would snap the frame to identity
    // at the wrong scale until the Settle render lands. So it leaves the
    // Preview for the frame that ends the scrub. Outside a scrub there is no
    // Preview and the input layer ignores the call.
    if (newFrame) {
      onRenderPainted()
    }
    const image = new ImageData(response.rgba, response.width, response.height)
    ctx.putImageData(image, 0, 0)
  }

  /**
   * Request a full compute → colorize → paint for `viewport`. Fire-and-
   * forget: returns immediately, the paint lands on a later worker
   * response. The viewport is passed as flat primitives (read off the
   * `Viewport` getters in `main.ts`) because a wasm-bindgen `Viewport`
   * instance cannot survive `postMessage`.
   */
  function render(
    viewport: { centerRe: number; centerIm: number; zoom: number; width: number; height: number },
    ctx: CanvasRenderingContext2D,
    maxIter: number,
    palette: Palette,
    mode: NormalizationMode,
    kind: FractalKind,
    cRe: number,
    cIm: number,
    field: Field,
  ): void {
    issue(
      {
        kind: 'render',
        epoch: 0, // replaced by issue()
        width: viewport.width,
        height: viewport.height,
        centerRe: viewport.centerRe,
        centerIm: viewport.centerIm,
        zoom: viewport.zoom,
        maxIter,
        palette,
        mode,
        fractalKind: kind,
        cRe,
        cIm,
        field,
      },
      ctx,
    )
  }

  /**
   * Re-colorize the worker's cached iteration buffer with new palette /
   * normalisation — the ADR-0002 fast path, no recompute. Fire-and-
   * forget.
   *
   * If a render is already queued, this folds its colours into that
   * render (see `issue`) rather than replacing it, so a visual-only
   * change can never strand a pending compute. A recolorize is only
   * dispatched as a standalone request when the worker already holds a
   * computed buffer (the in-flight or last-completed render); reaching
   * the worker with no complete frame cached would throw there (WASM
   * `colorize` refuses it), which the fold rule makes unreachable in
   * normal dispatch ordering.
   */
  function recolorize(
    ctx: CanvasRenderingContext2D,
    palette: Palette,
    mode: NormalizationMode,
  ): void {
    issue({ kind: 'recolorize', epoch: 0, palette, mode }, ctx)
  }

  /**
   * Read one render-buffer pixel of the cached frame for the inspector (E2,
   * #95) — fire-and-forget; the traced pixel lands on a later `onProbeResult`.
   *
   * Bypasses the render coalescing entirely (it carries a `seq`, not an
   * `epoch`, and posts immediately) and is gated on the cached buffer being
   * stable: skipped while booting/dead, while a *render* is in flight (its
   * first band has already clobbered the cached frame with partial data),
   * while the cached frame isn't the one on screen (`cachedFrameEpoch`), or
   * while a gesture owns the canvas (a drag shifts the image, a Preview scales
   * it). In those windows the inspector
   * keeps its last reading rather than showing a value that isn't on screen. An
   * in-flight *recolorize* is fine: it never rewrites the iteration buffer and
   * runs synchronously on the worker, so the probe reads a whole frame.
   */
  function probe(x: number, y: number, palette: Palette, mode: NormalizationMode): boolean {
    if (dead || !ready) {
      return false
    }
    if (inFlight && inFlightKind === 'render') {
      return false
    }
    if (cachedFrameEpoch === null || cachedFrameEpoch !== shownFrameEpoch || isGestureActive()) {
      return false
    }
    latestProbeSeq += 1
    const req: ProbeRequest = { kind: 'probe', seq: latestProbeSeq, x, y, palette, mode }
    connection.post(req)
    return true
  }

  return { render, recolorize, probe, discardInFlight }
}
