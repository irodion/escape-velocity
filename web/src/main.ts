import init, { Viewport } from '../wasm/fractal_wasm.js'
import { Controls } from './controls.js'
import { InputController } from './input.js'
import { render } from './render.js'

// Slice 1 hardcoded initial render constants (PRD #2); Slice 3 promotes
// `maxIter` and canvas dimensions to form-driven `let`s but preserves
// the same opening view.
const INITIAL_WIDTH = 800
const INITIAL_HEIGHT = 600
const INITIAL_MAX_ITER = 256
const CENTER_RE = -0.7435
const CENTER_IM = 0.1314
const ZOOM = 200.0

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
let maxIter = INITIAL_MAX_ITER
// `Viewport` from wasm-bindgen does not expose `width`/`height` as JS
// getters (keeping the WASM surface minimal). Track the current dims
// here so the resolution-change branch can detect a real resize.
let currentWidth = INITIAL_WIDTH
let currentHeight = INITIAL_HEIGHT

const rerender = (): void => {
  render(viewport, ctx, wasm, maxIter)
}

rerender()

const inputController = new InputController(canvas, viewport, (next) => {
  viewport = next
  rerender()
})

new Controls(
  controlsForm,
  { maxIter: INITIAL_MAX_ITER, width: INITIAL_WIDTH, height: INITIAL_HEIGHT },
  ({ maxIter: nextMaxIter, width, height }) => {
    maxIter = nextMaxIter
    if (width !== currentWidth || height !== currentHeight) {
      // Lockstep: viewport dims, canvas internal dims, and the
      // controller's viewport reference all advance together so
      // `putImageData` receives a buffer sized to the canvas and
      // subsequent pan/zoom uses the right `pixel_scale`.
      viewport = viewport.with_resolution(width, height)
      canvas.width = width
      canvas.height = height
      currentWidth = width
      currentHeight = height
      inputController.setViewport(viewport)
    }
    rerender()
  },
)
