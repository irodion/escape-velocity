import { describe, expect, it } from 'vitest'
// The real generated glue: the source of truth these tables copy (see the
// module doc in wasm-enums.ts for why they copy rather than import it).
import { Field, FractalKind, NormalizationMode, Palette } from '../wasm/fractal_wasm.js'
import { FIELDS, FRACTAL_MODES, NORMALISATIONS, PALETTES } from './settings.js'
import { fieldEnum, kindEnum, modeEnum, paletteEnum } from './wasm-enums.js'

// Each UI name's glue member, spelled out so a renamed or renumbered Rust
// variant fails here rather than sending the worker the wrong discriminant.
const PALETTE_MEMBERS = {
  grayscale: 'Grayscale',
  viridis: 'Viridis',
  magma: 'Magma',
  inferno: 'Inferno',
  plasma: 'Plasma',
  turbo: 'Turbo',
  cubehelix: 'Cubehelix',
  twilight: 'Twilight',
  'earth-and-sky': 'EarthAndSky',
  rainbow: 'Rainbow',
  'kahol-lavan': 'KaholLavan',
  ocean: 'Ocean',
  solar: 'Solar',
  spectral: 'Spectral',
  cosmic: 'Cosmic',
  phosphor: 'Phosphor',
  amber: 'Amber',
} as const satisfies Record<(typeof PALETTES)[number], keyof typeof Palette>

const NORMALISATION_MEMBERS = {
  cycled: 'Cycled',
  histogram: 'Histogram',
  linear: 'Linear',
  sqrt: 'SquareRoot',
  logarithmic: 'Logarithmic',
  clamped: 'Clamped',
} as const satisfies Record<(typeof NORMALISATIONS)[number], keyof typeof NormalizationMode>

const KIND_MEMBERS = {
  mandelbrot: 'Mandelbrot',
  julia: 'Julia',
} as const satisfies Record<(typeof FRACTAL_MODES)[number], keyof typeof FractalKind>

const FIELD_MEMBERS = {
  'escape-time': 'EscapeTime',
  'distance-estimate': 'DistanceEstimate',
} as const satisfies Record<(typeof FIELDS)[number], keyof typeof Field>

// The glue's numeric discriminants (its enum objects also map numbers back to
// names, which this drops).
const discriminants = (glueEnum: Record<string, unknown>): number[] =>
  Object.values(glueEnum)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b)

describe('wasm-enums against the generated glue', () => {
  it.each([
    ['palette', PALETTES, PALETTE_MEMBERS, Palette, paletteEnum],
    ['normalisation', NORMALISATIONS, NORMALISATION_MEMBERS, NormalizationMode, modeEnum],
    ['fractal kind', FRACTAL_MODES, KIND_MEMBERS, FractalKind, kindEnum],
    ['field', FIELDS, FIELD_MEMBERS, Field, fieldEnum],
  ] as const)(
    'maps every %s name to its glue discriminant, covering them all',
    (_, names, members, glueEnum, toEnum) => {
      const glue = glueEnum as unknown as Record<string, number>
      const lookup = toEnum as (name: string) => number
      const memberOf = members as Record<string, string>
      for (const name of names) {
        expect(lookup(name), name).toBe(glue[memberOf[name]])
      }
      // One-to-one: every Rust variant is reachable from some UI name.
      expect(names.map(lookup).sort((a, b) => a - b)).toEqual(discriminants(glue))
    },
  )
})
