// Self-hosted UI fonts (Slice 4 redesign). Imported here so Vite fingerprints
// the woff2 as build assets and Workbox precaches them (pwa-config globs now
// include woff2) — the offline PWA must never reach for a font CDN. Latin
// subsets only (the UI is English); the variable Martian Mono ships every
// subset behind unicode-range, so only the latin face is actually fetched.
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource-variable/martian-mono/wght.css'
import { registerSW } from 'virtual:pwa-register'
import init, {
  Field,
  FractalKind,
  NormalizationMode,
  Palette,
  Viewport,
} from '../wasm/fractal_wasm.js'
import {
  Controls,
  type FieldName,
  type FractalMode,
  type NormalisationName,
  type PaletteName,
  type Settings,
} from './controls.js'
import { mountDrawer } from './drawer.js'
import { InputController } from './input.js'
import { createPwaLifecycle } from './pwa-lifecycle.js'
import { mountPwaUi } from './pwa-ui.js'
import { computeBufferDims } from './render-buffer.js'
import { discardInFlight, recolorize, render } from './render-client.js'

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
// Fit-to-window (Slice 2): the viewport's logical dimensions track the
// canvas's CSS box — the window area it fills — instead of a fixed
// 800×600. A bigger window therefore reveals more of the plane (ADR-0011
// keys pixel-scale to a reference width, so more logical pixels = more
// plane, square pixels preserved). The render buffer is the logical size
// × render scale, bounded by MAX_RENDER_PIXELS so a huge window cannot
// hand the single-worker CPU renderer unbounded work.
const INITIAL_RENDER_SCALE = 1
// ~2.5M px ≈ the heaviest pre-fit-to-window preset (1600×1200). Beyond
// this the buffer is shrunk uniformly and CSS upscales it to fill.
const MAX_RENDER_PIXELS = 2_500_000
// A window resize fires continuously; coalesce to one recompute ~150ms
// after it settles. During the drag the full-bleed canvas CSS-stretches
// the last buffer as a cheap (briefly soft) preview.
const RESIZE_DEBOUNCE_MS = 150
const INITIAL_MAX_ITER = 256
const INITIAL_PALETTE: PaletteName = 'viridis'
const INITIAL_NORMALISATION: NormalisationName = 'cycled'
const INITIAL_FIELD: FieldName = 'escape-time'
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
const controlsToggle = document.getElementById('controls-toggle')
if (!(controlsToggle instanceof HTMLButtonElement)) {
  throw new Error('button#controls-toggle not found in index.html')
}

// Collapsible drawer (Slice 4): the controls panel is closed by default and
// the ☰ button toggles it. Fixed-positioned (index.html), so this is purely
// a visibility concern — it never touches the canvas box or the renderer.
mountDrawer(controlsToggle, controlsForm)

// Initialise the WASM module on the main thread so the synchronous
// `Viewport` class (used by the input controller and the dispatcher
// below) is callable. The render worker bootstraps its own separate
// WASM instance; the main thread no longer needs the `InitOutput`
// handle now that pixel work has moved off-thread.
await init()

