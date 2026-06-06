import {
  colorize,
  colorize_len,
  compute,
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
 * top-level state and makes each `handleMessage` call independently
 * testable.
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

/**
 * Turn one protocol message into an RGBA response plus the updated
 * cache state and the transfer list for `postMessage`.
 *
 * `render` reconstructs a fresh `Viewport` from the flat primitives
 * (cheap; no shared state to leak across realms), runs
 * `compute → colorize`, and caches the iteration-buffer handle for a
 * later recolorize. `recolorize` reuses the cached `(ptr, len, maxIter)`
 * and skips `compute` — the fast-path payoff of ADR-0002 — and throws a
 * clear programmer-error if no render has populated the cache yet, the
 * same guard `render.ts` carries today.
 *
 * In both cases the RGBA bytes are copied OUT of WASM linear memory into
 * a fresh `Uint8ClampedArray` before being returned in `transfer`.
 * Transferring a view that aliases WASM memory would detach the worker's
 * entire WASM heap; the copy means only the standalone RGBA buffer is
 * neutered on send.
 */
export function handleMessage(
  state: WorkerState,
  msg: RenderRequest | RecolorizeRequest,
  wasm: InitOutput,
): { state: WorkerState; response: RenderResponse; transfer: Transferable[] } {
  if (msg.kind === 'render') {
    const viewport = new Viewport(msg.centerRe, msg.centerIm, msg.zoom, msg.width, msg.height)
    const iterPtr = compute(viewport, msg.maxIter, msg.fractalKind, msg.cRe, msg.cIm, msg.field)
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
  // Cache survives a recolorize: the iteration buffer is unchanged, so a
  // subsequent recolorize can reuse it. State is returned verbatim.
  return { state, response, transfer: [rgba.buffer] }
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
