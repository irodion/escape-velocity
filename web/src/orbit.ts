import type { FractalMode } from './controls.js'
import { cssToComplex, revealedCount, traceOrbit, type ViewGeometry } from './orbit-math.js'
import type { ViewportStore } from './viewport-store.js'

// The diagram is a compact, self-contained inset — its side is this fraction of
// the smaller viewport dimension, so it never exceeds ~⅓ of the image (E1 UX
// feedback: a full-image path reads as noise; a localized one reads as a chart).
const DIAGRAM_FRACTION = 1 / 3

// Gap between the cursor/anchor and the diagram box, so it sits *beside* the
// pointer rather than under it.
const DIAGRAM_GAP = 18

// Cap on iterates plotted in the diagram. An interior orbit settles onto its
// cycle within a few dozen steps; plotting thousands just overdraws the same
// cluster and makes the animation crawl.
const ORBIT_DRAW_CAP = 160

// Looping trace animation: one full reveal + hold every period; the first
// `SWEEP` of the period walks z₀→z₁→z₂…, the rest holds the settled path.
const ANIM_PERIOD_MS = 2600
const ANIM_SWEEP = 0.8

// Floor on the orbit's complex-space extent when fitting it to the box, so a
// fixed-point / near-constant orbit doesn't divide by ~0 and explode the scale.
const MIN_SPAN = 1e-4

const TAU = Math.PI * 2

// An orbit to show: the complex point that defines it (the cursor's c in
// Mandelbrot, z₀ in Julia) plus the screen position to anchor the diagram at.
interface Anchored {
  readonly point: { re: number; im: number }
  readonly anchor: { x: number; y: number }
}

/**
 * Flatten the authoritative viewport plus a surface's CSS box into the
 * `ViewGeometry` the projection helpers need. Returns null for a degenerate box
 * (a `display:none` or pre-layout canvas), so callers can bail rather than feed
 * NaN coordinates into `cssToComplex`. Shared by the orbit overlay and the Julia
 * c-picker (O2, #92) so the two derive the cursor→complex mapping identically.
 */
export function viewGeometryFromStore(
  store: ViewportStore,
  surface: HTMLElement,
): ViewGeometry | null {
  const rect = surface.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const vp = store.get()
  return {
    centerRe: vp.center_re(),
    centerIm: vp.center_im(),
    zoom: vp.zoom(),
    logicalW: vp.width(),
    logicalH: vp.height(),
    rectW: rect.width,
    rectH: rect.height,
  }
}

/**
 * The orbit visualizer overlay (E1, #94).
 *
 * With the feature enabled, hovering the fractal draws a compact, animated
 * diagram *beside the cursor* showing the iteration orbit `z₀ → z₁ → z₂ → …` of
 * the point under the pointer; a left-click *pins* the diagram in place, and
 * `Escape` un-pins it. The trace animates on a loop — a bright head marker walks
 * the path as it draws in, then holds the settled shape — so the dynamics
 * (spiralling into the cardioid, settling into a short cycle, flying past the
 * escape circle) are visible rather than a static one-shot path.
 *
 * The diagram is a self-contained chart in its own local frame: the orbit's
 * complex-space bounding box is fit into a box ≤ ⅓ of the viewport, anchored at
 * the cursor. This keeps it always on-screen and legible regardless of where
 * the orbit actually lives in the plane (e.g. a Mandelbrot orbit starts at the
 * origin, which is usually off-screen) — the high-level shape matters more than
 * the absolute position. It is therefore viewport-independent: panning/zooming
 * the fractal does not change a pinned orbit, so the overlay does not subscribe
 * to the `ViewportStore`; it only reads it to map the cursor to a complex point.
 *
 * ## Mode semantics
 * - Mandelbrot: the point under the cursor is `c`; the orbit starts at `z₀ = 0`.
 * - Julia: the point is `z₀`; `c` is the current Julia seed.
 */
