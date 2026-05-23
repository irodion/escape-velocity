import {
  colorize,
  colorize_len,
  compute,
  compute_len,
  type FractalKind,
  type InitOutput,
  type NormalizationMode,
  type Palette,
  type Viewport,
} from '../wasm/fractal_wasm.js'

/**
 * The iteration buffer's `(ptr, len)` and the `maxIter` value used to
 * produce it. `recolorize` reads this cache and feeds the same trio
 * into `colorize` without re-iterating.
 *
 * The cache lives in `render.ts` (not `main.ts`) because the
 * "iteration buffer is still valid" invariant is a property of the
 * render layer's interaction with WASM — the moment `compute` runs
 * again the underlying `Vec<f32>` is rewritten and any cached pointer
 * is invalidated. Keeping the cache adjacent to the only function
 * that re-runs `compute` makes that lifetime locally inspectable.
 */
let cachedIterPtr: number | null = null
let cachedIterLen = 0
let cachedMaxIter = 0

/**
 * Run one compute → colorize → putImageData cycle and cache the
 * iteration-buffer handle for a later `recolorize`.
 *
 * Strictly sequential by design: the JS↔WASM buffer-lifetime
 * invariant (see `fractal-wasm/src/lib.rs`) relies on no second
 * `compute`/`colorize` overlapping the first, and on a cached
 * `(ptr, len)` pair never outliving the next `compute`. The input
 * layer never invokes this concurrently — every `onChange` produces a
 * synchronous render that finishes before the next event lands.
 */
export function render(
  viewport: Viewport,
  ctx: CanvasRenderingContext2D,
  wasm: InitOutput,
  maxIter: number,
  palette: Palette,
  mode: NormalizationMode,
  kind: FractalKind,
  cRe: number,
  cIm: number,
): void {
  const iterPtr = compute(viewport, maxIter, kind, cRe, cIm)
  const iterLen = compute_len()
  cachedIterPtr = iterPtr
  cachedIterLen = iterLen
  cachedMaxIter = maxIter
  paint(ctx, wasm, iterPtr, iterLen, maxIter, palette, mode)
}

/**
 * Re-colorize the most recently computed iteration buffer with new
 * palette / normalisation settings. No `compute` runs.
 *
 * Must be preceded by at least one `render(...)` call — otherwise
 * there is no cached `(iterPtr, iterLen)` to colorize against, and a
 * stray call indicates a dispatcher bug rather than a runtime
 * branch. Throwing a clear programmer-error makes that latent
 * mis-wiring loud at the call site instead of silently sampling
 * unmapped WASM memory.
 */
export function recolorize(
  ctx: CanvasRenderingContext2D,
  wasm: InitOutput,
  palette: Palette,
  mode: NormalizationMode,
): void {
  if (cachedIterPtr === null) {
    throw new Error('recolorize: no cached iteration buffer — call render(...) first')
  }
  paint(ctx, wasm, cachedIterPtr, cachedIterLen, cachedMaxIter, palette, mode)
}

function paint(
  ctx: CanvasRenderingContext2D,
  wasm: InitOutput,
  iterPtr: number,
  iterLen: number,
  maxIter: number,
  palette: Palette,
  mode: NormalizationMode,
): void {
  const rgbaPtr = colorize(iterPtr, iterLen, palette, mode, maxIter)
  const rgbaLen = colorize_len()

  // View into WASM linear memory — no copy. ImageData wraps the same
  // buffer; putImageData reads it synchronously, so the view's lifetime
  // only needs to outlive this call.
  const rgba = new Uint8ClampedArray(wasm.memory.buffer, rgbaPtr, rgbaLen)
  const image = new ImageData(rgba, ctx.canvas.width, ctx.canvas.height)
  ctx.putImageData(image, 0, 0)
}
