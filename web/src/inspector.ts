import { isGestureInProgress, viewGeometryFromStore } from './orbit.js'
import { cssToBufferPixel, cssToComplex } from './orbit-math.js'
import type { PixelProbe } from './render-client.js'
import type { FieldName, FractalMode } from './settings.js'
import { formatAxis } from './view-state.js'
import type { ViewportStore } from './viewport-store.js'

/**
 * The pixel inspector (E2, #95) — "why is this pixel this colour?".
 *
 * With the Inspect toggle on, hovering the fractal reads the pixel under the
 * cursor straight out of the worker's cached Field buffer (no recompute) and
 * shows, in a corner HUD, the whole ADR-0002/0013 pipeline for that one pixel:
 *
 * - the complex coordinate `c` (Mandelbrot) or `z₀` (Julia) under the cursor,
 * - the raw Field value — smooth `ν` (Escape Time), pixel-distance `d`
 *   (Distance Estimate), or "inside the set" for the NaN sentinel,
 * - where that value lands after the current normalisation (the `t ∈ [0, 1]`
 *   fed to the palette),
 * - and a swatch of the resulting colour.
 *
 * The coordinate is derived on the main thread (instant); the raw value, `t`,
 * and colour come back asynchronously from a `probe` message. The render client
 * gates probes on the cached buffer being stable, so this module stays simple:
 * it throttles hover to one probe per frame and renders whatever comes back.
 *
 * Presentation-only and viewport-independent like the orbit overlay: it reads
 * the `ViewportStore` to map the cursor but never subscribes to it.
 */
export class PixelInspector {
  private readonly swatch: HTMLElement
  private readonly coordKey: HTMLElement
  private readonly coordVal: HTMLElement
  private readonly rawKey: HTMLElement
  private readonly rawVal: HTMLElement
  private readonly tVal: HTMLElement

  private mode: FractalMode
  private field: FieldName
  private enabled: boolean

