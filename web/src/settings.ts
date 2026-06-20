/**
 * The frontend's domain vocabulary: the form's value unions, the
 * `Settings` snapshot they compose into, and the iteration-stop table.
 *
 * This is a leaf module with no runtime imports — `controls.ts` (the DOM
 * wiring), `field-modes.ts` (the Field × Normalisation policy),
 * `settings-transition.ts` (the change classifier), `wasm-enums.ts` (the
 * name → wasm-enum tables), and `main.ts` all import their vocabulary from
 * here. Keeping the types in a leaf is what breaks the old
 * `controls → field-modes → controls` import cycle: `field-modes.ts` now
 * depends on this module instead of reaching back into `controls.ts`.
 */

export type PaletteName =
  | 'grayscale'
  | 'viridis'
  | 'magma'
  | 'inferno'
  | 'plasma'
  | 'turbo'
  | 'cubehelix'
  | 'twilight'
  | 'earth-and-sky'
  | 'rainbow'
  | 'kahol-lavan'
  | 'ocean'
  | 'solar'
  | 'spectral'
  | 'cosmic'
  | 'phosphor'
  | 'amber'
export type NormalisationName =
  | 'cycled'
  | 'histogram'
  | 'linear'
  | 'sqrt'
  | 'logarithmic'
  | 'clamped'
export type FractalMode = 'mandelbrot' | 'julia'
/**
 * The Field axis (ADR-0013): the per-pixel scalar `compute` emits. Only
 * `escape-time` is selectable in this slice; `distance-estimate` is
 * reserved in the union and ships as a disabled `<option>` until its
 * kernel lands (#61). `main.ts` maps these tag strings to the
 * wasm-bindgen `Field` discriminants at the WASM seam.
 */
export type FieldName = 'escape-time' | 'distance-estimate'

/**
 * Iteration-count stops for the log slider, low → high.
 *
 * The old `<select>` sampled only the octave boundaries (64, 128, 256, …
 * 8192), so the smallest step *doubled* the iteration count — too coarse.
 * This is a quarter-octave geometric grid instead: each octave `2^k` is
 * subdivided into `2^k × {1, 1.25, 1.5, 1.75}` (so 64, 80, 96, 112, then
 * 128, 160, …), capped by the 8192 endpoint. ~29 clean integer stops give
 * fine control, and because the spacing is geometric every step is the same
 * ~19–25% change — the slider feels uniform across its whole travel rather
 * than crawling at the low end and leaping at the high end.
 *
 * The slider's `value` is an INDEX into this array — a plain linear `0..N-1`
 * range — so equal pixel travel maps to equal ratio with no log maths in the
 * event handler. The table lives here, not in the markup, because it's a
 * computed sequence the constructor uses to drive the input's `min`/`max`/
 * `value` and to map an index back to its iteration count; keeping it in one
 * place is what stops the two from drifting.
 */
export const MAX_ITER_STOPS: readonly number[] = [
  64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640, 768, 896, 1024, 1280, 1536,
  1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 7168, 8192,
]

export interface Settings {
  readonly maxIter: number
  /**
   * Render-buffer multiplier relative to the display size (a quality /
   * sharpness knob, not a framing knob). `1` renders one buffer pixel
   * per display pixel; `2` supersamples; `0.5` subsamples for speed.
   */
  readonly renderScale: number
  readonly palette: PaletteName
  readonly normalisation: NormalisationName
  /** The Field axis (ADR-0013) — what scalar each pixel carries. */
  readonly field: FieldName
  readonly mode: FractalMode
  readonly cRe: number
  readonly cIm: number
  /** Whether the orbit visualizer overlay is enabled (E1, #94). */
  readonly orbit: boolean
  /**
   * Whether the pixel inspector is enabled (E2, #95). A view-only inspection
   * mode (it never recomputes or recolorizes), so it rides the settings
   * snapshot like `orbit` but, unlike it, is *not* persisted in the URL hash —
   * a shared permalink should not force the recipient into inspect mode.
   */
  readonly inspect: boolean
}
