/**
 * Which gesture, if any, currently owns the fractal canvas (#159).
 *
 *  - `idle`     — none: the canvas shows a settled frame, pixel for pixel the
 *    store's viewport.
 *  - `dragging` — a one-pointer press is down. Once it leaves the click slop
 *    it is a pan, and the canvas buffer holds the drag snapshot shifted by the
 *    pointer; until then it may be a click, and a zoom Preview it pressed on
 *    stays on screen.
 *  - `preview`  — a zoom Preview (ADR-0012): a pinch in progress, or a wheel
 *    scrub CSS-scaling the frame, including a Settled zoom whose fresh frame
 *    hasn't painted yet.
 *
 * In any phase but `idle` the image on screen doesn't line up with the store's
 * viewport, so a hover readout (the orbit overlay, the pixel inspector) or a
 * pixel probe must hold off.
 */
export type GesturePhase = 'idle' | 'dragging' | 'preview'

/**
 * The live gesture phase. The `InputController` is its only writer; `main.ts`
 * creates it up front so the modules built before the controller (the render
 * client, the orbit overlay, the inspector) can be handed a reader. Those
 * modules used to infer the phase from the canvas's `.dragging` class and
 * inline `transform`, which spread the controller's private state across four
 * modules and tied them to how the Preview happens to be drawn.
 */
export interface GesturePhaseStore {
  get(): GesturePhase
  set(phase: GesturePhase): void
}

export function createGesturePhaseStore(): GesturePhaseStore {
  let phase: GesturePhase = 'idle'
  return {
    get: () => phase,
    set: (next) => {
      phase = next
    },
  }
}
