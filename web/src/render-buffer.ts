/**
 * Pure sizing for the render buffer (Slice 2 fit-to-window).
 *
 * The viewport's logical dimensions are the canvas's CSS box — the
 * window area the canvas occupies. The render buffer is that logical
 * size scaled by the render-scale multiplier (a quality knob), then
 * bounded by a pixel budget so a huge / HiDPI window cannot hand the
 * single-worker CPU renderer (ADR-0001) an unbounded amount of work.
 *
 * When `logical × renderScale` exceeds the budget, the buffer is shrunk
 * uniformly to fit — square pixels are preserved, so the framing is
 * unchanged and only the sample density drops; CSS then upscales the
 * smaller buffer to fill the window (slightly soft, never frozen).
 *
 * The returned `scale` is the *effective* multiplier actually applied
 * (≤ `renderScale` once the budget bites). The render seam multiplies
 * the request's `zoom` by this same effective scale so the buffer —
 * whatever its final size — covers the same window (see ADR-0011: pixel
 * scale is keyed to a fixed reference width, so buffer dimensions and
 * zoom must move together to hold the framing).
 */
export interface BufferDims {
  /** Render-buffer width in device pixels (≥ 1). */
  readonly width: number
  /** Render-buffer height in device pixels (≥ 1). */
  readonly height: number
  /** Effective scale actually applied (≤ the requested renderScale). */
  readonly scale: number
}

/**
 * Compute the render-buffer dimensions for a logical (CSS) size.
 *
 * Degenerate logical sizes (0, NaN, negative — e.g. a `display:none` or
 * pre-layout canvas) are floored to 1×1 so the WASM seam never sees a
 * zero dimension.
 */
export function computeBufferDims(
  logicalWidth: number,
  logicalHeight: number,
  renderScale: number,
  maxPixels: number,
): BufferDims {
  const w = Math.max(1, Math.floor(logicalWidth || 0))
  const h = Math.max(1, Math.floor(logicalHeight || 0))

  let scale = renderScale
  const requestedPixels = w * h * scale * scale
  if (requestedPixels > maxPixels) {
    // Uniform shrink so width·height lands exactly on the budget while
    // preserving the logical aspect ratio (and therefore square pixels).
    scale *= Math.sqrt(maxPixels / requestedPixels)
  }

  // Floor (not round) the dimensions so `width × height` is guaranteed
  // never to exceed the pixel budget — the cap is a hard ceiling on the
  // single-worker renderer's per-frame work, and a round-up could nudge
  // it over.
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
    scale,
  }
}
