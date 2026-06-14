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
  nearestMaxIterStop,
  type PaletteName,
  pickJuliaSettings,
  type Settings,
} from './controls.js'
import { mountDrawer } from './drawer.js'
import { buildFilename, exportRenderedFrame } from './export-png.js'
import { showFatal } from './fatal.js'
import { defaultModeForField, isModeValidForField } from './field-modes.js'
import { InputController } from './input.js'
import { OrbitOverlay, viewGeometryFromStore } from './orbit.js'
import { cssToComplex } from './orbit-math.js'
import { mountProgress } from './progress.js'
import { createPwaLifecycle } from './pwa-lifecycle.js'
import { mountPwaUi } from './pwa-ui.js'
import { computeBufferDims } from './render-buffer.js'
import {
  discardInFlight,
  recolorize,
  render,
  setFatalHandler,
  setProgressReporter,
} from './render-client.js'
import {
  formatAxis,
  formatCoords,
  formatZoom,
  parse,
  serialize,
  type ViewState,
} from './view-state.js'
import { createViewportStore } from './viewport-store.js'
import type { RenderRequest } from './worker/protocol.js'

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
const INITIAL_ORBIT = false
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
// The orbit visualizer's transparent overlay canvas (E1, #94), stacked over
// `#fractal` inside `.stage` so its pixel box matches.
const orbitCanvas = document.getElementById('orbit')
if (!(orbitCanvas instanceof HTMLCanvasElement)) {
  throw new Error('canvas#orbit not found in index.html')
}
const controlsForm = document.getElementById('controls')
if (!(controlsForm instanceof HTMLFormElement)) {
  throw new Error('form#controls not found in index.html')
}
const controlsToggle = document.getElementById('controls-toggle')
if (!(controlsToggle instanceof HTMLButtonElement)) {
  throw new Error('button#controls-toggle not found in index.html')
}
// PNG export controls (O2, #92). Actions, not form state — wired directly
// below rather than through Controls, so a save never emits a settings
// snapshot or triggers a rerender.
const exportPngButton = document.getElementById('export-png')
if (!(exportPngButton instanceof HTMLButtonElement)) {
  throw new Error('button#export-png not found in index.html')
}
const exportPng2xButton = document.getElementById('export-png-2x')
if (!(exportPng2xButton instanceof HTMLButtonElement)) {
  throw new Error('button#export-png-2x not found in index.html')
}
// The off-screen aria-live mirror (one string for screen readers) and the
// three visible value cells of the coordinate instrument. main.ts owns the
// view centre (re/im/zoom); the editable `c` cells are driven by Controls.
const coordsReadout = document.getElementById('coords')
if (!(coordsReadout instanceof HTMLElement)) {
  throw new Error('#coords not found in index.html')
}
const coordCell = (axis: 're' | 'im' | 'zoom'): HTMLElement => {
  const el = document.querySelector(`.coord__val[data-coord="${axis}"]`)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`.coord__val[data-coord="${axis}"] not found in index.html`)
  }
  return el
}
const coordCells = { re: coordCell('re'), im: coordCell('im'), zoom: coordCell('zoom') }

// Collapsible drawer (Slice 4): the controls panel is closed by default and
// the ☰ button toggles it. Fixed-positioned (index.html), so this is purely
// a visibility concern — it never touches the canvas box or the renderer.
// The canvas is passed as the dismiss surface so a deliberate click on the
// fractal closes an open drawer (a pan-drag or wheel-zoom leaves it open).
mountDrawer(controlsToggle, controlsForm, canvas)

// Route unrecoverable renderer failures to a legible full-screen surface
// instead of a silent black canvas (B4 / U2). Registering here also arms the
// render-client's boot watchdog: if the worker never reaches `ready` (a
// stripped cross-origin-isolation header, a WASM LinkError), the same panel
// appears after a few seconds rather than the page hanging forever.
setFatalHandler((message) => {
  showFatal('Renderer unavailable', message)
})

// Determinate progress indicator for slow deep renders (P2, #78). The render
// client drives `begin`/`report`/`end` as a banded render streams its
// heartbeats; the mounted reporter owns the reveal debounce so fast frames
// never flash. A no-op until registered, so a render before this point simply
// shows nothing.
setProgressReporter(mountProgress(document.body))

