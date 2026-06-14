# ADR-0014: Pointer Events for input; two-finger pinch-zoom reusing the Preview/Settle

- Status: Accepted
- Date: 2026-06-14

## Context

The app is a PWA that explicitly targets mobile ([ADR-0009](0009-pwa-as-late-slice.md),
Slice 8), yet the core interaction was dead on touch (U1, #88). The input layer
([input.ts](../../web/src/input.ts)) registered only `mousedown` and `wheel`
listeners — there was no `pointerdown`/`touchstart` path anywhere, no
pinch-zoom, and the canvas had no `touch-action`. On a phone or tablet a
one-finger drag did nothing (the browser synthesised a click, which only
*closed the drawer*), and a two-finger pinch zoomed the **page**, not the
fractal. A user could install the app but could not explore the fractal.

The mobile *chrome* was already in good shape (`100dvh`, `viewport-fit=cover`,
safe-area insets, `overscroll-behavior: contain`); only the gestures were
missing.

[ADR-0012](0012-instant-zoom-feedback-transform-preview.md) already built a
cursor-anchored zoom **Preview** (a GPU CSS transform) and a debounced
**Settle**, and isolated the matrix algebra in a pure, DOM-free accumulator
([zoom-preview.ts](../../web/src/zoom-preview.ts)). That ADR explicitly deferred
unifying gestures: *"Unify pan into the same transform matrix now. Rejected…
Revisited only when pinch-zoom lands."* Pinch-zoom is now landing.

## Decision

Speak **Pointer Events** (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`)
throughout the input layer instead of mouse and touch events, and add a
two-finger pinch path that reuses the ADR-0012 accumulator.

1. **One unified pointer code path.** Pointer Events normalise mouse, trackpad,
   pen, and touch into one stream. `input.ts` tracks the set of down pointers
   in a `Map` keyed by `pointerId`: one pointer pans (the existing in-buffer
   drag-shift preview, unchanged), two pointers pinch, and a press that moves
   less than `PAN_DEADZONE_PX` is a click/tap (the existing deadzone branch that
   feeds the orbit pin and Julia c-picker). Migrating off mouse events also
   removes the double-handling hazard of synthesised compatibility mouse events
   on touch.

2. **`setPointerCapture` replaces the document-level listeners.** On
   `pointerdown` the controller captures the pointer to the canvas, so
   `pointermove`/`pointerup` route to the canvas for the whole gesture even past
   the box edge. The move/up/cancel listeners therefore live on the canvas, not
   `document`. The call is optional-chained (`canvas.setPointerCapture?.(id)`)
   because jsdom — the test DOM — does not implement pointer capture; every
   production browser does.

3. **Pinch reuses the Preview/Settle accumulator unchanged.** The change in
   inter-pointer distance between two moves is the zoom factor, anchored at the
   inter-pointer **midpoint**, fed through the same `applyZoomNotch` path the
   wheel uses (midpoint → logical grid for `zoom_around`, → CSS box for the
   transform anchor). The CSS transform updates live; the store is written once
   on **Settle**. Unlike the wheel, a pinch has explicit brackets (a finger
   lifting), so it Settles immediately on `pointerup` rather than on a debounced
   timer. `zoom-preview.ts` needed **no changes** — it was already
   input-device-agnostic.

4. **Graceful pan→pinch transition.** A real pinch almost always begins as a
   one-finger pan for a few milliseconds before the second finger lands. When
   the second pointer goes down, the controller restores the canvas buffer to
   the un-panned frame (the pan never committed, so `currentViewport` still
   depicts it) by re-blitting the snapshot at the origin, then begins the pinch
   from `currentViewport`. A leftover finger after a pinch ends does **not**
   resume a pan (that would jump the image); a new pan begins only on a fresh
   `pointerdown` once all fingers have lifted. `pointercancel` tears the gesture
   down the same way `pointerup` does.

5. **`touch-action: none` on the canvas.** The canvas owns every gesture; the
   browser no longer claims one-finger drags for scroll or two-finger pinches
   for page zoom.

The drawer's light-dismiss ([drawer.ts](../../web/src/drawer.ts)) and the
`drawerOpenAtPress` capture in [main.ts](../../web/src/main.ts) move to the same
pointer events, so a touch tap dismisses the drawer exactly like a mouse click
with no reliance on synthesised events.

## Consequences

### Positive

- Delivers the intent: pan and pinch-zoom work on touch, so the PWA is usable on
  the devices it targets.
- One input code path for all pointing devices; the synthesised-mouse-event
  double-handling hazard is gone.
- Pinch is built entirely from the existing ADR-0012 machinery — the trickiest
  logic (cursor-anchored matrix algebra, clamp consistency) is reused, not
  re-derived, and stays unit-tested in the pure accumulator.
- `setPointerCapture` makes "drag continues outside the canvas" a browser
  guarantee instead of a document-listener workaround.

### Negative

- Two-finger *translation* (panning the midpoint without changing distance) is
  not handled: a pure-translation step has factor ≈ 1, so the image does not
  follow. Pinch-zoom anchored at the midpoint is delivered; combined
  pan-while-pinching is left as possible future work.
- `setPointerCapture` must be optional-chained for jsdom, a small production/test
  divergence that a reader must understand (the capture path is exercised in
  browsers, stubbed in tests).
- Double-tap-to-zoom (noted as a gap in #88) is **not** included; it is deferred
  to a follow-up.
- Compatibility mouse events still fire on touch (we do not `preventDefault`
  them), so the orbit hover overlay (E1, mouse-only) may flicker briefly on a
  tap. Cosmetic and out of U1 scope.

## Alternatives considered

- **Keep mouse events and add separate `touchstart`/`touchmove` handlers.**
  Rejected: two parallel code paths to keep in sync, manual touch-vs-mouse
  coalescing, and the `Touch`/`TouchList` API is clumsier than per-pointer ids.
  Pointer Events unify all of it.
- **Settle the pinch on a debounced timer like the wheel.** Rejected: a pinch
  has an explicit end (a finger lifts), so there is nothing to debounce —
  committing on `pointerup` is both simpler and more responsive.
- **Resume a one-finger pan from the leftover finger when a pinch ends.**
  Rejected: the leftover finger is wherever it happened to be, so resuming a pan
  from it jumps the image. Requiring a fresh press is predictable.
- **Implement combined two-finger pan + zoom now.** Rejected for this slice: it
  needs a translation term threaded through the accumulator (or a richer affine);
  the issue scopes pinch-*zoom*, and midpoint-anchored zoom covers the core need.
- **`touch-action: pinch-zoom`/`pan-x`** etc. instead of `none`. Rejected: any
  value that leaves a gesture to the browser steals it from the canvas; the
  fractal needs all of them.

## Related

- [ADR-0012](0012-instant-zoom-feedback-transform-preview.md) — the Preview/Settle
  accumulator this pinch reuses; this ADR is the "revisited when pinch-zoom
  lands" it deferred.
- [ADR-0011](0011-zoom-keyed-to-reference-width.md) — the `zoom_around`
  convention the pinch advances, untouched.
- [ADR-0009](0009-pwa-as-late-slice.md) — the mobile/PWA target that makes touch
  input load-bearing.
- [CONTEXT.md](../../CONTEXT.md) — the *Preview* and *Settle* glossary terms.
- Issue #88 (U1) — the bug this ADR backs; B1 (#72) and B3 (#74), the mouseup
  commit-semantics fixes already folded into the migrated handlers.
