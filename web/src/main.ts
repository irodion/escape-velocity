import init, { FractalKind, NormalizationMode, Palette, Viewport } from '../wasm/fractal_wasm.js'
import { Controls, type NormalisationName, type PaletteName, type Settings } from './controls.js'
import { InputController } from './input.js'
import { recolorize, render } from './render.js'

// Slice 1 hardcoded initial render constants (PRD #2); Slice 3 promotes
// `maxIter` and canvas dimensions to form-driven `let`s but preserves
// the same opening view. Slice 4 adds palette + normalisation; the
// page lands on coloured smooth output (Viridis + Cycled) rather than
// the grey baseline.
const INITIAL_WIDTH = 800
const INITIAL_HEIGHT = 600
const INITIAL_MAX_ITER = 256
const INITIAL_PALETTE: PaletteName = 'viridis'
const INITIAL_NORMALISATION: NormalisationName = 'cycled'
const CENTER_RE = -0.7435
const CENTER_IM = 0.1314
const ZOOM = 200.0

// Slice 5B carries the Julia parameter through `render` so the WASM
// seam is fully Julia-capable, but pins `kind` to Mandelbrot at boot
// — Slice 5C adds the form controls that let the user flip to Julia.
// `INITIAL_C_RE`/`INITIAL_C_IM` are carried-but-ignored in this slice
// (the WASM side validates them for `is_finite()` regardless of
// `kind`, so they must be real numbers even when ignored).
const INITIAL_KIND: FractalKind = FractalKind.Mandelbrot
const INITIAL_C_RE = -0.7
const INITIAL_C_IM = 0.27015

const canvas = document.getElementById('fractal')
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('canvas#fractal not found in index.html')
}
const ctx = canvas.getContext('2d')
if (ctx === null) {
  throw new Error('failed to acquire 2d canvas context')
}
const controlsForm = document.getElementById('controls')
if (!(controlsForm instanceof HTMLFormElement)) {
  throw new Error('form#controls not found in index.html')
}

const wasm = await init()

let viewport = new Viewport(CENTER_RE, CENTER_IM, ZOOM, INITIAL_WIDTH, INITIAL_HEIGHT)
let current: Settings = {
  maxIter: INITIAL_MAX_ITER,
  width: INITIAL_WIDTH,
  height: INITIAL_HEIGHT,
  palette: INITIAL_PALETTE,
  normalisation: INITIAL_NORMALISATION,
}

const paletteEnum = (name: PaletteName): Palette => {
  switch (name) {
    case 'grayscale':
      return Palette.Grayscale
    case 'viridis':
      return Palette.Viridis
    case 'magma':
      return Palette.Magma
    case 'inferno':
      return Palette.Inferno
    case 'twilight':
      return Palette.Twilight
  }
}

const modeEnum = (name: NormalisationName): NormalizationMode => {
  switch (name) {
    case 'cycled':
      return NormalizationMode.Cycled
    case 'histogram':
      return NormalizationMode.Histogram
  }
}

const rerender = (): void => {
  render(
    viewport,
    ctx,
    wasm,
    current.maxIter,
    paletteEnum(current.palette),
    modeEnum(current.normalisation),
    INITIAL_KIND,
    INITIAL_C_RE,
    INITIAL_C_IM,
  )
}

rerender()

const inputController = new InputController(canvas, viewport, (next) => {
  // Every pan/zoom invalidates the iteration buffer by definition —
  // route through `render`, which refreshes the cache too.
  viewport = next
  rerender()
})

new Controls(controlsForm, current, (next) => {
  const recomputeNeeded =
    next.maxIter !== current.maxIter ||
    next.width !== current.width ||
    next.height !== current.height
  const visualOnly =
    !recomputeNeeded &&
    (next.palette !== current.palette || next.normalisation !== current.normalisation)

  if (recomputeNeeded) {
    if (next.width !== current.width || next.height !== current.height) {
      // Lockstep: viewport dims, canvas internal dims, and the
      // controller's viewport reference all advance together so
      // `putImageData` receives a buffer sized to the canvas and
      // subsequent pan/zoom uses the right `pixel_scale`.
      viewport = viewport.with_resolution(next.width, next.height)
      canvas.width = next.width
      canvas.height = next.height
      inputController.setViewport(viewport)
    }
    current = next
    rerender()
  } else if (visualOnly) {
    // Fast path: the ADR-0002 payoff. Same iteration buffer, new
    // palette / normalisation, no recompute.
    current = next
    recolorize(ctx, wasm, paletteEnum(next.palette), modeEnum(next.normalisation))
  } else {
    // No-op change (the user re-selected the same value).
    current = next
  }
})