// Initialise the WASM module on the main thread so the synchronous
// `Viewport` class (used by the input controller and the dispatcher
// below) is callable. The render worker bootstraps its own separate
// WASM instance; the main thread no longer needs the `InitOutput`
// handle now that pixel work has moved off-thread.
//
// A failure here (cross-origin isolation lost, instantiation error) leaves
// the page with no usable `Viewport`, so surface it and stop boot rather
// than letting later code throw cryptically against a dead module.
try {
  await init()
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  showFatal(
    'Renderer unavailable',
    `The WebAssembly module failed to load: ${detail}. This browser or server ` +
      'configuration may not support the renderer (it requires SharedArrayBuffer).',
  )
  throw error
}

// Version signal (O2, #92): announce which build is running. For a
// continuously-deployed PWA this is the one reliable way to correlate a live
// tab with a commit when debugging. `__APP_VERSION__` is inlined at build time
// (see vite.config.ts).
console.info(`Escape Velocity · build ${__APP_VERSION__}`)

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

// The single authoritative home of the on-screen viewport (A2, #85). Every
// reader calls `store.get()`, every writer calls `store.set(vp, source)`, and
// reactions (the rerender below, the InputController's Preview teardown) are
// subscribers. This collapses the old two-way `viewport` ⇄ `inputController`
// sync ritual into one path, so the next state writer (URL hydration,
// bookmarks, a reset-view button) is a single `store.set` with no lockstep to
// remember.
// Resolve a URL hash into a coherent view (O1, #91): a shared / bookmarked
// link — or a PWA relaunch that restores the last URL — lands on that exact
// frame instead of always opening on the hardcoded seahorse. `parse` is
// tolerant, so any field the hash omits or mangles falls back to the constant
// default below and a junk hash degrades to the default view rather than
// failing. Two values get a domain repair the codec can't own: `maxIter` is
// snapped to a real slider stop (a stale count would otherwise throw in the
// `Controls` constructor), and an incoherent (field, normalisation) pair is
// replaced with the field's default — the same rule `Controls` enforces — so
// `current`, the form, and the rendered frame always agree. `re`/`im` are
// finite and `zoom` is finite & > 0 by `parse`'s contract, exactly what the
// `Viewport` constructor validates, so it never throws on resolved input.
//
// Render scale is NOT carried in the hash (it's a device quality knob, not
// part of the shared view), so the caller passes the scale to preserve: the
// boot default at startup, the live value when re-resolving on a `hashchange`.
const DEFAULT_VIEW: ViewState = {
  re: CENTER_RE,
  im: CENTER_IM,
  zoom: ZOOM,
  maxIter: INITIAL_MAX_ITER,
  palette: INITIAL_PALETTE,
  normalisation: INITIAL_NORMALISATION,
  mode: INITIAL_MODE,
  field: INITIAL_FIELD,
  cRe: INITIAL_C_RE,
  cIm: INITIAL_C_IM,
  orbit: INITIAL_ORBIT,
}
const resolveView = (
  hash: string,
  renderScale: number,
): { view: ViewState; settings: Settings } => {
  const view: ViewState = { ...DEFAULT_VIEW, ...(parse(hash) ?? {}) }
  const settings: Settings = {
    maxIter: nearestMaxIterStop(view.maxIter),
    renderScale,
    palette: view.palette,
    normalisation: isModeValidForField(view.field, view.normalisation)
      ? view.normalisation
      : defaultModeForField(view.field),
    field: view.field,
    mode: view.mode,
    cRe: view.cRe,
    cIm: view.cIm,
    orbit: view.orbit,
  }
  return { view, settings }
}

const booted = resolveView(window.location.hash, INITIAL_RENDER_SCALE)
const boot = measureLogicalSize()
const store = createViewportStore(
  new Viewport(booted.view.re, booted.view.im, booted.view.zoom, boot.width, boot.height),
)
let current: Settings = booted.settings

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
  const viewport = store.get()
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

// View persistence + coordinate readout (O1, #91). On every *commit* — a
// settled pan/zoom, a refit, a mode-reset, or a committed Controls change — the
// readout updates immediately and the URL hash is rewritten (debounced) so the
// view is shareable, bookmarkable, and restored on reload / PWA relaunch. This
// only ever fires at a Settle, never during a Preview: the store is written
// only when a gesture commits (ADR-0012) and the form is `change`-gated, so
// there is no mid-gesture writer to guard against.
const URL_WRITE_DEBOUNCE_MS = 400
let urlWriteTimer: ReturnType<typeof setTimeout> | undefined

