import { registerSW } from 'virtual:pwa-register'
import init, { FractalKind, NormalizationMode, Palette, Viewport } from '../wasm/fractal_wasm.js'
import {
  Controls,
  type FractalMode,
  type NormalisationName,
  type PaletteName,
  type Settings,
} from './controls.js'
import { InputController } from './input.js'
import { createPwaLifecycle } from './pwa-lifecycle.js'
import { mountPwaUi } from './pwa-ui.js'
import { recolorize, render } from './render-client.js'

// PWA install + update lifecycle (Slice 8B). The controller (a deep, tested
// state machine) is fed the real platform adapters here: the SW registrar is
// vite-plugin-pwa's `registerSW` (which still registers immediately so the
// app precaches — the Slice 8A behaviour — but now routes its update
// callbacks into the controller), and the install-event source is `window`'s
// `beforeinstallprompt` / `appinstalled`. The thin presenter then renders the
// Install button + update toast. All a no-op in dev: `devOptions.enabled` is
// false, so `registerSW` is a stub and `beforeinstallprompt` never fires.
const pwa = createPwaLifecycle({
  registerServiceWorker: ({ onNeedRefresh, onOfflineReady }) =>
    registerSW({ immediate: true, onNeedRefresh, onOfflineReady }),
  installPrompt: {
    onBeforeInstallPrompt: (handler) =>
      window.addEventListener('beforeinstallprompt', (event) => {
        handler(event as unknown as Parameters<typeof handler>[0])
      }),
    onAppInstalled: (handler) => window.addEventListener('appinstalled', () => handler()),
  },
})
mountPwaUi(pwa, document.body)

// Slice 1 hardcoded initial render constants (PRD #2); Slice 3 promotes
// `maxIter` and canvas dimensions to form-driven `let`s but preserves
// the same opening view. Slice 4 adds palette + normalisation; the
// page lands on coloured smooth output (Viridis + Cycled) rather than
// the grey baseline. Slice 5C inherits the same Slice 1 zoom — the
// per-mode default views below are consulted only on a mode toggle.
// The display (logical) size of the viewport in CSS pixels. The render
// buffer is this size times the render-scale multiplier (below); the
// viewport itself — and therefore the framing — always uses the display
// size, so changing render scale never alters what region is shown.
const DISPLAY_WIDTH = 800
const DISPLAY_HEIGHT = 600
const INITIAL_RENDER_SCALE = 1
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

// Initialise the WASM module on the main thread so the synchronous
// `Viewport` class (used by the input controller and the dispatcher
// below) is callable. The render worker bootstraps its own separate
// WASM instance; the main thread no longer needs the `InitOutput`
// handle now that pixel work has moved off-thread.
await init()

