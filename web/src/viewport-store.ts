import type { Viewport } from '../wasm/fractal_wasm.js'

/**
 * Who wrote a viewport — carried alongside every `set` so a subscriber can
 * tell its own writes apart from everyone else's.
 *
 *  - `gesture`   — the InputController committing a pan/zoom it just performed.
 *  - `refit`     — fit-to-window resizing the logical grid to the canvas box.
 *  - `mode-reset`— a fractal-family switch jumping to that family's start frame.
 *  - `hashchange`— a pasted/edited URL permalink applied live (O1, #91).
 *
 * The InputController subscribes to teardown its wheel Preview on any write
 * that *isn't* `gesture` (its own commits already advanced the Preview, so
 * tearing down there would clear the frame the Settle wants to keep). New
 * writers (bookmarks, a reset-view button) pick a label here.
 */
export type ViewportSource = 'gesture' | 'refit' | 'mode-reset' | 'hashchange'

export type ViewportListener = (viewport: Viewport, source: ViewportSource) => void

/**
 * The single authoritative home of the on-screen Viewport (A2, #85).
 *
 * Before this, the viewport lived in three places kept in manual lockstep —
 * `main.ts`'s `let viewport`, `InputController.currentViewport`, and (mid-scrub)
 * `ZoomPreview.viewport` — synchronised by a two-direction ritual (`onChange`
 * controller → main, `setViewport` main → controller) that had to be repeated,
 * verbatim, after every viewport mutation. Forgetting one step silently desynced
 * the next gesture's origin from what was on screen (bug #72 was a live instance).
 *
 * The store collapses both paths into one: every writer calls `set`, every
 * reader calls `get`, and reactions (rerender, Preview teardown) are
 * `subscribe`rs. Adding the next state writer is a one-line `set` — no ritual to
 * remember. Notification is synchronous, so a `set` from a Controls handler has
 * rerendered before the handler returns.
 *
 * Note the controller still keeps a private working viewport during an active
 * scrub: per ADR-0012 the wheel Preview accumulates across notches *without*
 * writing the store (no recompute until the Settle), so the store stays at the
 * last settled frame until the gesture commits. The store is authoritative
 * everywhere except inside that one in-flight gesture.
 */
export interface ViewportStore {
  /** The current authoritative viewport. */
  get(): Viewport
  /** Replace the viewport and synchronously notify every subscriber. `source`
   *  identifies the writer so subscribers can skip their own writes. */
  set(viewport: Viewport, source: ViewportSource): void
  /** Register a listener for every `set`; returns an unsubscribe function. */
  subscribe(listener: ViewportListener): () => void
}

/** Build a store seeded with the boot viewport. */
export function createViewportStore(initial: Viewport): ViewportStore {
  let current = initial
  const listeners = new Set<ViewportListener>()
  return {
    get: () => current,
    set: (viewport, source) => {
      current = viewport
      // Iterate a copy so a listener that (un)subscribes during dispatch
      // doesn't mutate the set mid-iteration.
      for (const listener of [...listeners]) {
        listener(viewport, source)
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