// Assemble the shareable tuple from the two live sources of view state: the
// framing from the store, the colouring/compute settings from `current`.
const currentViewState = (): ViewState => {
  const vp = store.get()
  return {
    re: vp.center_re(),
    im: vp.center_im(),
    zoom: vp.zoom(),
    maxIter: current.maxIter,
    palette: current.palette,
    normalisation: current.normalisation,
    mode: current.mode,
    field: current.field,
    cRe: current.cRe,
    cIm: current.cIm,
    orbit: current.orbit,
  }
}

const renderCoords = (state: ViewState): void => {
  coordCells.re.textContent = formatAxis(state.re)
  coordCells.im.textContent = formatAxis(state.im)
  coordCells.zoom.textContent = formatZoom(state.zoom)
  // The off-screen mirror announces all three axes as a single utterance.
  coordsReadout.textContent = formatCoords(state.re, state.im, state.zoom)
}

// Update the readout synchronously (cheap, and the user wants instant feedback)
// and, when `persist`, schedule the history write. The write is debounced and
// skipped when the hash is unchanged, so a burst of commits collapses to at
// most one `replaceState` (which browsers rate-limit) shortly after the view
// settles.
//
// `persist` is false for a `refit`: a window/canvas resize changes only the
// buffer's width/height, which are deliberately excluded from `ViewState`
// (they describe the device, not the view — see view-state.ts), so the
// serialized framing is identical before and after. Writing anyway would dirty
// a first-time visitor's clean URL on a mere resize — turning `#`-less into a
// full permalink without them ever moving the view. We still re-render the
// readout (harmless; the centre/zoom are unchanged) but leave the URL alone.
const syncView = (persist = true): void => {
  const state = currentViewState()
  renderCoords(state)
  if (!persist) return
  const hash = serialize(state)
  if (urlWriteTimer !== undefined) {
    clearTimeout(urlWriteTimer)
  }
  urlWriteTimer = setTimeout(() => {
    urlWriteTimer = undefined
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash)
    }
  }, URL_WRITE_DEBOUNCE_MS)
}

// Show the boot coordinates immediately, but do NOT write the URL yet: a
// first-time visitor's clean URL stays clean until they move the view, and a
// visitor who arrived via a shared hash keeps that exact hash untouched.
renderCoords(currentViewState())

// Every viewport write — a committed pan/zoom, a refit, a mode-reset — paints
// the new frame and re-syncs the readout + URL. A pan/zoom invalidates the
// iteration buffer by definition, so this routes through `render` (which
// refreshes the cache too), never `recolorize`. Subscribing here is the *only*
// thing that turns a `store.set` into pixels, so a future viewport writer needs
// no render call of its own. A `refit` (resize) re-renders without persisting
// to the URL — it never changes the serialized view (see `syncView`).
store.subscribe((_viewport, source) => {
  rerender()
  syncView(source !== 'refit')
})

// Orbit visualizer (E1, #94). A presentation-only overlay: it reads the
// authoritative viewport from the store (subscribing for re-projection on every
// commit) and is fed the compute parameters by `applySettings`/`hashchange`
// below. Constructed before the InputController so its `pin` is in scope for the
// controller's click callback. The drawer-open guard makes a light-dismiss
// click (and `Escape`) defer to the drawer rather than pin/un-pin.
const orbitOverlay = new OrbitOverlay(
  orbitCanvas,
  canvas,
  store,
  {
    mode: current.mode,
    cRe: current.cRe,
    cIm: current.cIm,
    maxIter: current.maxIter,
    enabled: current.orbit,
  },
  () => controlsForm.classList.contains('open'),
)

// Whether the controls drawer was open at the *start* of the current press.
// The drawer's light-dismiss (drawer.ts) closes the drawer on the canvas
// `pointerup`, which runs before the InputController's `pointerup` delivers the
// click below — so by then the live `.open` class already reads closed.
// Capturing the state at `pointerdown` (which only arms the dismiss, never
// closes it) lets the c-picker treat a dismiss Alt-click as a dismiss, not a
// pick. Neither the drawer's nor the controller's own `pointerdown` listener
// mutates `.open`, so registration order here is irrelevant.
let drawerOpenAtPress = false
canvas.addEventListener('pointerdown', () => {
  drawerOpenAtPress = controlsForm.classList.contains('open')
})

