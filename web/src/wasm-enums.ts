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
 *
 * The discriminants are written as numbers, with the generated glue imported
 * for its *types* only, so the main bundle never imports the WASM glue at
 * runtime (ADR-0015). That is load-bearing for the build, not just tidiness:
 * a main-bundle import of the glue, tree-shaken down to these enums, makes
 * Vite delete the WASM thread pool's helper worker chunk from `dist/` (it sees
 * the glue's reference to it as dead), and the built renderer then never
 * starts. `wasm-enums.test.ts` checks every number against the real glue, so
 * the tables can't drift from the Rust enums.
 */
import type { Field, FractalKind, NormalizationMode, Palette } from '../wasm/fractal_wasm.js'
import type { FieldName, FractalMode, NormalisationName, PaletteName } from './settings.js'

const PALETTE_ENUM: Record<PaletteName, Palette> = {
  grayscale: 0,
  viridis: 1,
  magma: 2,
  inferno: 3,
  plasma: 5,
  turbo: 6,
  cubehelix: 7,
  twilight: 4,
  'earth-and-sky': 8,
  rainbow: 9,
  'kahol-lavan': 11,
  ocean: 10,
  solar: 12,
  spectral: 13,
  cosmic: 14,
  phosphor: 15,
  amber: 16,
}

const NORMALISATION_ENUM: Record<NormalisationName, NormalizationMode> = {
  cycled: 0,
  histogram: 1,
  linear: 2,
  sqrt: 3,
  logarithmic: 4,
  clamped: 5,
}

const KIND_ENUM: Record<FractalMode, FractalKind> = {
  mandelbrot: 0,
  julia: 1,
}

const FIELD_ENUM: Record<FieldName, Field> = {
  'escape-time': 0,
  'distance-estimate': 1,
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
