import {
  colorize,
  colorize_len,
  compute_band,
  compute_len,
  type InitOutput,
  Viewport,
} from '../../wasm/fractal_wasm.js'
import type { RecolorizeRequest, RenderRequest, RenderResponse } from './protocol.js'

/**
 * The render worker's deep module: owns the ADR-0002 iteration-buffer
 * cache (lifted out of `web/src/render.ts`) and turns a protocol
 * message into an RGBA response, with zero DOM / `self` / `postMessage`
 * coupling. Every dependency is on the imported WASM functions, the
 * `InitOutput` memory handle passed in, and the protocol types — so the
 * whole module is exercisable in isolation with mocked WASM.
 *
 * The cache lives here for the same reason it lived in `render.ts`: the
 * "iteration buffer is still valid" invariant is a property of this
 * layer's interaction with WASM. The instant `compute` runs again the
 * underlying `Vec<f32>` is rewritten and any cached pointer is
 * invalidated, so keeping the cache adjacent to the only call site that
 * re-runs `compute` keeps that lifetime locally inspectable.
 *
 * State is threaded explicitly rather than held at module scope: the
 * worker bootstrap (#30) keeps a single `WorkerState` and feeds each
 * message's result back in, which keeps this module free of mutable
 * top-level state and makes each `handleRender` / `handleRecolorize` call
 * independently testable. The banded render path (P2, #78) keeps the same
 * isolation by taking its side effects — yield, abort-check, progress — as
 * injected {@link RenderHooks} rather than touching `self` / `postMessage`.
 */
export interface WorkerState {
  /** Pointer into WASM linear memory for the cached iteration buffer,
   *  or `null` before the first render. */
  readonly cachedIterPtr: number | null
  /** Element count of the cached iteration buffer (one f32 per pixel). */
  readonly cachedIterLen: number
  /** `maxIter` the cached buffer was computed with — fed back into
   *  `colorize` on a recolorize so normalisation matches the buffer. */
  readonly cachedMaxIter: number
  /** Canvas dimensions of the cached render. A `RecolorizeRequest`
   *  carries no dimensions (resolution changes are compute-class and go
   *  through render), so the recolorize response echoes these cached
   *  dims back to the client. */
  readonly cachedWidth: number
  readonly cachedHeight: number
}

export function createWorkerState(): WorkerState {
  return {
    cachedIterPtr: null,
    cachedIterLen: 0,
    cachedMaxIter: 0,
    cachedWidth: 0,
    cachedHeight: 0,
  }
}

/** How many bands to split a frame into (P2, #78). The worker yields to its
 *  event loop between bands and can abandon the rest when a newer viewport
 *  supersedes the in-flight one, so this sets the cancellation granularity:
 *  more bands = a doomed render stops sooner, at the cost of one extra
 *  WASM call + yield + progress post each. ~12 keeps per-band overhead
 *  negligible while bounding the worst-case wasted work to ~1/12 of a frame. */
const TARGET_BANDS = 12

/**
 * Split a frame of `height` rows into a contiguous partition of at most
 * {@link TARGET_BANDS} horizontal bands, each `[y0, y1)`. Bands are at least
 * one row tall (a short frame yields fewer bands, never empty ones) and the
 * last band absorbs the remainder. Pure and total — exported for testing.
 */
export function planBands(height: number): Array<readonly [number, number]> {
  const bandCount = Math.min(TARGET_BANDS, Math.max(1, height))
  const bandRows = Math.ceil(height / bandCount)
  const bands: Array<readonly [number, number]> = []
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    bands.push([y0, Math.min(y0 + bandRows, height)] as const)
  }
  return bands
}

/**
 * Side-effecting hooks the worker injects into {@link handleRender} so this
 * module stays free of `self` / `postMessage` / timer coupling (the same
 * "deep, isolated" property the synchronous path had).
 */
export interface RenderHooks {
  /** Yield a macrotask so queued worker messages (a `cancel`) are observed. */
  readonly yieldToEventLoop: () => Promise<void>
  /** True once a newer request has superseded this render — abandon the rest. */
  readonly shouldAbort: () => boolean
  /** Report rows computed so far, to drive a determinate progress indicator. */
  readonly onProgress: (rowsDone: number, rowsTotal: number) => void
}

/**
 * Render a frame in cancellable bands (P2, #78), returning the RGBA
 * response + updated cache state + transfer list, or `{ aborted: true }` if
 * a newer request superseded it mid-flight.
 *
 * It reconstructs a fresh `Viewport` from the flat primitives (cheap; no
 * shared state to leak across realms) and computes the iteration buffer one
 * band at a time via {@link compute_band}, which accumulates into the shared
 * WASM buffer. Between bands it reports progress, yields (so a queued
 * `cancel` is seen), and bails the instant `shouldAbort()` turns true — so a
 * doomed deep render stops within a band instead of blocking the worker for
 * seconds. Once every band is in, it `colorize`s the whole buffer **once**
 * (keeping the global-normalisation modes correct — no per-band seams) and
 * caches the `(ptr, len, maxIter, dims)` handle for a later recolorize.
 *
 * The RGBA bytes are copied OUT of WASM linear memory into a fresh
 * `Uint8ClampedArray` before transfer: transferring a view that aliases WASM
 * memory would detach the worker's entire heap; the copy neuters only the
 * standalone result on send.
 */