// The viewport's logical dimensions: the canvas's CSS box, rounded and
// floored to ≥ 1 so a pre-layout or `display:none` canvas can't feed a
// zero dimension to the WASM seam. Re-read after every layout change
// (boot + window resize) so the fractal always fills the live window.
// This is the *only* source of the logical size, so it relies on the
// canvas being laid out to fill its intended area — see the full-bleed
// flex rules for `#fractal` in index.html. A CSS refactor that changes
// how the canvas is sized must keep that contract.
const measureLogicalSize = (): { width: number; height: number } => {
  const rect = canvas.getBoundingClientRect()
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

const boot = measureLogicalSize()
let viewport = new Viewport(CENTER_RE, CENTER_IM, ZOOM, boot.width, boot.height)
let current: Settings = {
  maxIter: INITIAL_MAX_ITER,
  renderScale: INITIAL_RENDER_SCALE,
  palette: INITIAL_PALETTE,
  normalisation: INITIAL_NORMALISATION,
  field: INITIAL_FIELD,
  mode: INITIAL_MODE,
  cRe: INITIAL_C_RE,
  cIm: INITIAL_C_IM,
}

// Tune the console's accent to the active palette so the controls read as an
// instrument keyed to what it's rendering (the `--accent` CSS custom property
// drives the toggle, focus rings, carets, and selected options in
// index.html). A representative mid-to-high colour from each colourmap.
const PALETTE_ACCENT: Record<PaletteName, string> = {
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
}
const applyAccent = (palette: PaletteName): void => {
  document.documentElement.style.setProperty('--accent', PALETTE_ACCENT[palette])
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
    case 'plasma':
      return Palette.Plasma
    case 'turbo':
      return Palette.Turbo
    case 'cubehelix':
      return Palette.Cubehelix
    case 'twilight':
      return Palette.Twilight
    case 'earth-and-sky':
      return Palette.EarthAndSky
    case 'rainbow':
      return Palette.Rainbow
    case 'kahol-lavan':
      return Palette.KaholLavan
    case 'ocean':
      return Palette.Ocean
    case 'solar':
      return Palette.Solar
    case 'spectral':
      return Palette.Spectral
    case 'cosmic':
      return Palette.Cosmic
  }
}