let viewport = new Viewport(CENTER_RE, CENTER_IM, ZOOM, DISPLAY_WIDTH, DISPLAY_HEIGHT)
let current: Settings = {
  maxIter: INITIAL_MAX_ITER,
  renderScale: INITIAL_RENDER_SCALE,
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

// Size the canvas backing store (the render buffer) to the display
// size times the current render-scale multiplier. The CSS display size
// is fixed at 800×600 (index.html), so a scale >1 supersamples and <1
// subsamples; the browser scales the buffer to the display box. Must be
// kept in lockstep with the dimensions `rerender` sends the worker, so
// `putImageData` receives a buffer sized to the canvas.
const syncCanvasToRenderScale = (): void => {
  canvas.width = Math.round(viewport.width() * current.renderScale)
  canvas.height = Math.round(viewport.height() * current.renderScale)
}

const rerender = (): void => {
  // Flatten the `Viewport` instance into primitives: the wasm-bindgen
  // class cannot survive `postMessage` to the worker, so the client
  // ships the accessor values and the worker rebuilds a Viewport
  // against its own WASM instance.
  //
  // Render scale is applied here, at the render seam: the buffer is the
  // display size × scale, and `zoom` is multiplied by the same scale so
  // the larger/smaller buffer covers the *same* framing at higher/lower
  // sample density (ADR-0011 keys pixel-scale to a fixed reference
  // width, so dimensions × zoom must move together to hold the window).
  // The stored `viewport` keeps the true zoom and display dimensions —
  // this scaling is a transient property of the render request only.
  const scale = current.renderScale
  render(
    {
      centerRe: viewport.center_re(),
      centerIm: viewport.center_im(),
      zoom: viewport.zoom() * scale,
      width: Math.round(viewport.width() * scale),
      height: Math.round(viewport.height() * scale),
    },
    ctx,
    current.maxIter,
    paletteEnum(current.palette),
    modeEnum(current.normalisation),
    kindEnum(current.mode),
    current.cRe,
    current.cIm,
  )
}

syncCanvasToRenderScale()
rerender()

const inputController = new InputController(canvas, viewport, (next) => {
  // Every pan/zoom invalidates the iteration buffer by definition —
  // route through `render`, which refreshes the cache too.
  viewport = next
  rerender()
})

const controls = new Controls(controlsForm, current, (rawNext) => {
  // Substitute the last-known-finite c values for any non-finite
  // entries in the form snapshot. `<input type="number">` reports
  // NaN for an empty / dash-only `value`, and the WASM `compute`
  // seam validates `c_re`/`c_im` for `is_finite()` **unconditionally**
  // — Mandelbrot ignores the c payload mathematically, but a NaN
  // still trips the boundary check. Without this substitution, the
  // sequence (Julia → clear c.re → toggle back to Mandelbrot) would
  // store `cRe = NaN` into `current` and throw on the next render.
  //
  // The substitution preserves the invariant "`current.cRe`/`current.cIm`
  // are always finite" — established at boot by the Controls
  // construction-time NaN guard, and closed here by always pulling
  // the fallback from `current`. In Julia mode the substitution
  // turns a mid-edit empty input into a no-op commit (next's c
  // equals current's after sanitisation, so branch 3's cChangedInJulia
  // check is false and branch 5 runs). In Mandelbrot mode it lets
  // mode toggles succeed regardless of whatever the user typed into
  // the (then-disabled) c fields earlier.
  //
  // Where a fallback fires, back-write the substituted value into the
  // DOM so the visible field matches the rendered parameter. Without
  // this the input would stay blank while the renderer used the
  // hidden previous c — e.g., the user clears c.re, then changes
  // palette: branch 4 would recolour the cached Julia buffer (drawn
  // with the previous c) while the c.re field shows nothing. The
  // back-write keeps form and image strictly aligned. Setting
  // `valueAsNumber` does not dispatch a `change`, so this is a
  // one-way sync that never re-enters the dispatcher.
  const cRe = Number.isFinite(rawNext.cRe) ? rawNext.cRe : current.cRe
  const cIm = Number.isFinite(rawNext.cIm) ? rawNext.cIm : current.cIm
  if (cRe !== rawNext.cRe || cIm !== rawNext.cIm) {
    controls.setCValues(cRe, cIm)
  }
  const next: Settings = { ...rawNext, cRe, cIm }

  // Branch 1: fractal-family change. Reset the viewport to the
  // canonical "starting frame" for the new family so the user lands
  // on the whole structure instead of an arbitrary deep dive that
  // happened to be loaded for the previous family. The viewport always
  // uses the fixed display size; render scale is applied later, at the
  // render seam, so it is not part of the viewport here.
  if (next.mode !== current.mode) {
    const view = next.mode === 'mandelbrot' ? MANDELBROT_DEFAULT_VIEW : JULIA_DEFAULT_VIEW
    viewport = new Viewport(view.re, view.im, view.zoom, DISPLAY_WIDTH, DISPLAY_HEIGHT)
    inputController.setViewport(viewport)
    current = next
    rerender()
    return
  }

  // Branch 2: render-scale change. A pure quality knob: the viewport
  // (framing) is untouched, so neither the stored viewport nor the
  // input controller's reference changes. Only the canvas backing-store
  // size advances — `rerender` re-derives the buffer dimensions and the
  // scale-compensated zoom from `current.renderScale`. The drag preview
  // in InputController reads the live `canvas.width`, so it tracks the
  // new buffer automatically.
  if (next.renderScale !== current.renderScale) {
    current = next
    syncCanvasToRenderScale()
    rerender()
    return
  }

  // Branch 3: compute-class change — `maxIter`, or (in Julia mode
  // only) a `c` change. The top-of-handler sanitise step already
  // replaced any non-finite `c` with the previous finite value, so
  // `next.cRe`/`next.cIm` reaching this branch are always finite and
  // safe to send through the WASM seam.
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
    recolorize(ctx, paletteEnum(next.palette), modeEnum(next.normalisation))
    return
  }

  // Branch 5: no-op. Reaches here when the user re-selected the same
  // value, or when `cRe` / `cIm` changed but the form is in Mandelbrot
  // mode (where those values are carried-but-ignored). Refreshing
  // `current` keeps the snapshot in sync with the form so a later
  // Julia switch sees the committed c values.
  current = next
})