// The controller needs no binding: it wires its own canvas listeners and
// subscribes to the store in its constructor, and main.ts now reaches the
// viewport through the store rather than through the controller.
new InputController(
  canvas,
  store,
  // While a wheel Preview is active, drop any in-flight render so a
  // premature Settle's frame can't paint mid-scrub and clear the Preview
  // transform out from under the gesture (ADR-0012).
  discardInFlight,
  // A click (no drag) routes by modifier, reusing the controller's canonical
  // click-vs-pan classification (the deadzone branch):
  //  - Alt-click in Mandelbrot mode picks the Julia constant at the clicked
  //    point and switches to Julia (O2, #92).
  //  - any other click seeds/pins the orbit at that point (E1, #94).
  (cssX, cssY, modifiers) => {
    // A click that *began* while the drawer was open is a light-dismiss, not a
    // c-pick (the live `.open` class can't be used — the dismiss already
    // cleared it on the canvas `pointerup`; see `drawerOpenAtPress`).
    if (modifiers.altKey && current.mode === 'mandelbrot' && !drawerOpenAtPress) {
      const view = viewGeometryFromStore(store, canvas)
      if (view !== null) {
        const { re, im } = cssToComplex(cssX, cssY, view)
        const next = pickJuliaSettings(current, re, im)
        // Mirror the picked settings into the form (no emit), then run the
        // dispatcher exactly as the hashchange handler does: branch 1 (mode
        // change) resets to the Julia default view and rerenders with the
        // picked c, and `syncView` persists the new view to the URL.
        controls.applySettings(next)
        applySettings(next)
        syncView()
      }
      return
    }
    // A click that began while the drawer was open is a light-dismiss, not an
    // orbit pin either: `orbitOverlay.pin` guards on the *live* `.open` class,
    // which the dismiss already cleared on the canvas `pointerup` before this
    // controller's `pointerup` runs — so the same press-time flag must suppress
    // the pin. The flag re-arms on the next `pointerdown`, so no reset is needed.
    if (drawerOpenAtPress) return
    orbitOverlay.pin(cssX, cssY)
  },
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
  const viewport = store.get()
  if (width === viewport.width() && height === viewport.height()) {
    return
  }
  // One `set` does the whole job: the store subscription rerenders, and the
  // InputController's subscription mirrors the resized viewport into its
  // working copy (and tears down any live wheel Preview) — the second job the
  // old `inputController.setViewport` call carried.
  store.set(viewport.with_resolution(width, height), 'refit')
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

// `applySettings` and `controls` reference each other (the handler back-writes
// sanitised c values via `controls.setCValues`, and `controls` dispatches to
// the handler), so `controls` is forward-declared and assigned below. The
// handler is a const arrow rather than a hoisted `function` so TypeScript keeps
// the module-level `ctx`-not-null narrowing inside it.
let controls: Controls
const applySettings = (rawNext: Settings): void => {
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

  // Feed the orbit overlay the live compute parameters *before* any branch
  // below writes the store: branch 1's `mode-reset` set notifies synchronously,
  // and the overlay must already have cleared its pin (mode change flips the
  // seed's meaning) by the time its store subscription fires. This also
  // enables/disables the overlay and updates the shown orbit for a c/maxIter
  // change — none of which touch the fractal render path.
  orbitOverlay.sync({
    mode: next.mode,
    cRe,
    cIm,
    maxIter: next.maxIter,
    enabled: next.orbit,
  })

  // Branch 1: fractal-family change. Reset the viewport to the
  // canonical "starting frame" for the new family so the user lands
  // on the whole structure instead of an arbitrary deep dive that
  // happened to be loaded for the previous family. The viewport keeps
  // the current logical (window) dimensions; render scale is applied
  // later, at the render seam, so it is not part of the viewport here.
  if (next.mode !== current.mode) {
    const view = next.mode === 'mandelbrot' ? MANDELBROT_DEFAULT_VIEW : JULIA_DEFAULT_VIEW
    const vp = store.get()
    // Commit `current` before the `set`: the store notifies synchronously, so
    // the rerender subscription fires inside `set` and must already see the new
    // settings. The `set` (source `'mode-reset'`) also drives the rerender and
    // the InputController's Preview teardown — the work the old explicit
    // `inputController.setViewport` + `rerender` pair did.
    current = next
    store.set(new Viewport(view.re, view.im, view.zoom, vp.width(), vp.height()), 'mode-reset')
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
}

controls = new Controls(controlsForm, current, (rawNext) => {
  // Apply the committed change, then persist + read out the resulting view.
  // A mode change also writes the store (branch 1), whose subscription already
  // fired `syncView` — the call here is then a debounced no-op for that case,
  // and the sole trigger for the render-scale / compute / visual / no-op
  // branches, none of which touch the store.
  applySettings(rawNext)
  syncView()
})

// Apply a permalink edited in place (O1, #91). The boot read of `location.hash`
// is one-shot; a hash changed in an already-open tab — a pasted permalink, a
// back/forward step, a clicked `#`-link — fires `hashchange` *without*
// reloading the document, so without this the new view would be silently
// ignored (and overwritten by the next commit). Our own `replaceState` writes
// never fire `hashchange`, so this can't echo or loop. Render scale is
// preserved (it isn't in the hash); the resolved settings are mirrored into
// the form via `applySettings`, and the framing is applied through the store —
// whose subscription rerenders and re-syncs the readout/URL. The store write
// re-uses the current logical dimensions, and its `syncView` is a no-op write
// when the resolved hash already matches the bar (it only canonicalises a
// partial hash).
window.addEventListener('hashchange', () => {
  const { view, settings } = resolveView(window.location.hash, current.renderScale)
  current = settings
  controls.applySettings(settings)
  applyAccent(settings.palette)
  // Mirror the resolved compute params into the overlay before the store write,
  // same ordering rationale as the dispatcher's `sync` above.
  orbitOverlay.sync({
    mode: settings.mode,
    cRe: settings.cRe,
    cIm: settings.cIm,
    maxIter: settings.maxIter,
    enabled: settings.orbit,
  })
  const live = store.get()
  store.set(new Viewport(view.re, view.im, view.zoom, live.width(), live.height()), 'hashchange')
})

// PNG export (O2, #92). Both buttons render the *requested* (latest committed)
// state off-screen on a dedicated one-shot worker (see export-png.ts) rather
// than grabbing the on-screen canvas, so the saved pixels always match the
// permalink the filename embeds — even mid-render, when the canvas still shows
// the previous frame. `multiplier` scales the on-screen Resolution knob:
// `1` reproduces the on-screen frame faithfully; `2` supersamples for a sharper
// export (twice the on-screen sample density). Both ride the same
// `computeBufferDims` machinery as every render, so the pixel budget
// (`MAX_RENDER_PIXELS`) still clamps a huge window's export.
const EXPORT_SUPERSAMPLE = 2
const buildExportRequest = (multiplier: number): RenderRequest => {
  const viewport = store.get()
  const { width, height, scale } = computeBufferDims(
    viewport.width(),
    viewport.height(),
    current.renderScale * multiplier,
    MAX_RENDER_PIXELS,
  )
  return {
    kind: 'render',
    epoch: 0, // a one-shot worker; epoch coalescing does not apply
    width,
    height,
    centerRe: viewport.center_re(),
    centerIm: viewport.center_im(),
    zoom: viewport.zoom() * scale,
    maxIter: current.maxIter,
    palette: paletteEnum(current.palette),
    mode: modeEnum(current.normalisation),
    fractalKind: kindEnum(current.mode),
    cRe: current.cRe,
    cIm: current.cIm,
    field: fieldEnum(current.field),
  }
}

// Serialise exports so a slow render can't overlap a second click, and reflect
// the busy state by disabling both buttons. The filename is built from the same
// `currentViewState()` the request renders, so the two always describe one frame.
let exporting = false
const runExport = async (multiplier: number): Promise<void> => {
  if (exporting) return
  exporting = true
  exportPngButton.disabled = true
  exportPng2xButton.disabled = true
  try {
    await exportRenderedFrame(buildExportRequest(multiplier), buildFilename(currentViewState()))
  } catch (error) {
    console.error('PNG export failed:', error)
  } finally {
    exporting = false
    exportPngButton.disabled = false
    exportPng2xButton.disabled = false
  }
}
exportPngButton.addEventListener('click', () => void runExport(1))
exportPng2xButton.addEventListener('click', () => void runExport(EXPORT_SUPERSAMPLE))
