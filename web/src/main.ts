import init, { Viewport } from '../wasm/fractal_wasm.js'
import { InputController } from './input.js'
import { render } from './render.js'

// Slice 1 hardcoded initial render constants (PRD #2). Slice 2 keeps
// the same opening view but promotes the viewport to a mutable handle
// driven by InputController.
const CANVAS_WIDTH = 800
const CANVAS_HEIGHT = 600
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

const wasm = await init()

let viewport = new Viewport(CENTER_RE, CENTER_IM, ZOOM, CANVAS_WIDTH, CANVAS_HEIGHT)
render(viewport, ctx, wasm)

new InputController(canvas, viewport, (next) => {
  viewport = next
  render(viewport, ctx, wasm)
})
