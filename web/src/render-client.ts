import type {
  Aborted,
  BootError,
  BootProgress,
  CancelRequest,
  Field,
  FractalKind,
  NormalizationMode,
  Palette,
  ProbeRequest,
  ProbeResponse,
  ProgressResponse,
  Ready,
  RecolorizeRequest,
  RenderError,
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
 * Compose a human, on-screen message for a worker {@link BootError} (#83). The
 * fatal panel is the only diagnostic a phone user can read without a console,
 * so each stage names what it means in plain terms and appends the raw error
 * text, which usually pins the exact cause (an unsupported WASM feature, a
 * `SharedArrayBuffer` RangeError, a stripped isolation header).
 */
function bootErrorMessage(err: BootError): string {
  const detail = err.message ? ` (${err.message})` : ''
  switch (err.stage) {
    case 'isolation':
      return (
        'The renderer needs cross-origin isolation (SharedArrayBuffer), which ' +
        `this page is not serving${detail}.`
      )
    case 'init':
      return (
        'The WebAssembly renderer failed to load. This browser may be missing a ' +
        'feature the build requires (for example WASM SIMD on older mobile ' +
        `browsers), or an isolation header was stripped${detail}.`
      )
    case 'thread-pool':
      return (
        'The renderer loaded but its multithreaded worker pool failed to start ' +
        `on this browser${detail}.`
      )
  }
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
 * response is painted only if its epoch is still the latest one issued;
 * a response for a superseded request is discarded. This is belt-and-
 * braces alongside the single-slot queue: even though we never have two
 * requests in flight at once, the epoch check guarantees a slow
 * response can't repaint a frame the user has already moved past.
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
   * compute in flight rewriting it, or a Preview transform live mid-gesture — so
   * the caller can keep its last reading rather than pairing it with a fresh
   * coordinate.
   */
  readonly probe: (x: number, y: number, palette: Palette, mode: NormalizationMode) => boolean
  readonly discardInFlight: () => void
}

export function createRenderClient(deps: RenderClientDeps): RenderClient {
  const worker = deps.workerFactory()

  let latestEpoch = 0
  let inFlight = false
  // The kind of the request currently on the worker, captured at dispatch.
  // `paint` reads it to decide whether the response may clear the Preview
  // transform: only a `render` carries fresh geometry that ends a scrub; a
  // `recolorize` re-tints the cached buffer without moving it (see `paint`).
  let inFlightKind: ClientRequest['kind'] | null = null
  let pending: ClientRequest | null = null
  let ready = false
  // How far the worker's two-step boot got (#83). Flips to `true` when the
  // worker posts `{ kind: 'boot', stage: 'wasm' }` — i.e. the WASM module
  // instantiated. The watchdog reads it to localise a *hang*: WASM up but no
  // `ready` means the rayon thread pool never came up; still false means the
  // binary never instantiated (often an unsupported WASM feature on this
  // browser). A `boot-error` gives the exact cause; this covers the silent hang.
  let wasmInstantiated = false
  // Set once the worker is known to be unusable (it threw at the top level, or
  // never reached `ready`). A dead worker will never respond, so `issue` and
  // `flush` no-op rather than parking requests in a slot that can't drain.
  let dead = false
  // The canvas context to paint the next fresh response onto. Only the
  // latest-epoch response paints, and `targetCtx` always tracks the
  // latest request's context, so a single reference suffices (in practice
  // it is the one canvas for this client's lifetime).
  let targetCtx: CanvasRenderingContext2D | null = null

  // Surfaced to the host (main.ts wires `showFatal`). Null when not injected;
  // `reportFatal` no-ops without it.
  const onFatal: ((message: string) => void) | null = deps.onFatal ?? null
  let bootTimer: ReturnType<typeof setTimeout> | undefined
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

  // Advance the probe generation so any probe response still in flight is
  // dropped on arrival. Called whenever the cached frame is about to change.
  function invalidateProbes(): void {
    latestProbeSeq += 1
  }

  worker.onmessage = (
    event: MessageEvent<
      | RenderResponse
      | Ready
      | RenderError
      | ProgressResponse
      | Aborted
      | ProbeResponse
      | BootProgress
      | BootError
    >,
  ): void => {
    const msg = event.data
    if (msg.kind === 'boot') {
      // The worker's WASM module instantiated; the thread pool is next. Record
      // it so a later watchdog can blame the pool, not instantiation (#83).
      wasmInstantiated = true
      return
    }
    if (msg.kind === 'boot-error') {
      // A boot step threw and the worker caught it (a rejection in a module
      // worker's top-level async path never reaches `worker.onerror` reliably).
      // Surface the real cause instead of waiting out the watchdog.
      reportFatal(bootErrorMessage(msg))
      return
    }
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
    if (msg.kind === 'ready') {
      ready = true
      // Boot succeeded — the watchdog (if armed) must not later declare a
      // false failure.
      if (bootTimer !== undefined) {
        clearTimeout(bootTimer)
        bootTimer = undefined
      }
      flush()
      return
    }

    if (msg.kind === 'progress') {
      // A non-terminal heartbeat from a banded render (P2): it does NOT free
      // the slot. Drive the indicator only for the frame the user is still
      // waiting on — a heartbeat for an already-superseded render is ignored,
      // so a doomed frame never moves the bar.
      if (msg.epoch === latestEpoch) {
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
      flush()
      return
    }
    if (msg.kind === 'error') {
      // A render/recolorize threw inside the worker (a boundary-validation
      // JsError, or the recolorize-before-render guard). The worker stays
      // alive and idle, so this is recoverable: free the slot, log, and
      // dispatch whatever queued — a single dropped frame, not a permanent
      // freeze. The canvas keeps its last good frame.
      console.error(`render worker error (epoch ${msg.epoch}): ${msg.message}`)
      flush()
      return
    }
    // Paint it only if it is still the frame the user wants; then dispatch
    // whatever queued up while it ran.
    if (msg.epoch === latestEpoch && targetCtx !== null) {
      paint(targetCtx, msg, inFlightKind)
    }
    flush()
  }

  // A top-level throw in the worker (boot failure: WASM instantiation, or the
  // cross-origin-isolation gate in worker.ts) fires here, not `onmessage`. No
  // response will ever come, so mark the client dead and surface a fatal
  // panel. `preventDefault` suppresses the browser's default console spam,
  // which `reportFatal` (via console.error) already covers more legibly.
  worker.onerror = (event: ErrorEvent): void => {
    event.preventDefault()
    dead = true
    reportFatal(
      event.message ||
        'The render worker failed to start. The page may not be cross-origin ' +
          'isolated, which the multithreaded renderer requires (SharedArrayBuffer).',
    )
  }

  /**
   * Report an unrecoverable boot failure exactly once: mark the worker dead,
   * cancel the watchdog, log, and hand a human message to the host surface (if
   * injected). Idempotent so a worker.onerror and the watchdog can both fire
   * without double-reporting.
   */
  function reportFatal(message: string): void {
    if (bootTimer !== undefined) {
      clearTimeout(bootTimer)
      bootTimer = undefined
    }
    dead = true
    console.error(`render worker fatal: ${message}`)
    onFatal?.(message)
  }

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
    worker.postMessage(req)
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
    worker.postMessage(cancel)
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
    // Cancel the in-flight render only when a newer *render* makes it obsolete —
    // then the queued frame starts sooner instead of after the doomed one
    // finishes (P2). A queued recolorize is the opposite: it re-tints whatever
    // the in-flight render is computing, so it must let that render finish. (It
    // also must not abort it: an aborted render leaves a partial iteration buffer
    // that the recolorize would then read.) Once the render completes, the
    // recolorize dispatches against its whole, fresh buffer.
    if (pending?.kind === 'render') {
      postCancel()
    }
    flush()
  }

  /**
   * Discard any in-flight *or queued* render so it neither paints nor wastes
   * worker time. Bumping the epoch past everything outstanding makes the next
   * worker response fail the `epoch === latestEpoch` check in `onmessage`, so
   * an in-flight render is dropped on arrival; clearing the pending slot stops
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

  function paint(
    ctx: CanvasRenderingContext2D,
    response: RenderResponse,
    requestKind: ClientRequest['kind'] | null,
  ): void {
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
    // Clear any wheel-zoom Preview transform before painting (ADR-0012), but
    // only for a `render`. A render carries fresh geometry — the Settle frame,
    // a pan/resize commit, boot — so clearing it in the same tick as
    // `putImageData` makes the Preview→true-frame swap atomic (no snap-back)
    // without any callback back to the input layer. A `recolorize` is
    // different: it re-tints the *cached* (pre-scrub) buffer without moving it,
    // so if a palette change lands mid-scrub (within the settle window) the
    // Preview scale still applies to the same image — clearing the transform
    // would snap the frame to identity at the wrong scale until the Settle
    // render lands. So a recolorize leaves the transform for the render that
    // ends the scrub. Outside a scrub the transform is already '' and the guard
    // skips regardless, so this only ever matters while a Preview is live.
    if (requestKind === 'render' && canvas.style.transform !== '') {
      canvas.style.transform = ''
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
   * the worker with no cached buffer would throw there (the
   * programmer-error guard in the handler), which the fold rule makes
   * unreachable in normal dispatch ordering.
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
   * first band has already clobbered the cached frame with partial data), or
   * while a Preview transform is live (mid-gesture the buffer is stale — the
   * same paint-guard signal `paint` keys off). In those windows the inspector
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
    const canvas = targetCtx?.canvas
    if (canvas == null || canvas.style.transform !== '') {
      return false
    }
    latestProbeSeq += 1
    const req: ProbeRequest = { kind: 'probe', seq: latestProbeSeq, x, y, palette, mode }
    worker.postMessage(req)
    return true
  }

  // Arm the boot watchdog now, at construction — but only if a fatal surface
  // was injected. With no `onFatal` there is nothing to surface to, so a client
  // built without one leaves no stray timer running. The worker cannot have
  // reached `ready` or thrown yet (both are asynchronous), so this is the only
  // place the watchdog needs to arm.
  if (onFatal !== null) {
    bootTimer = setTimeout(() => {
      bootTimer = undefined
      if (ready) {
        return
      }
      // A timeout, not a thrown error — the worker hung rather than rejecting
      // (a rejection would have arrived as `boot-error`). Localise it with the
      // boot-stage heartbeat: if WASM instantiated, the rayon pool is what
      // never came up; if not, instantiation itself stalled.
      const where = wasmInstantiated
        ? 'its multithreaded worker pool did not come up'
        : 'the WebAssembly module did not finish loading'
      reportFatal(
        `The renderer did not start within ${BOOT_TIMEOUT_MS / 1000}s: ${where}. ` +
          'This can be an unsupported browser, lost cross-origin isolation ' +
          '(SharedArrayBuffer), or a stale cached build — try fully closing the ' +
          'tab and reopening, or reload in a private window.',
      )
    }, BOOT_TIMEOUT_MS)
  }

  return { render, recolorize, probe, discardInFlight }
}
