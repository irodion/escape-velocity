import init, {
  colorize,
  colorize_len,
  compute,
  compute_len,
  Viewport,
} from '../wasm/fractal_wasm.js'

// Slice 1 hardcoded render constants (PRD #2). Slice 2 promotes
// viewport state to interactive input; Slice 3 promotes max_iter to UI.
const CANVAS_WIDTH = 800
const CANVAS_HEIGHT = 600
const CENTER_RE = -0.7435
const CENTER_IM = 0.1314
const ZOOM = 200.0
const MAX_ITER = 256

const canvas = document.getElementById('fractal')
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('canvas#fractal not found in index.html')
}
const ctx = canvas.getContext('2d')
if (ctx === null) {
  throw new Error('failed to acquire 2d canvas context')
}

const wasm = await init()

const viewport = new Viewport(CENTER_RE, CENTER_IM, ZOOM, CANVAS_WIDTH, CANVAS_HEIGHT)

const iterPtr = compute(viewport, MAX_ITER)
const iterLen = compute_len()
const rgbaPtr = colorize(iterPtr, iterLen, MAX_ITER)
const rgbaLen = colorize_len()

// View into WASM linear memory — no copy. ImageData wraps the same
// buffer; putImageData reads it synchronously, so the view's lifetime
// only needs to outlive this call.
const rgba = new Uint8ClampedArray(wasm.memory.buffer, rgbaPtr, rgbaLen)
const image = new ImageData(rgba, CANVAS_WIDTH, CANVAS_HEIGHT)
ctx.putImageData(image, 0, 0)
