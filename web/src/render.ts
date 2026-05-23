import {
  colorize,
  colorize_len,
  compute,
  compute_len,
  type InitOutput,
  type Viewport,
} from '../wasm/fractal_wasm.js'

const MAX_ITER = 256

/**
 * Run one compute → colorize → putImageData cycle.
 *
 * Strictly sequential by design: the JS↔WASM buffer-lifetime
 * invariant (see `fractal-wasm/src/lib.rs`) relies on no second
 * `compute`/`colorize` overlapping the first. Slice 2's input layer
 * never invokes this concurrently — every `onChange` produces a
 * synchronous render that finishes before the next event lands.
 */
export function render(viewport: Viewport, ctx: CanvasRenderingContext2D, wasm: InitOutput): void {
  const iterPtr = compute(viewport, MAX_ITER)
  const iterLen = compute_len()
  const rgbaPtr = colorize(iterPtr, iterLen, MAX_ITER)
  const rgbaLen = colorize_len()

  // View into WASM linear memory — no copy. ImageData wraps the same
  // buffer; putImageData reads it synchronously, so the view's lifetime
  // only needs to outlive this call.
  const rgba = new Uint8ClampedArray(wasm.memory.buffer, rgbaPtr, rgbaLen)
  const image = new ImageData(rgba, ctx.canvas.width, ctx.canvas.height)
  ctx.putImageData(image, 0, 0)
}