export class OrbitOverlay {
  private readonly ctx: CanvasRenderingContext2D | null
  private pinned: Anchored | null = null
  private hover: Anchored | null = null
  private rafHandle: number | null = null
  // Timestamp the current animation loop started, set on its first frame so the
  // walk always begins at z₀. Null while idle.
  private animStart: number | null = null
  private accent = '#5fd0c0'
  private mode: FractalMode
  private cRe: number
  private cIm: number
  private maxIter: number
  private enabled: boolean

  constructor(
    private readonly overlay: HTMLCanvasElement,
    private readonly surface: HTMLCanvasElement,
    private readonly store: ViewportStore,
    initial: { mode: FractalMode; cRe: number; cIm: number; maxIter: number; enabled: boolean },
    // Whether the controls drawer is open. A click that lands while it is open
    // is a light-dismiss, not a pin — so we suppress pinning then (and `Escape`
    // closes the drawer rather than un-pinning).
    private readonly isDrawerOpen: () => boolean,
  ) {
    this.ctx = overlay.getContext('2d')
    this.mode = initial.mode
    this.cRe = initial.cRe
    this.cIm = initial.cIm
    this.maxIter = initial.maxIter
    this.enabled = initial.enabled
    this.refreshAccent()

    // Hover follows the cursor; pointer events are on the (pointer-eventful)
    // fractal surface — the overlay itself is `pointer-events: none`.
    this.surface.addEventListener('mousemove', this.handleHover)
    this.surface.addEventListener('mouseleave', this.handleLeave)
    // A drag/wheel that begins on the surface dismisses a transient hover
    // diagram (you're navigating, not inspecting); a pinned one stays put.
    this.surface.addEventListener('mousedown', this.handleGestureStart)
    this.surface.addEventListener('wheel', this.handleGestureStart, { passive: true })
    document.addEventListener('keydown', this.handleKeydown)
  }

  /** Pin the orbit at a CSS pixel on the surface (fed by InputController's click). */
  pin(cssX: number, cssY: number): void {
    if (!this.enabled || this.isDrawerOpen()) return
    const view = this.geometry()
    if (view === null) return
    this.pinned = { point: cssToComplex(cssX, cssY, view), anchor: { x: cssX, y: cssY } }
    this.start()
  }

  /**
   * Mirror the live compute settings. Clears the pin on a mode switch (the
   * seed's meaning changes), then keeps the animation running with the new
   * parameters — or stops/clears when the feature is toggled off or nothing is
   * being shown. Called by main.ts on every settings commit. The running loop
   * reads `mode`/`c`/`maxIter` each frame, so a change is reflected on the next
   * frame without restarting the animation.
   */
  sync(next: {
    mode: FractalMode
    cRe: number
    cIm: number
    maxIter: number
    enabled: boolean
  }): void {
    if (next.mode !== this.mode) {
      this.pinned = null
      this.hover = null
    }
    this.mode = next.mode
    this.cRe = next.cRe
    this.cIm = next.cIm
    this.maxIter = next.maxIter
    this.enabled = next.enabled
    this.refreshAccent()
    if (!this.enabled || this.active() === null) {
      this.stop()
      return
    }
    this.start()
  }

  private readonly handleHover = (event: MouseEvent): void => {
    if (!this.enabled || this.pinned !== null) return
    // Don't track while a gesture owns the image: a drag shifts the buffer and
    // a wheel Preview CSS-transforms the canvas, so the cursor→complex mapping
    // would be wrong until the store settles.
    if (this.surface.classList.contains('dragging') || this.surface.style.transform !== '') return
    const view = this.geometry()
    if (view === null) return
    const rect = this.overlay.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    this.hover = { point: cssToComplex(x, y, view), anchor: { x, y } }
    this.start()
  }

  private readonly handleLeave = (): void => {
    // A pinned diagram survives the cursor leaving; a transient hover doesn't.
    if (this.pinned !== null) return
    this.hover = null
    this.stop()
  }