export async function handleRender(
  // A render rebuilds the whole iteration buffer, so it ignores the prior
  // cache state and produces fresh state below. The parameter is kept for
  // signature symmetry with `handleRecolorize` and the worker's call site.
  _state: WorkerState,
  msg: RenderRequest,
  wasm: InitOutput,
  hooks: RenderHooks,
): Promise<
  { state: WorkerState; response: RenderResponse; transfer: Transferable[] } | { aborted: true }
> {
  const viewport = new Viewport(msg.centerRe, msg.centerIm, msg.zoom, msg.width, msg.height)
  const bands = planBands(msg.height)
  // `compute_band` returns the (stable) buffer pointer on every call; the
  // first band (y0 === 0) sizes the buffer to the whole frame so it never
  // moves while later bands fill in. Read the final pointer for colorize.
  let iterPtr = 0
  for (let i = 0; i < bands.length; i += 1) {
    const [y0, y1] = bands[i]
    iterPtr = compute_band(
      viewport,
      msg.maxIter,
      msg.fractalKind,
      msg.cRe,
      msg.cIm,
      msg.field,
      y0,
      y1,
    )
    hooks.onProgress(y1, msg.height)
    // Yield + abort-check between bands only — not after the last band, which
    // flows straight into colorize, and not before the first, which can never
    // already be stale (the render started this turn).
    if (i < bands.length - 1) {
      await hooks.yieldToEventLoop()
      if (hooks.shouldAbort()) {
        return { aborted: true }
      }
    }
  }

  const iterLen = compute_len()
  const nextState: WorkerState = {
    cachedIterPtr: iterPtr,
    cachedIterLen: iterLen,
    cachedMaxIter: msg.maxIter,
    cachedWidth: msg.width,
    cachedHeight: msg.height,
  }
  const rgba = paint(wasm, iterPtr, iterLen, msg.maxIter, msg.palette, msg.mode)
  const response: RenderResponse = {
    kind: 'response',
    epoch: msg.epoch,
    rgba,
    width: msg.width,
    height: msg.height,
  }
  return { state: nextState, response, transfer: [rgba.buffer] }
}

/**
 * Re-colorize the cached iteration buffer with a new palette / mode — the
 * ADR-0002 fast path, no recompute. Reuses the cached `(ptr, len, maxIter)`
 * and echoes the cached dimensions (a recolorize carries none). Throws a
 * clear programmer-error if no render has populated the cache yet, the same
 * guard `render.ts` carried. Synchronous: there is no per-band work to
 * cancel, so the worker runs it straight through.
 */
export function handleRecolorize(
  state: WorkerState,
  msg: RecolorizeRequest,
  wasm: InitOutput,
): { response: RenderResponse; transfer: Transferable[] } {
  if (state.cachedIterPtr === null) {
    throw new Error('recolorize: no cached iteration buffer — call render(...) first')
  }
  const rgba = paint(
    wasm,
    state.cachedIterPtr,
    state.cachedIterLen,
    state.cachedMaxIter,
    msg.palette,
    msg.mode,
  )
  const response: RenderResponse = {
    kind: 'response',
    epoch: msg.epoch,
    rgba,
    width: state.cachedWidth,
    height: state.cachedHeight,
  }
  return { response, transfer: [rgba.buffer] }
}

/**
 * Colorize `(iterPtr, iterLen)` and return the RGBA bytes copied out of
 * WASM linear memory into a standalone buffer fit for transfer.
 */
function paint(
  wasm: InitOutput,
  iterPtr: number,
  iterLen: number,
  maxIter: number,
  palette: RenderRequest['palette'],
  mode: RenderRequest['mode'],
): Uint8ClampedArray<ArrayBuffer> {
  const rgbaPtr = colorize(iterPtr, iterLen, palette, mode, maxIter)
  const rgbaLen = colorize_len()
  // `view` aliases WASM linear memory, whose buffer is `ArrayBufferLike`
  // (it becomes `SharedArrayBuffer` once the rayon slice enables shared
  // memory). Copy into a freshly-allocated, non-shared `ArrayBuffer` so
  // the result is safe to both `postMessage`-transfer and feed to
  // `ImageData` on the client — neither accepts a shared-backed view —
  // and the transfer detaches only this copy, never the WASM heap.
  const view = new Uint8ClampedArray(wasm.memory.buffer, rgbaPtr, rgbaLen)
  const out = new Uint8ClampedArray(rgbaLen)
  out.set(view)
  return out
}
