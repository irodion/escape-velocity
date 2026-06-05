import type {
  FractalKind,
  NormalizationMode,
  Palette,
  Ready,
  RecolorizeRequest,
  RenderRequest,
  RenderResponse,
} from './worker/protocol.js'

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

// Vite rewrites this `new Worker(new URL(...))` form into a bundled
// module-worker URL at build time, so the worker and its WASM ship as
// their own chunk. `import.meta.url` anchors the relative path to this
// module.
const worker = new Worker(new URL('./worker/worker.ts', import.meta.url), { type: 'module' })

type ClientRequest = RenderRequest | RecolorizeRequest

let latestEpoch = 0
let inFlight = false
let pending: ClientRequest | null = null
let ready = false
// The canvas context to paint the next fresh response onto. Only the
// latest-epoch response paints, and `targetCtx` always tracks the
// latest request's context, so a single reference suffices (in practice
// it is the one canvas for the page's lifetime).
let targetCtx: CanvasRenderingContext2D | null = null

worker.onmessage = (event: MessageEvent<RenderResponse | Ready>): void => {
  const msg = event.data
  if (msg.kind === 'ready') {
    ready = true
    flush()
    return
  }

  // Ignore a response with nothing outstanding — there is no request it
  // could belong to (e.g. a stray message before `ready`). Without this
  // guard a spurious response could paint a frame that was never
  // dispatched.
  if (!inFlight) {
    return
  }
  // A response frees the worker. Paint it only if it is still the frame
  // the user wants; then dispatch whatever queued up while it ran.
  inFlight = false
  if (msg.epoch === latestEpoch && targetCtx !== null) {
    paint(targetCtx, msg)
  }
  flush()
}

/**
 * Dispatch the pending request if the worker is ready and idle. A no-op
 * when still booting, busy, or nothing is queued — the response handler
 * and the `ready` handler both call it, so a queued request is never
 * stranded.
 */
function flush(): void {
  if (!ready || inFlight || pending === null) {
    return
  }
  inFlight = true
  const req = pending
  pending = null
  worker.postMessage(req)
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
  if (req.kind === 'recolorize' && pending !== null && pending.kind === 'render') {
    // Keep the queued render's compute (its newer viewport); swap only
    // the colours it will be painted with. Bump the epoch onto the
    // merged render so its eventual response is recognised as the latest
    // frame and paints.
    pending = { ...pending, palette: req.palette, mode: req.mode, epoch: latestEpoch }
  } else {
    pending = { ...req, epoch: latestEpoch }
  }
  flush()
}

function paint(ctx: CanvasRenderingContext2D, response: RenderResponse): void {
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
  // Clear any wheel-zoom Preview transform before painting (ADR-0012).
  // Every real frame is correct at identity transform — Settle, recolorize,
  // resize, boot alike — so clearing it unconditionally here, in the same
  // tick as `putImageData`, makes the Preview→true-frame swap atomic (no
  // snap-back) without any callback back to the input layer. The guard
  // avoids a needless style write on the common identity-already case.
  if (canvas.style.transform !== '') {
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
export function render(
  viewport: { centerRe: number; centerIm: number; zoom: number; width: number; height: number },
  ctx: CanvasRenderingContext2D,
  maxIter: number,
  palette: Palette,
  mode: NormalizationMode,
  kind: FractalKind,
  cRe: number,
  cIm: number,
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
export function recolorize(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  mode: NormalizationMode,
): void {
  issue({ kind: 'recolorize', epoch: 0, palette, mode }, ctx)
}