  private readonly handleGestureStart = (): void => {
    if (this.pinned !== null) return
    this.hover = null
    this.stop()
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.isDrawerOpen()) return
    if (this.pinned === null) return
    this.pinned = null
    this.hover = null
    this.stop()
  }

  // The orbit currently shown: an explicit pin wins over a transient hover.
  private active(): Anchored | null {
    return this.pinned ?? this.hover
  }

  // Begin (or keep) the animation loop. Draws one frame synchronously for
  // instant feedback, then schedules the loop. A no-op if already running — the
  // running loop picks up new hover/settings state on its next frame.
  private start(): void {
    if (this.rafHandle !== null) return
    const act = this.active()
    if (!this.enabled || act === null) return
    this.drawFrame(act, 0)
    this.animStart = null
    this.rafHandle = requestAnimationFrame(this.tick)
  }

  // Stop the loop and clear the overlay. Cancels any queued frame so a late
  // tick can't repaint after an intentional clear.
  private stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    this.animStart = null
    this.clearCanvas()
  }

  private readonly tick = (timestamp: number): void => {
    this.rafHandle = null
    const act = this.active()
    if (!this.enabled || act === null) {
      this.animStart = null
      this.clearCanvas()
      return
    }
    if (this.animStart === null) this.animStart = timestamp
    this.drawFrame(act, timestamp - this.animStart)
    this.rafHandle = requestAnimationFrame(this.tick)
  }

  private geometry(): ViewGeometry | null {
    return viewGeometryFromStore(this.store, this.overlay)
  }

  private refreshAccent(): void {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    if (value !== '') this.accent = value
  }

  private clearCanvas(): void {
    if (this.ctx === null) return
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height)
  }

  private drawFrame(act: Anchored, elapsedMs: number): void {
    const ctx = this.ctx
    if (ctx === null) return
    const rect = this.overlay.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    // Size the backing store to the CSS box × DPR for crisp vectors, draw in CSS
    // pixels. (Re-checked every frame so a window resize is picked up here.)
    const dpr = window.devicePixelRatio || 1
    const bw = Math.round(rect.width * dpr)
    const bh = Math.round(rect.height * dpr)
    if (this.overlay.width !== bw) this.overlay.width = bw
    if (this.overlay.height !== bh) this.overlay.height = bh
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    // Mandelbrot: c = point, z₀ = 0. Julia: z₀ = point, c = the seed.
    const z0Re = this.mode === 'mandelbrot' ? 0 : act.point.re
    const z0Im = this.mode === 'mandelbrot' ? 0 : act.point.im
    const cRe = this.mode === 'mandelbrot' ? act.point.re : this.cRe
    const cIm = this.mode === 'mandelbrot' ? act.point.im : this.cIm
    const orbit = traceOrbit(z0Re, z0Im, cRe, cIm, this.maxIter)
    const total = orbit.length / 2
    if (total === 0) return
    const nDrawn = Math.min(total, ORBIT_DRAW_CAP)
    const revealed = revealedCount(elapsedMs, nDrawn, ANIM_PERIOD_MS, ANIM_SWEEP)

    // Fit the plotted orbit's complex-space bounding box into the box.
    let minRe = Number.POSITIVE_INFINITY
    let maxRe = Number.NEGATIVE_INFINITY
    let minIm = Number.POSITIVE_INFINITY
    let maxIm = Number.NEGATIVE_INFINITY
    for (let i = 0; i < nDrawn; i++) {
      const re = orbit[i * 2]
      const im = orbit[i * 2 + 1]
      if (re < minRe) minRe = re
      if (re > maxRe) maxRe = re
      if (im < minIm) minIm = im
      if (im > maxIm) maxIm = im
    }
    const span = Math.max(maxRe - minRe, maxIm - minIm, MIN_SPAN)
    const cReMid = (minRe + maxRe) / 2
    const cImMid = (minIm + maxIm) / 2

    // Box geometry: a square ≤ ⅓ of the viewport, beside the anchor, clamped to
    // stay fully on-screen (flips to the other side of the cursor near an edge).
    const side = Math.min(rect.width, rect.height) * DIAGRAM_FRACTION
    const pad = side * 0.14
    const scale = (side - 2 * pad) / span
    let bx = act.anchor.x + DIAGRAM_GAP
    let by = act.anchor.y + DIAGRAM_GAP
    if (bx + side > rect.width) bx = act.anchor.x - DIAGRAM_GAP - side
    if (by + side > rect.height) by = act.anchor.y - DIAGRAM_GAP - side
    bx = clamp(bx, 0, Math.max(0, rect.width - side))
    by = clamp(by, 0, Math.max(0, rect.height - side))
    const midX = bx + side / 2
    const midY = by + side / 2
    // Complex → box pixel: centre the bbox in the box; flip y (im grows up).
    const mapX = (re: number): number => midX + (re - cReMid) * scale
    const mapY = (im: number): number => midY - (im - cImMid) * scale

    const rgb = hexToRgb(this.accent)

    // Panel: a faint inset slab + hairline border, then clip to it so nothing
    // (a far iterate, the escape circle) spills onto the fractal.
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(bx, by, side, side, 4)
    ctx.fillStyle = 'rgba(8, 11, 16, 0.66)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.clip()

    // The classic |z| = 2 circle: the textbook Mandelbrot escape radius, drawn
    // as a pedagogical reference — NOT the renderer's numerical bailout, which
    // is the much larger |z| > 256 (BAILOUT_SQR = 65536). A diverging orbit
    // passes beyond radius 2 on its way out, but a bounded orbit can also wander
    // outside it without escaping, so reaching it does not imply escape.
    ctx.beginPath()
    ctx.ellipse(mapX(0), mapY(0), 2 * scale, 2 * scale, 0, 0, TAU)
    ctx.strokeStyle = `rgba(${rgb}, 0.18)`
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])

    // Revealed path (z₀ … current head).
    if (revealed >= 2) {
      ctx.beginPath()
      ctx.moveTo(mapX(orbit[0]), mapY(orbit[1]))
      for (let i = 1; i < revealed; i++) ctx.lineTo(mapX(orbit[i * 2]), mapY(orbit[i * 2 + 1]))
      ctx.strokeStyle = `rgba(${rgb}, 0.55)`
      ctx.lineWidth = 1.4
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    // Per-iterate dots, alpha-ramped oldest → newest within the revealed run.
    for (let i = 0; i < revealed; i++) {
      const alpha = revealed === 1 ? 1 : 0.25 + 0.75 * (i / (revealed - 1))
      ctx.beginPath()
      ctx.arc(mapX(orbit[i * 2]), mapY(orbit[i * 2 + 1]), 1.8, 0, TAU)
      ctx.fillStyle = `rgba(${rgb}, ${alpha})`
      ctx.fill()
    }

    // z₀ marker: a hollow ring so the orbit's start reads clearly.
    ctx.beginPath()
    ctx.arc(mapX(orbit[0]), mapY(orbit[1]), 3.5, 0, TAU)
    ctx.strokeStyle = `rgba(${rgb}, 0.85)`
    ctx.lineWidth = 1.2
    ctx.stroke()

    // The animated head: a bright dot with a soft ring at the current iterate.
    const hi = revealed - 1
    const hx = mapX(orbit[hi * 2])
    const hy = mapY(orbit[hi * 2 + 1])
    ctx.beginPath()
    ctx.arc(hx, hy, 5.5, 0, TAU)
    ctx.strokeStyle = `rgba(${rgb}, 0.5)`
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(hx, hy, 3.2, 0, TAU)
    ctx.fillStyle = `rgba(${rgb}, 1)`
    ctx.fill()

    ctx.restore()
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

// Parse `#rgb` / `#rrggbb` into an `r, g, b` string for `rgba(...)`. The accent
// is always one of main.ts's hex PALETTE_ACCENT values, so this stays simple;
// it falls back to the default viridis accent on anything unexpected.
function hexToRgb(hex: string): string {
  let h = hex.replace('#', '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((ch) => ch + ch)
      .join('')
  }
  if (h.length !== 6) return '95, 208, 192'
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return '95, 208, 192'
  return `${r}, ${g}, ${b}`
}
