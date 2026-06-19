/**
 * The settings-change classifier — the most consequential decision logic
 * in the frontend, extracted from `main.ts` so it is pure and unit-tested.
 *
 * A settings commit can mean any of four things, and choosing wrong is a
 * real bug class: route a change through the cheap `recolorize` fast-path
 * (ADR-0002) when it actually invalidated the iteration buffer and you
 * recolour stale pixels; route a pure colour change through a full
 * recompute and you throw away the fast-path the whole pipeline split
 * exists to enable. ADR-0013 spells out the trap directly ("It must route
 * through `render` … never `recolorize`"). Keeping the decision here, as a
 * pure function over two `Settings` snapshots, makes every branch testable
 * in isolation — `main.ts` only carries out the verdict.
 */
import type { FractalMode, Settings } from './settings.js'

/** The canonical "starting frame" a viewport reset lands on. */
export type DefaultView = { readonly re: number; readonly im: number; readonly zoom: number }

/**
 * What a settings commit resolves to:
 * - `reset-view`  — fractal-family change: jump to the new family's default frame.
 * - `recompute`   — the iteration buffer is invalid; re-run `compute` + `colorize`.
 * - `recolorize`  — visual-only change: same buffer, new palette/normalisation (ADR-0002).
 * - `noop`        — nothing that affects the render changed.
 */
export type Transition =
  | { action: 'reset-view'; view: DefaultView }
  | { action: 'recompute' }
  | { action: 'recolorize' }
  | { action: 'noop' }

/**
 * The canonical starting frame for each family — so a family switch lands
 * the user on the whole structure instead of an arbitrary deep dive that
 * happened to be loaded for the previous family.
 */
const DEFAULT_VIEW_BY_MODE: Record<FractalMode, DefaultView> = {
  mandelbrot: { re: -0.5, im: 0.0, zoom: 1.0 },
  julia: { re: 0.0, im: 0.0, zoom: 1.0 },
}

/**
 * Substitute the last-known-finite c values for any non-finite entries in a
 * form snapshot. `<input type="number">` reports NaN for an empty / dash-only
 * `value`, and the WASM `compute` seam validates `c_re`/`c_im` for `is_finite()`
 * **unconditionally** — Mandelbrot ignores the c payload mathematically, but a
 * NaN still trips the boundary check. Without this substitution, the sequence
 * (Julia → clear c.re → toggle back to Mandelbrot) would store `cRe = NaN` and
 * throw on the next render.
 *
 * The substitution preserves the invariant "`current.cRe`/`current.cIm` are
 * always finite" — established at boot by the `Controls` construction-time NaN
 * guard, and closed here by always pulling the fallback from `current`.
 *
 * Returns the sanitised `next` plus `cBackWrite`: when a fallback fired, the
 * caller must back-write the substituted value into the DOM so the visible
 * field matches the rendered parameter (otherwise the user could clear c.re,
 * change palette, and recolour the cached Julia buffer — drawn with the
 * previous c — while the c.re field shows nothing). This function only decides;
 * the DOM write stays in `main.ts`.
 */
export function sanitizeSettings(
  current: Settings,
  raw: Settings,
): { next: Settings; cBackWrite: boolean } {
  const cRe = Number.isFinite(raw.cRe) ? raw.cRe : current.cRe
  const cIm = Number.isFinite(raw.cIm) ? raw.cIm : current.cIm
  const cBackWrite = cRe !== raw.cRe || cIm !== raw.cIm
  return { next: { ...raw, cRe, cIm }, cBackWrite }
}

/**
 * Classify a settings change against the current snapshot. Branches are
 * checked in priority order — the first matching axis wins, so a commit that
 * touches several axes at once resolves to its highest-priority effect (e.g.
 * a family switch that also changed the palette is still a `reset-view`).
 *
 * Expects `next` to be already sanitised (see {@link sanitizeSettings}), so the
 * c values reaching the recompute branch are always finite and safe for the
 * WASM seam.
 */
export function classifyTransition(current: Settings, next: Settings): Transition {
  // Branch 1: fractal-family change. Reset the viewport to the canonical
  // starting frame for the new family.
  if (next.mode !== current.mode) {
    return { action: 'reset-view', view: DEFAULT_VIEW_BY_MODE[next.mode] }
  }

  // Branch 2: render-scale change. A pure quality knob — the framing is
  // untouched, but the buffer dimensions and scale-compensated zoom change,
  // so the iteration buffer must be recomputed.
  if (next.renderScale !== current.renderScale) {
    return { action: 'recompute' }
  }

  // Branch 3: compute-class change — `maxIter`, or (in Julia mode only) a `c`
  // change. A c change in Mandelbrot mode carries no render effect (c is
  // ignored there) and falls through to the no-op below.
  const cChangedInJulia =
    next.mode === 'julia' && (next.cRe !== current.cRe || next.cIm !== current.cIm)
  if (next.maxIter !== current.maxIter || cChangedInJulia) {
    return { action: 'recompute' }
  }

  // Branch 3c: Field change — compute-class (ADR-0013). The Field is the
  // per-pixel scalar `compute` emits, so switching it invalidates the iteration
  // buffer exactly as `maxIter` / `c` do. It must route through `render` (a full
  // recompute), never `recolorize`, because the cached buffer holds a different
  // Field's values.
  if (next.field !== current.field) {
    return { action: 'recompute' }
  }

  // Branch 4: visual-only change. The ADR-0002 payoff — same iteration buffer,
  // new palette / normalisation, no recompute.
  if (next.palette !== current.palette || next.normalisation !== current.normalisation) {
    return { action: 'recolorize' }
  }

  // Branch 5: no-op. The user re-selected the same value, or `cRe` / `cIm`
  // changed in Mandelbrot mode (carried but ignored). The caller still commits
  // the snapshot so a later Julia switch sees the committed c values.
  return { action: 'noop' }
}
