/**
 * The render worker's deep module: turns a protocol message into an RGBA
 * response, with zero DOM / `self` / `postMessage` coupling. Every dependency
 * is on the imported WASM functions, the `InitOutput` memory handle passed in,
 * and the protocol types — so the whole module is exercisable in isolation
 * with mocked WASM.
 *
 * It holds no state. The ADR-0002 iteration-buffer cache lives in the WASM
 * module (#158), which records which frame its buffer holds and refuses to
 * colour or probe one whose bands haven't all landed — so a render abandoned
 * partway can never be painted, and there is nothing here to reset. The
 * banded render path (P2, #78) keeps its side effects out too: yield,
 * abort-check and progress arrive as injected {@link RenderHooks} rather than
 * touching `self` / `postMessage`.
 */
import {
  colorize,
  colorize_len,
  compute_band,
  frame_height,
  frame_width,
  type InitOutput,
  probe_pixel,
  Viewport,
} from '../../wasm/fractal_wasm.js'
import type {
  ProbeRequest,
  ProbeResponse,
  RecolorizeRequest,
  RenderRequest,
  RenderResponse,
} from './protocol.js'

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
 * response + transfer list, or `{ aborted: true }` if a newer request
 * superseded it mid-flight.
 *
 * It reconstructs a fresh `Viewport` from the flat primitives (cheap; no
 * shared state to leak across realms) and computes the iteration buffer one
 * band at a time via {@link compute_band}, which fills the WASM module's
 * buffer in place. Between bands it reports progress, yields (so a queued
 * `cancel` is seen), and bails the instant `shouldAbort()` turns true — so a
 * doomed deep render stops within a band instead of blocking the worker for
 * seconds. Once every band is in, it `colorize`s the whole buffer **once**
 * (keeping the global-normalisation modes correct — no per-band seams); the
 * frame stays cached in WASM for a later recolorize or probe.
 *
 * The RGBA bytes are copied OUT of WASM linear memory into a fresh
 * `Uint8ClampedArray` before transfer: transferring a view that aliases WASM
 * memory would detach the worker's entire heap; the copy neuters only the
 * standalone result on send.
 */
export async function handleRender(
  msg: RenderRequest,
  wasm: InitOutput,
  hooks: RenderHooks,
): Promise<{ response: RenderResponse; transfer: Transferable[] } | { aborted: true }> {
  const viewport = new Viewport(msg.centerRe, msg.centerIm, msg.zoom, msg.width, msg.height)
  const bands = planBands(msg.height)
  for (let i = 0; i < bands.length; i += 1) {
    const [y0, y1] = bands[i]
    compute_band(viewport, msg.maxIter, msg.fractalKind, msg.cRe, msg.cIm, msg.field, y0, y1)
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

  const rgba = paint(wasm, msg.palette, msg.mode)
  const response: RenderResponse = {
    kind: 'response',
    epoch: msg.epoch,
    rgba,
    width: msg.width,
    height: msg.height,
  }
  return { response, transfer: [rgba.buffer] }
}

/**
 * Re-colorize the cached iteration buffer with a new palette / mode — the
 * ADR-0002 fast path, no recompute — echoing the cached frame's dimensions (a
 * recolorize carries none). Throws the WASM `colorize` error when there is no
 * complete frame to colour (before the first render, or after one was
 * abandoned partway); the worker reports it as a recoverable `error`.
 * Synchronous: there is no per-band work to cancel, so the worker runs it
 * straight through.
 */
export function handleRecolorize(
  msg: RecolorizeRequest,
  wasm: InitOutput,
): { response: RenderResponse; transfer: Transferable[] } {
  const rgba = paint(wasm, msg.palette, msg.mode)
  const response: RenderResponse = {
    kind: 'response',
    epoch: msg.epoch,
    rgba,
    width: frame_width(),
    height: frame_height(),
  }
  return { response, transfer: [rgba.buffer] }
}

/**
 * Read one pixel of the cached Field buffer for the pixel inspector (E2,
 * #95) — no recompute. The WASM `probe_pixel` traces it through the probe's
 * `palette` / `mode`, reusing the normalisation context the last `colorize`
 * cached so a hover is O(1) for the global / Histogram modes, and clamps
 * `(x, y)` into the frame so an edge or slightly-stale coordinate can never
 * index out of range.
 *
 * Returns `undefined` when there is no complete frame to read (just after a
 * render was abandoned partway): the worker then sends no reply, and the
 * inspector keeps its last reading rather than showing one that describes no
 * frame.
 */
export function handleProbe(msg: ProbeRequest): ProbeResponse | undefined {
  // `probe_pixel` returns a wasm-bindgen class wrapping WASM memory; read its
  // fields into a plain response (the class can't survive `postMessage`) and
  // free it so the handle doesn't leak across the constant hover traffic.
  const result = probe_pixel(msg.x | 0, msg.y | 0, msg.palette, msg.mode)
  if (result === undefined) {
    return undefined
  }
  try {
    return {
      kind: 'probe-response',
      seq: msg.seq,
      raw: result.raw,
      t: result.t,
      inside: result.inside,
      r: result.r,
      g: result.g,
      b: result.b,
    }
  } finally {
    result.free()
  }
}

/**
 * Colorize the cached frame and return the RGBA bytes copied out of WASM
 * linear memory into a standalone buffer fit for transfer.
 */
function paint(
  wasm: InitOutput,
  palette: RenderRequest['palette'],
  mode: RenderRequest['mode'],
): Uint8ClampedArray<ArrayBuffer> {
  const rgbaPtr = colorize(palette, mode)
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
