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
 * keeps a single pending slot — at most one queued request — and a
 * newer request overwrites the older. When the in-flight response
 * returns, only the latest queued request is dispatched; everything in
 * between is dropped. The user always converges on the last viewport
 * they actually asked for.
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
 * Stamp a request with the next epoch, record its target context, and
 * place it in the single pending slot (overwriting any older queued
 * request — that's the coalescing), then try to flush.
 */
function issue(req: ClientRequest, ctx: CanvasRenderingContext2D): void {
  latestEpoch += 1
  pending = { ...req, epoch: latestEpoch }
  targetCtx = ctx
  flush()
}

function paint(ctx: CanvasRenderingContext2D, response: RenderResponse): void {
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
 * forget, same coalescing as `render`. Relies on the worker having
 * rendered at least once; a recolorize that reaches the worker with no
 * cached buffer throws there (the programmer-error guard in the
 * handler), which surfaces as an unhandled worker error rather than a
 * silent no-op.
 */
export function recolorize(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  mode: NormalizationMode,
): void {
  issue({ kind: 'recolorize', epoch: 0, palette, mode }, ctx)
}