const modeEnum = (name: NormalisationName): NormalizationMode => {
  switch (name) {
    case 'cycled':
      return NormalizationMode.Cycled
    case 'histogram':
      return NormalizationMode.Histogram
    case 'linear':
      return NormalizationMode.Linear
    case 'sqrt':
      return NormalizationMode.SquareRoot
    case 'logarithmic':
      return NormalizationMode.Logarithmic
    case 'clamped':
      return NormalizationMode.Clamped
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

const fieldEnum = (name: FieldName): Field => {
  switch (name) {
    case 'escape-time':
      return Field.EscapeTime
    case 'distance-estimate':
      return Field.DistanceEstimate
  }
}

const rerender = (): void => {
  // Flatten the `Viewport` instance into primitives: the wasm-bindgen
  // class cannot survive `postMessage` to the worker, so the client
  // ships the accessor values and the worker rebuilds a Viewport
  // against its own WASM instance.
  //
  // Render scale + the pixel budget are applied here, at the render
  // seam. `computeBufferDims` turns the logical (display) size into the
  // buffer the worker computes, and returns the *effective* scale once
  // the budget bites. `zoom` is multiplied by that same effective scale
  // so the buffer — whatever its final size — covers the SAME framing at
  // higher/lower sample density (ADR-0011 keys pixel-scale to a fixed
  // reference width, so dimensions × zoom must move together to hold the
  // window). The stored `viewport` keeps the true zoom and logical
  // dimensions — this scaling is a transient property of the request,
  // and the canvas backing store is sized to match when the frame paints
  // (see `paint` in render-client).
  const { width, height, scale } = computeBufferDims(
    viewport.width(),
    viewport.height(),
    current.renderScale,
    MAX_RENDER_PIXELS,
  )
  render(
    {
      centerRe: viewport.center_re(),
      centerIm: viewport.center_im(),
      zoom: viewport.zoom() * scale,
      width,
      height,
    },
    ctx,
    current.maxIter,
    paletteEnum(current.palette),
    modeEnum(current.normalisation),
    kindEnum(current.mode),
    current.cRe,
    current.cIm,
    fieldEnum(current.field),
  )
}

applyAccent(current.palette)
rerender()

const inputController = new InputController(
  canvas,
  viewport,
  (next) => {
    // Every pan/zoom invalidates the iteration buffer by definition —
    // route through `render`, which refreshes the cache too.
    viewport = next
    rerender()
  },
  // While a wheel Preview is active, drop any in-flight render so a
  // premature Settle's frame can't paint mid-scrub and clear the Preview
  // transform out from under the gesture (ADR-0012).
  discardInFlight,
)

// Fit-to-window: re-fit the viewport whenever the canvas's measured box
// changes, then recompute. A ResizeObserver on the canvas — rather than
// a `window.resize` listener — ties the fit to the *actual* box, so it
// also catches changes that fire no window resize: a sibling entering
// flex flow (the PWA install button appearing below the canvas), a
// device rotation, or any reflow. Debounced so a continuous window drag
// triggers a single recompute once it settles; in between, the
// full-bleed canvas CSS-stretches the last buffer as a live preview.
// `with_resolution` preserves center and zoom, so only the framing
// extent grows/shrinks with the box, never the set's proportions.
let resizeTimer: ReturnType<typeof setTimeout> | undefined
const refitToCanvas = (): void => {
  resizeTimer = undefined
  const { width, height } = measureLogicalSize()
  if (width === viewport.width() && height === viewport.height()) {
    return
  }
  viewport = viewport.with_resolution(width, height)
  inputController.setViewport(viewport)
  rerender()
}
// ResizeObserver delivers an initial callback on observe(); the no-op
// guard above absorbs it, since the boot viewport already matches the
// measured box. Resizing the backing store at paint time changes only
// the canvas's intrinsic size, not its CSS box, so this never loops.
const resizeObserver = new ResizeObserver(() => {
  if (resizeTimer !== undefined) {
    clearTimeout(resizeTimer)
  }
  resizeTimer = setTimeout(refitToCanvas, RESIZE_DEBOUNCE_MS)
})
resizeObserver.observe(canvas)

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
  // Keep the accent in step with the palette on every commit — cheap, and
  // independent of which render branch below the change ends up taking.
  applyAccent(rawNext.palette)

  const cRe = Number.isFinite(rawNext.cRe) ? rawNext.cRe : current.cRe
  const cIm = Number.isFinite(rawNext.cIm) ? rawNext.cIm : current.cIm
  if (cRe !== rawNext.cRe || cIm !== rawNext.cIm) {
    controls.setCValues(cRe, cIm)
  }
  const next: Settings = { ...rawNext, cRe, cIm }

  // Branch 1: fractal-family change. Reset the viewport to the
  // canonical "starting frame" for the new family so the user lands
  // on the whole structure instead of an arbitrary deep dive that
  // happened to be loaded for the previous family. The viewport keeps
  // the current logical (window) dimensions; render scale is applied
  // later, at the render seam, so it is not part of the viewport here.
  if (next.mode !== current.mode) {
    const view = next.mode === 'mandelbrot' ? MANDELBROT_DEFAULT_VIEW : JULIA_DEFAULT_VIEW
    viewport = new Viewport(view.re, view.im, view.zoom, viewport.width(), viewport.height())
    inputController.setViewport(viewport)
    current = next
    rerender()
    return
  }

  // Branch 2: render-scale change. A pure quality knob: the viewport
  // (framing) is untouched, so neither the stored viewport nor the
  // input controller's reference changes. `rerender` re-derives the
  // buffer dimensions and the scale-compensated zoom from
  // `current.renderScale`, and the canvas backing store is resized when
  // the new frame paints (see `paint` in render-client).
  if (next.renderScale !== current.renderScale) {
    current = next
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

  // Branch 3c: Field change — compute-class (ADR-0013). The Field is the
  // per-pixel scalar `compute` emits, so switching it invalidates the
  // iteration buffer exactly as `maxIter` / `c` do. It must route through
  // `render` (a full recompute), never `recolorize`, because the cached
  // buffer holds a different Field's values. (Distance Estimate is not yet
  // selectable, so today this only fires Escape Time → Escape Time no-ops
  // away above; the branch is here so the axis is wired the moment #61
  // makes a second Field reachable.)
  if (next.field !== current.field) {
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
