import type { FieldName, FractalMode, NormalisationName, PaletteName } from './controls.js'

/**
 * The shareable view tuple (O1, #91): everything that decides *what frame the
 * user is looking at*, serialised into the URL hash so a view can be
 * bookmarked, shared, and restored on PWA relaunch.
 *
 * This is the framing + colouring state, NOT the environment: the render
 * buffer's pixel `width`/`height` (derived from the window) and the
 * `renderScale` quality knob are deliberately excluded — they describe the
 * device, not the view, and pinning them into a shared link would force the
 * recipient's window size / sharpness onto them. `zoom` already keys to a
 * fixed reference width (ADR-0011), so the same `(re, im, zoom)` shows the
 * same magnification on any window.
 *
 * The fields mirror the persistable subset of the worker's `RenderRequest`
 * (the single tuple all view state flows through), using the form-side string
 * unions rather than the wasm enum discriminants so the hash is human-legible
 * and stable across wasm rebuilds.
 */
export interface ViewState {
  readonly re: number
  readonly im: number
  readonly zoom: number
  readonly maxIter: number
  readonly palette: PaletteName
  readonly normalisation: NormalisationName
  readonly mode: FractalMode
  readonly field: FieldName
  readonly cRe: number
  readonly cIm: number
}

// Short, stable hash keys — the persistence contract. Independent of the
// form's `name=` attributes and the wasm enum names so neither can break a
// saved link by changing.
const KEY = {
  re: 're',
  im: 'im',
  zoom: 'z',
  maxIter: 'it',
  palette: 'pal',
  normalisation: 'norm',
  mode: 'kind',
  field: 'field',
  cRe: 'cre',
  cIm: 'cim',
} as const

// Allow-lists for the enum-valued fields — `parse` accepts a value only if it
// is a member, so a stale or hand-edited hash can never push an unknown string
// into `Controls` (whose constructor throws on an option that has no matching
// `<option>`). `satisfies` makes a typo here a compile error; a value missing
// from a list degrades safely (that field falls back to the default) rather
// than crashing, which is the tolerance O1 requires of external input.
const PALETTES = [
  'grayscale',
  'viridis',
  'magma',
  'inferno',
  'plasma',
  'turbo',
  'cubehelix',
  'twilight',
  'earth-and-sky',
  'rainbow',
  'kahol-lavan',
  'ocean',
  'solar',
  'spectral',
  'cosmic',
] as const satisfies readonly PaletteName[]
const NORMALISATIONS = [
  'cycled',
  'histogram',
  'linear',
  'sqrt',
  'logarithmic',
  'clamped',
] as const satisfies readonly NormalisationName[]
const MODES = ['mandelbrot', 'julia'] as const satisfies readonly FractalMode[]
const FIELDS = ['escape-time', 'distance-estimate'] as const satisfies readonly FieldName[]

/**
 * Serialise a view into a URL hash string (leading `#` included), ready for
 * `history.replaceState`. Numbers use JS's shortest round-tripping form
 * (`String(n)`), so `parse(serialize(v))` recovers every field exactly.
 */
export function serialize(state: ViewState): string {
  const params = new URLSearchParams()
  params.set(KEY.re, String(state.re))
  params.set(KEY.im, String(state.im))
  params.set(KEY.zoom, String(state.zoom))
  params.set(KEY.maxIter, String(state.maxIter))
  params.set(KEY.palette, state.palette)
  params.set(KEY.normalisation, state.normalisation)
  params.set(KEY.mode, state.mode)
  params.set(KEY.field, state.field)
  params.set(KEY.cRe, String(state.cRe))
  params.set(KEY.cIm, String(state.cIm))
  return `#${params.toString()}`
}

/**
 * Parse a URL hash into the subset of view fields it carries, tolerant of
 * anything: a leading `#` or `?`, missing keys, junk numbers, unknown enum
 * values, and entirely foreign hashes are all handled by *dropping* the
 * offending field rather than throwing. Returns `null` when nothing usable was
 * found, so the caller can cleanly fall back to defaults.
 *
 * The caller is still responsible for one domain clamp the codec can't own
 * without reaching into the controls' stop table: `maxIter` is returned as the
 * raw persisted number (validated finite & positive), and must be snapped to a
 * real slider stop (`nearestMaxIterStop`) before reaching `Controls`.
 */
export function parse(hash: string): Partial<ViewState> | null {
  const params = new URLSearchParams(hash.replace(/^[#?]/, ''))
  const out: Partial<Record<keyof ViewState, ViewState[keyof ViewState]>> = {}

  const num = (key: string): number | undefined => {
    const raw = params.get(key)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  const positive = (key: string): number | undefined => {
    const value = num(key)
    return value !== undefined && value > 0 ? value : undefined
  }
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const raw = params.get(key)
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined
  }

  const re = num(KEY.re)
  const im = num(KEY.im)
  const zoom = positive(KEY.zoom)
  const maxIter = positive(KEY.maxIter)
  const palette = oneOf(KEY.palette, PALETTES)
  const normalisation = oneOf(KEY.normalisation, NORMALISATIONS)
  const mode = oneOf(KEY.mode, MODES)
  const field = oneOf(KEY.field, FIELDS)
  const cRe = num(KEY.cRe)
  const cIm = num(KEY.cIm)

  if (re !== undefined) out.re = re
  if (im !== undefined) out.im = im
  if (zoom !== undefined) out.zoom = zoom
  if (maxIter !== undefined) out.maxIter = maxIter
  if (palette !== undefined) out.palette = palette
  if (normalisation !== undefined) out.normalisation = normalisation
  if (mode !== undefined) out.mode = mode
  if (field !== undefined) out.field = field
  if (cRe !== undefined) out.cRe = cRe
  if (cIm !== undefined) out.cIm = cIm

  return Object.keys(out).length === 0 ? null : (out as Partial<ViewState>)
}

// U+2212 MINUS SIGN — the typographic minus, so the readout aligns under
// tabular-nums and reads as an instrument rather than a code dump.
const MINUS = '−'
const signed = (value: number, digits: number): string =>
  `${value < 0 ? MINUS : '+'}${Math.abs(value).toFixed(digits)}`

/**
 * Format one axis of the centre (`re` or `im`) for the coordinate readout:
 * an explicit sign (typographic minus) and five decimals, e.g. `−0.74350`.
 * Pure so the layout can render each axis in its own cell.
 */
export function formatAxis(value: number): string {
  return signed(value, 5)
}

/**
 * Format the magnification for the coordinate readout: one-significant-decimal
 * scientific notation with the `+` exponent sign dropped, e.g. `2.0e2`. Stays
 * compact across the whole 1×–1e13 range.
 */
export function formatZoom(zoom: number): string {
  return zoom.toExponential(1).replace('e+', 'e')
}

/**
 * Compose the three axes into a single line, e.g. `re −0.74350 · im +0.13140 ·
 * zoom 2.0e2`. The visible readout now renders each axis in its own cell (see
 * `index.html`'s `.coords` block); this single string feeds the off-screen
 * `aria-live` region so a screen reader announces the settled view as one
 * utterance rather than three.
 */
export function formatCoords(re: number, im: number, zoom: number): string {
  return `re ${formatAxis(re)} · im ${formatAxis(im)} · zoom ${formatZoom(zoom)}`
}
