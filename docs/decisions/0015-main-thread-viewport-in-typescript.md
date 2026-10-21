# ADR-0015: Viewport maths in TypeScript on the main thread; WASM only in the worker

- Status: Accepted
- Date: 2026-10-21

## Context

The viewport maths lived in two places (#172, from the 2026-10-17 project
review):

- **Rust**, `fractal_core::Viewport` ([viewport.rs](../../crates/fractal-core/src/viewport.rs)):
  the truth for compute. The main thread also used it, through the WASM
  binding's `Viewport` class, for pan, zoom and resize. That class was the
  only reason [main.ts](../../web/src/main.ts) instantiated the whole threaded,
  shared-memory module on the main thread: a second instance beside the
  worker's ([ADR-0007](0007-parallelism-via-wasm-threads.md)), with its own
  fatal-error path.
- **TypeScript**, `orbit-math.ts`: a hand-written mirror of the constants and
  the pixel ↔ complex projection, used by the orbit overlay, the pixel
  inspector and the Alt-click Julia picker, because those run on every pointer
  move and are unit-tested without WASM.

Having both paid the costs of both:

- two implementations to keep in sync, with nothing checking them against
  each other;
- a main-thread WASM boot;
- wasm-bindgen object lifetimes: every pan and every zoom notch allocated a
  WASM object that only a `FinalizationRegistry` freed;
- a flatten through five getters on every render request;
- tests that couldn't load WASM, so the input and zoom-preview suites tested
  against hand-written doubles of the class, one of them with its own copy of
  the zoom clamp.

## Decision

**The main thread uses a TypeScript `Viewport`**
([viewport.ts](../../web/src/viewport.ts)), a line-by-line port of
`fractal_core::Viewport`:

1. It is an immutable class: `pixelScale`, `pixelToComplex`, `panByPixels`,
   `zoomAround`, `withResolution`, the constants (`REFERENCE_WIDTH`,
   `BASE_RE_SPAN`) and the zoom clamp (`MIN_ZOOM`, `MAX_ZOOM`). It adds
   `complexToPixel`, the inverse projection the overlays draw with, which the
   compute never needs. The validation the binding did (finite inputs, zoom
   and factor > 0, whole-pixel dimensions) moves with it.
2. The overlays' projection (`cssToComplex`, `complexToCss` in
   [orbit-math.ts](../../web/src/orbit-math.ts)) goes through it. `orbit-math`'s
   own copy of the constants and the pixel scale is gone, so the main thread
   has one implementation.
3. **`main.ts` no longer loads WASM.** Only the render worker and the export's
   one-shot worker do. A browser that can't run the module finds out through
   the worker's boot handshake (`connectWorker`, #160), which already
   reported it.
4. **Rust stays the source of truth for the compute.** The worker builds a
   WASM `Viewport` from the request's five fields for every render; the
   per-pixel mapping and the kernel run in Rust.
5. **The port is exact.** Every formula keeps Rust's operation order. Both
   sides compute in IEEE-754 binary64 with each operation rounded on its own
   (no fused multiply-add), so the two agree bit for bit, not within a
   tolerance. A one-off check against the real WASM build compared 80,000
   random pans, zooms, resizes and eight-notch wheel scrubs and found no
   difference. #169 turns that into a permanent test.

## Consequences

- One fewer instantiation of the threaded module and its shared memory, one
  fewer fatal path, and no top-level `await` in `main.ts`.
- No WASM objects on the main thread, so nothing to free.
- The interaction maths is tested directly in Vitest: the zoom-preview and
  orbit suites now run against the real viewport, and `viewport.test.ts`
  carries the Rust suite's key properties.
- **Two implementations remain.** A change to `viewport.rs` needs the same
  change to `viewport.ts`. Both files say so, but until #169 lands nothing
  enforces it.
- **The main thread's interaction maths is TypeScript, not Rust**, which fits
  the README's "the code teaches Rust" aim less well than the Rust-only
  alternative below. The TypeScript is written as a port: each method names
  the Rust function it mirrors, and the Rust is still what renders.
- Boot time barely changes. The worker was created before the main-thread
  `init()`, so the two boots already overlapped. This is a simplicity
  decision, not a speed one.
- The binding's `pan_by_pixels`, `zoom_around`, `with_resolution` and getters
  are no longer called by the app. They stay as the reference #169 tests the
  port against.
- The orbit overlay's single-point iteration (`traceOrbit`, `BAILOUT_SQR`)
  stays a TypeScript mirror of the kernel, as it was (E1, #94).

## Alternatives considered

- **Rust only.** Export `pixel_to_complex_f`, a new `complex_to_pixel`, the
  constants and a `trace_orbit` from the binding, and delete the TypeScript
  mirror. One implementation, and the closest fit with the teaching goal.
  Rejected: it keeps a main-thread instance of the threaded module for about
  sixty lines of geometry; every pointer move crosses the boundary and gets a
  pair back (a WASM object to free, or an array copy); and the orbit,
  inspector, picker and input tests would all need the real module in Vitest.
- **Keep both and add only the parity test.** The cheapest option, but it
  keeps the main-thread boot, its fatal path and the object lifetimes: the
  costs of both approaches, which is what #172 asked to end.
- **A plain object with free functions** rather than a class. A class with
  readonly fields is still a plain value (it structured-clones to its five
  fields), and it keeps the Rust method shape, which the input controller's
  tests double structurally.

## Related

- [ADR-0005](0005-core-and-wasm-crate-workspace.md): `fractal-core` stays the
  compute's truth.
- [ADR-0007](0007-parallelism-via-wasm-threads.md): WASM threads, now in the
  workers only.
- [ADR-0011](0011-zoom-keyed-to-reference-width.md): the coordinate convention
  both implementations encode.
- #172 (this decision), #169 (the parity test), #160 (the shared worker boot
  handshake).
