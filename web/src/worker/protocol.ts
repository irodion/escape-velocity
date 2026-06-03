/**
 * Wire-protocol types for the Slice 6 render worker.
 *
 * The main thread and the worker each own an independent WASM instance.
 * Wasm-bindgen-generated class instances (e.g. `Viewport`) cannot
 * survive `postMessage`: structured-clone preserves shape but breaks
 * class identity across realms, and the wasm-bindgen prototype
 * machinery cannot be reattached on the receiving side. So the main
 * thread flattens its `Viewport` into the five primitives below (via
 * the wasm getters added alongside this file) and the worker
 * reconstructs a fresh `Viewport` against its own WASM instance.
 *
 * Both ends import the protocol types from this single module so the
 * wire shape cannot drift. `Palette` / `NormalizationMode` /
 * `FractalKind` are re-exported from the wasm bindings as **types
 * only** — the values live on each side's own WASM module, but the
 * shared identity comes from the same `.d.ts`. Keep this file pure
 * `import type` so no wasm module loads as a side effect of importing
 * the protocol.
 *
 * `epoch` is a monotonic per-request counter owned by the render-client.
 * The worker echoes the request's `epoch` back on every `RenderResponse`
 * so the client can drop stale responses after the user has issued a
 * newer pan/zoom/parameter change (single-slot coalescing — see
 * `render-client.ts` once #30 lands).
 */
import type { FractalKind, NormalizationMode, Palette } from '../../wasm/fractal_wasm.js'

export type { FractalKind, NormalizationMode, Palette }

export interface RenderRequest {
  readonly kind: 'render'
  readonly epoch: number
  readonly width: number
  readonly height: number
  readonly centerRe: number
  readonly centerIm: number
  readonly zoom: number
  readonly maxIter: number
  readonly palette: Palette
  readonly mode: NormalizationMode
  readonly fractalKind: FractalKind
  readonly cRe: number
  readonly cIm: number
}

export interface RecolorizeRequest {
  readonly kind: 'recolorize'
  readonly epoch: number
  readonly palette: Palette
  readonly mode: NormalizationMode
}

export interface Ready {
  readonly kind: 'ready'
}

export interface RenderResponse {
  readonly kind: 'response'
  readonly epoch: number
  // The buffer is transferred via `postMessage(msg, [rgba.buffer])` so
  // the worker's copy is detached after send; on the receive side it
  // arrives zero-copy and can be handed straight to `putImageData`.
  // Must be copied OUT of WASM linear memory before transfer — sending
  // a view that aliases WASM memory would detach the worker's entire
  // WASM heap.
  readonly rgba: Uint8ClampedArray
  readonly width: number
  readonly height: number
}
