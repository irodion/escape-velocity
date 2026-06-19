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
 * `render-client.ts`).
 */
import type { Field, FractalKind, NormalizationMode, Palette } from '../../wasm/fractal_wasm.js'

export type { Field, FractalKind, NormalizationMode, Palette }

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
  // The Field (ADR-0013) is a compute-class input: it selects what scalar
  // `compute` emits, so it rides on the render request only — a
  // RecolorizeRequest reuses the cached buffer and never changes Field.
  readonly field: Field
}

export interface RecolorizeRequest {
  readonly kind: 'recolorize'
  readonly epoch: number
  readonly palette: Palette
  readonly mode: NormalizationMode
}

/**
 * Read one pixel of the cached Field buffer for the pixel inspector (E2,
 * #95) — "why is this pixel this colour?". The worker reads a single `f32`
 * from the recolorize cache (no recompute) and traces it through the current
 * `palette` / `mode`, returning the raw value, the normalised `t`, and the
 * painted colour.
 *
 * It carries a `seq`, **not** an `epoch`: a probe is a read-only side query
 * that never enters the render-client's single-slot coalescing and never
 * supersedes a render. The worker echoes `seq` back so the client can drop a
 * probe response older than the latest it issued (hover fires many). `x` / `y`
 * are render-buffer pixel coordinates (row-major `y * width + x`).
 */
export interface ProbeRequest {
  readonly kind: 'probe'
  readonly seq: number
  readonly x: number
  readonly y: number
  readonly palette: Palette
  readonly mode: NormalizationMode
}

/**
 * The traced pixel (see {@link ProbeRequest}). `raw` is the cached Field
 * scalar (smooth `nu`, distance `d`, or `NaN` inside the set); `inside` is
 * `true` iff that sentinel, in which case `t` is `NaN` and the swatch is
 * black. `t ∈ [0, 1]` is where `raw` landed after the current normalisation,
 * and `r` / `g` / `b` is the colour that pixel was painted — matching the
 * on-screen pixel exactly (same palette LUT the frame used).
 */
export interface ProbeResponse {
  readonly kind: 'probe-response'
  readonly seq: number
  readonly raw: number
  readonly t: number
  readonly inside: boolean
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface Ready {
  readonly kind: 'ready'
}

/**
 * A lightweight "a newer request exists" signal the client posts when it
 * supersedes a render that is already on the worker (P2, #78).
 *
 * The client's coalescing keeps a single in-flight request and a single
 * pending slot, and never sends the *next* request until the in-flight one
 * responds — so without this the worker would never learn that the frame it
 * is grinding through is already stale, and would run the whole doomed
 * `compute` to completion before the user's latest viewport could even
 * start. A `cancel` carries the latest epoch the client has issued; the
 * worker tracks the maximum epoch it has *seen* across all messages and, on
 * a banded render, abandons the remaining bands the moment that exceeds the
 * in-flight render's own epoch. It frees the slot the same way a response
 * does, via an {@link Aborted} reply.
 *
 * It is intentionally tiny (no payload beyond the epoch) and safe to drop:
 * if the worker never sees it (e.g. a fast render finishes first) the frame
 * just completes normally and the epoch check on the client discards the
 * stale paint, exactly as before.
 */
export interface CancelRequest {
  readonly kind: 'cancel'
  readonly epoch: number
}

/**
 * A request that threw inside the worker. The worker wraps `handleMessage`
 * in a try/catch and posts this instead of a `RenderResponse`, echoing the
 * failed request's `epoch` so the client can match it to the in-flight slot.
 *
 * Without it a throw posts *nothing*: the client's `inFlight` flag (set in
 * `flush`, cleared only in `onmessage`) stays true forever, so every later
 * request parks in the pending slot and the canvas silently never updates
 * again. This arm converts that permanent freeze into a single dropped
 * frame — the client frees the slot, logs, and dispatches the next request.
 */
export interface RenderError {
  readonly kind: 'error'
  readonly epoch: number
  readonly message: string
}

/**
 * Progress heartbeat posted between bands of a banded render (P2, #78), so
 * the client can drive a determinate "rendering NN%" indicator on a slow
 * deep render. `rowsDone` is the count of frame rows computed so far,
 * `rowsTotal` the frame height; their ratio is the fraction complete.
 *
 * Carries no pixels — partial bands are never painted (painting them would
 * show seams under the global-normalisation modes, which key off the whole
 * frame's statistics). The `epoch` lets the client ignore progress for a
 * frame it has already moved past; a render that completes before its first
 * band reports never shows the indicator at all (the client debounces).
 */
export interface ProgressResponse {
  readonly kind: 'progress'
  readonly epoch: number
  readonly rowsDone: number
  readonly rowsTotal: number
}

/**
 * Sent when a banded render abandons its remaining bands because a newer
 * request superseded it (see {@link CancelRequest}). It carries no frame —
 * the point is that this frame was thrown away — but it MUST be sent so the
 * client frees its in-flight slot and dispatches the pending request, the
 * same slot-freeing role a {@link RenderResponse} or {@link RenderError}
 * plays. Without it the aborted render would wedge the pipeline exactly like
 * a silent worker throw (the freeze {@link RenderError} guards against).
 */
export interface Aborted {
  readonly kind: 'aborted'
  readonly epoch: number
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
  //
  // Pinned to a non-shared `ArrayBuffer` (not the default
  // `ArrayBufferLike`): the bytes are always a fresh standalone copy, and
  // `ImageData` / `Transferable` both reject `SharedArrayBuffer`-backed
  // views. When the rayon slice (ADR-0007) introduces a shared heap, the
  // copy-out step keeps this response buffer non-shared regardless.
  readonly rgba: Uint8ClampedArray<ArrayBuffer>
  readonly width: number
  readonly height: number
}
