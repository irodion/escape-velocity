/**
 * The seam between the form's tag-string vocabulary and the wasm-bindgen enum
 * discriminants. Each table is a `Record` over a closed name union, so a
 * missing entry is a compile error — the same exhaustiveness a `switch`
 * default-less over the union would give, but as one navigable site per axis.
 * "Add a palette" touches exactly one entry here.
 *
 * `PALETTE_ACCENT` sits beside the enum tables because it is the other
 * per-palette lookup the UI keys off; the DOM write that consumes it
 * (`applyAccent`) stays in `main.ts`.
 */
import { Field, FractalKind, NormalizationMode, Palette } from '../wasm/fractal_wasm.js'
import type { FieldName, FractalMode, NormalisationName, PaletteName } from './settings.js'

const PALETTE_ENUM: Record<PaletteName, Palette> = {
  grayscale: Palette.Grayscale,
  viridis: Palette.Viridis,
  magma: Palette.Magma,
  inferno: Palette.Inferno,
  plasma: Palette.Plasma,
  turbo: Palette.Turbo,
  cubehelix: Palette.Cubehelix,
  twilight: Palette.Twilight,
  'earth-and-sky': Palette.EarthAndSky,
  rainbow: Palette.Rainbow,
  'kahol-lavan': Palette.KaholLavan,
  ocean: Palette.Ocean,
  solar: Palette.Solar,
  spectral: Palette.Spectral,
  cosmic: Palette.Cosmic,
  phosphor: Palette.Phosphor,
  amber: Palette.Amber,
}

const NORMALISATION_ENUM: Record<NormalisationName, NormalizationMode> = {
  cycled: NormalizationMode.Cycled,
  histogram: NormalizationMode.Histogram,
  linear: NormalizationMode.Linear,
  sqrt: NormalizationMode.SquareRoot,
  logarithmic: NormalizationMode.Logarithmic,
  clamped: NormalizationMode.Clamped,
}

const KIND_ENUM: Record<FractalMode, FractalKind> = {
  mandelbrot: FractalKind.Mandelbrot,
  julia: FractalKind.Julia,
}

const FIELD_ENUM: Record<FieldName, Field> = {
  'escape-time': Field.EscapeTime,
  'distance-estimate': Field.DistanceEstimate,
}

export const paletteEnum = (name: PaletteName): Palette => PALETTE_ENUM[name]
export const modeEnum = (name: NormalisationName): NormalizationMode => NORMALISATION_ENUM[name]
export const kindEnum = (name: FractalMode): FractalKind => KIND_ENUM[name]
export const fieldEnum = (name: FieldName): Field => FIELD_ENUM[name]

/**
 * A representative mid-to-high colour from each colourmap, used to key the
 * UI's `--accent` CSS custom property to what the canvas is rendering (the
 * toggle, focus rings, carets, and selected options in `index.html`).
 */
export const PALETTE_ACCENT: Record<PaletteName, string> = {
  grayscale: '#c9c9d1',
  viridis: '#5fd0c0',
  magma: '#fe6a8c',
  inferno: '#ff7a3c',
  plasma: '#fb9f3a',
  turbo: '#2ad4c1',
  cubehelix: '#c2a3bd',
  twilight: '#b78cff',
  'earth-and-sky': '#ffaa00',
  rainbow: '#ff6ec7',
  'kahol-lavan': '#3a78d8',
  ocean: '#41c7e8',
  solar: '#ff8c42',
  spectral: '#2ec5c5',
  cosmic: '#c77dff',
  phosphor: '#52e06a',
  amber: '#e0a83c',
}
