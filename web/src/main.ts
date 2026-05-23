import init, { FractalKind, NormalizationMode, Palette, Viewport } from '../wasm/fractal_wasm.js'
import {
  Controls,
  type FractalMode,
  type NormalisationName,
  type PaletteName,
  type Settings,
} from './controls.js'
import { InputController } from './input.js'
import { recolorize, render } from './render.js'

// Slice 1 hardcoded initial render constants (PRD #2); Slice 3 promotes
// `maxIter` and canvas dimensions to form-driven `let`s but preserves
// the same opening view. Slice 4 adds palette + normalisation; the
// page lands on coloured smooth output (Viridis + Cycled) rather than
// the grey baseline. Slice 5C inherits the same Slice 1 zoom — the
// per-mode default views below are consulted only on a mode toggle.
const INITIAL_WIDTH = 800
const INITIAL_HEIGHT = 600
const INITIAL_MAX_ITER = 256
const INITIAL_PALETTE: PaletteName = 'viridis'
const INITIAL_NORMALISATION: NormalisationName = 'cycled'
const INITIAL_MODE: FractalMode = 'mandelbrot'
const INITIAL_C_RE = -0.7
const INITIAL_C_IM = 0.27015
const CENTER_RE = -0.7435
const CENTER_IM = 0.1314
const ZOOM = 200.0

// Canonical "starting frame" for each fractal family, consulted ONLY
// by the mode-switch branch of the dispatcher below. Mandelbrot's set
// is centred near (−0.5, 0); Julia sets (for the c values we care
// about) are roughly centred on the origin. Both use zoom=1.0 so the
// initial view shows the whole structure, not a deep dive — the user
// can pan/zoom from there. The boot-time viewport stays the Slice 1
// seahorse zoom; these are emphatically NOT used at startup.
const MANDELBROT_DEFAULT_VIEW = { re: -0.5, im: 0.0, zoom: 1.0 }
const JULIA_DEFAULT_VIEW = { re: 0.0, im: 0.0, zoom: 1.0 }

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
  mode: INITIAL_MODE,
  cRe: INITIAL_C_RE,
  cIm: INITIAL_C_IM,
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

const kindEnum = (name: FractalMode): FractalKind => {
  switch (name) {
    case 'mandelbrot':
      return FractalKind.Mandelbrot
    case 'julia':
      return FractalKind.Julia
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
    kindEnum(current.mode),
    current.cRe,
    current.cIm,
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
  // Mid-edit NaN guard: a `<input type="number">` blur with an empty
  // / dash-only value emits NaN. In Julia mode, NaN would trip the
  // WASM-side finite-c validation; skip the render AND skip updating
  // `current`, so the next genuine commit's diff still picks up the
  // c change. (In Mandelbrot mode the c values are ignored, so NaN
  // is harmless — fall through to the no-op branch below, which
  // updates `current` to keep the snapshot fresh.)
  if (next.mode === 'julia' && (!Number.isFinite(next.cRe) || !Number.isFinite(next.cIm))) {
    return
  }

  // Branch 1: fractal-family change. Reset the viewport to the
  // canonical "starting frame" for the new family so the user lands
  // on the whole structure instead of an arbitrary deep dive that
  // happened to be loaded for the previous family. Resolution is
  // preserved.
  if (next.mode !== current.mode) {
    const view = next.mode === 'mandelbrot' ? MANDELBROT_DEFAULT_VIEW : JULIA_DEFAULT_VIEW
    viewport = new Viewport(view.re, view.im, view.zoom, next.width, next.height)
    inputController.setViewport(viewport)
    current = next
    rerender()
    return
  }

  // Branch 2: resolution change. Lockstep: viewport dims, canvas
  // internal dims, and the controller's viewport reference all
  // advance together so `putImageData` receives a buffer sized to the
  // canvas and subsequent pan/zoom uses the right `pixel_scale`.
  if (next.width !== current.width || next.height !== current.height) {
    viewport = viewport.with_resolution(next.width, next.height)
    canvas.width = next.width
    canvas.height = next.height
    inputController.setViewport(viewport)
    current = next
    rerender()
    return
  }

  // Branch 3: compute-class change — `maxIter`, or (in Julia mode
  // only) a `c` change. The mid-edit NaN guard at the top of the
  // dispatcher already filtered the non-finite case, so any `c`
  // change reaching this point is committable.
  const cChangedInJulia =
    next.mode === 'julia' && (next.cRe !== current.cRe || next.cIm !== current.cIm)
  if (next.maxIter !== current.maxIter || cChangedInJulia) {
    current = next
    rerender()
    return
  }

  // Branch 4: visual-only change. The ADR-0002 payoff — same
  // iteration buffer, new palette / normalisation, no recompute.
  if (next.palette !== current.palette || next.normalisation !== current.normalisation) {
    current = next
    recolorize(ctx, wasm, paletteEnum(next.palette), modeEnum(next.normalisation))
    return
  }

  // Branch 5: no-op. Reaches here when the user re-selected the same
  // value, or when `cRe` / `cIm` changed but the form is in Mandelbrot
  // mode (where those values are carried-but-ignored). Refreshing
  // `current` keeps the snapshot in sync with the form so a later
  // Julia switch sees the committed c values.
  current = next
})