  // The latest cursor position awaiting a probe, coalesced to one probe per
  // animation frame (a hover fires far faster than 60 Hz). Null when idle.
  private pendingCursor: { clientX: number; clientY: number } | null = null
  private rafHandle: number | null = null
  // The coordinate of the most recent probe issued, rendered alongside whatever
  // probe result comes back. Null before the first hover / after the cursor leaves.
  private lastCoord: { re: number; im: number } | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly surface: HTMLCanvasElement,
    private readonly store: ViewportStore,
    initial: { mode: FractalMode; field: FieldName; enabled: boolean },
    // Issue a probe for render-buffer pixel `(px, py)`, returning whether it was
    // actually sent (the client refuses while the cached buffer is unstable).
    // main.ts wires this to `renderClient.probe` with the live palette/mode
    // enums; the result comes back via `showResult` (the client's `onProbeResult`).
    private readonly probe: (px: number, py: number) => boolean,
  ) {
    this.mode = initial.mode
    this.field = initial.field
    this.enabled = initial.enabled
    this.swatch = this.appendChild('inspector__swatch')
    this.coordKey = this.appendChild('inspector__key')
    this.coordVal = this.appendChild('inspector__val')
    this.rawKey = this.appendChild('inspector__key')
    this.rawVal = this.appendChild('inspector__val')
    this.appendChild('inspector__key').textContent = 't'
    this.tVal = this.appendChild('inspector__val')
    this.reset()
    this.applyVisibility()

    // Hover/leave on the (pointer-eventful) fractal surface; the HUD itself is
    // `pointer-events: none`. Same surface signals the orbit overlay listens to.
    this.surface.addEventListener('mousemove', this.handleHover)
    this.surface.addEventListener('mouseleave', this.handleLeave)
  }

  /**
   * Mirror the live compute settings (called by main.ts on every commit). Only
   * `mode`, `field`, and `enabled` matter to the readout — the cursor's coordinate
   * label, the raw-value units, and whether the HUD shows at all. Toggling off
   * hides the HUD and drops any pending hover.
   */
  sync(next: { mode: FractalMode; field: FieldName; enabled: boolean }): void {
    this.mode = next.mode
    this.field = next.field
    this.enabled = next.enabled
    if (!this.enabled) {
      this.lastCoord = null
      this.pendingCursor = null
    }
    this.applyVisibility()
    // Refresh the coordinate label / units in case mode or field changed while
    // a reading is on screen.
    if (this.enabled && this.lastCoord !== null) {
      this.renderCoord()
    }
  }

  /**
   * Deliver a probe result (wired to the render client's `onProbeResult`). Paints
   * the raw value, `t`, and colour swatch for the pixel last hovered. Ignored
   * when the inspector is off (a late response after the toggle flipped).
   */
  showResult(probe: PixelProbe): void {
    if (!this.enabled) return
    if (probe.inside) {
      this.rawVal.textContent = 'inside the set'
      this.rawVal.classList.add('inspector__val--inside')
      this.tVal.textContent = '—'
      this.swatch.style.background = '#000'
      return
    }
    this.rawVal.classList.remove('inspector__val--inside')
    this.rawVal.textContent = this.formatRaw(probe.raw)
    this.tVal.textContent = probe.t.toFixed(3)
    this.swatch.style.background = `rgb(${probe.r}, ${probe.g}, ${probe.b})`
  }

  private readonly handleHover = (event: MouseEvent): void => {
    if (!this.enabled) return
    // Don't track while a gesture owns the image — the cursor→pixel mapping would
    // be wrong until the store settles (the render client refuses the probe in
    // these windows too).
    if (isGestureInProgress(this.surface)) return
    this.pendingCursor = { clientX: event.clientX, clientY: event.clientY }
    if (this.rafHandle === null) {
      this.rafHandle = requestAnimationFrame(this.tick)
    }
  }

  private readonly handleLeave = (): void => {
    this.pendingCursor = null
    this.lastCoord = null
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    this.reset()
  }

  // One probe per frame for the latest cursor position (E2 throttling note).
  private readonly tick = (): void => {
    this.rafHandle = null
    const cursor = this.pendingCursor
    this.pendingCursor = null
    if (!this.enabled || cursor === null) return
    // One layout read per frame, shared between the view geometry and the
    // cursor→CSS-pixel offset.
    const rect = this.surface.getBoundingClientRect()
    const view = viewGeometryFromStore(this.store, this.surface, rect)
    if (view === null) return
    const x = cursor.clientX - rect.left
    const y = cursor.clientY - rect.top
    const pixel = cssToBufferPixel(
      x,
      y,
      rect.width,
      rect.height,
      this.surface.width,
      this.surface.height,
    )
    if (pixel === null) return
    // Only advance the readout if the probe is actually issued. When the render
    // client refuses it (a render is rewriting the buffer, or a Preview is live),
    // the whole HUD stays frozen on its last coherent reading instead of showing
    // a fresh coordinate paired with a stale value.
    if (!this.probe(pixel.px, pixel.py)) return
    this.lastCoord = cssToComplex(x, y, view)
    this.renderCoord()
  }

  private renderCoord(): void {
    this.coordKey.textContent = this.mode === 'julia' ? 'z₀' : 'c'
    this.rawKey.textContent = this.field === 'distance-estimate' ? 'd' : 'ν'
    if (this.lastCoord === null) {
      this.coordVal.textContent = '—'
      return
    }
    // `formatAxis` carries an explicit sign, so the imaginary part's leading
    // +/− doubles as the separator: e.g. `−0.74350 +0.13140i`.
    this.coordVal.textContent = `${formatAxis(this.lastCoord.re)} ${formatAxis(this.lastCoord.im)}i`
  }

  // Compact raw-value format: ~5 significant figures with trailing zeros
  // trimmed, plus a `px` unit for the resolution-independent distance estimate.
  private formatRaw(raw: number): string {
    const value = Number(raw.toPrecision(5)).toString()
    return this.field === 'distance-estimate' ? `${value} px` : value
  }

  private reset(): void {
    this.renderCoord()
    this.rawVal.classList.remove('inspector__val--inside')
    this.rawVal.textContent = '—'
    this.tVal.textContent = '—'
    this.swatch.style.background = '#000'
  }

  private applyVisibility(): void {
    this.root.hidden = !this.enabled
  }

  private appendChild(className: string): HTMLElement {
    const el = document.createElement('span')
    el.className = className
    this.root.append(el)
    return el
  }
}
