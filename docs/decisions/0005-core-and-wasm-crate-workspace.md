# ADR-0005: Cargo workspace — fractal-core (pure) + fractal-wasm (binding)

- Status: Accepted
- Date: 2026-05-23

## Context

The escape-time mathematics, smooth-coloring formulas, and palette logic can
either be tangled together with `#[wasm_bindgen]` attributes in a single crate,
or quarantined in a pure-Rust library crate with a thin binding layer over it.

Two consequences hinge on this choice: how the algorithm is tested, and how
coupled the domain code is to its delivery mechanism (WebAssembly).

## Decision

The repository is a **Cargo workspace** with two crates:

- **`fractal-core`** — pure Rust. Contains the escape-time iteration, smooth-
  coloring formula, palettes, viewport type. **Zero `wasm-bindgen` dependency.**
  Has no opinion about how it is delivered.
- **`fractal-wasm`** — a thin binding crate that depends on `fractal-core` and
  carries *all* `#[wasm_bindgen]` attributes. Its job is to expose the
  `compute` / `colorize` entry points
  ([ADR-0002](0002-split-compute-and-colorize.md)) across the WASM boundary,
  and otherwise pass through.

## Consequences

### Positive

- **`cargo test` runs the algorithm natively** — fast, no browser, no
  `wasm-bindgen-test` runner. The pedagogically important code is the most
  ergonomic to test.
- The domain (fractal math) is decoupled from its delivery (WebAssembly). A
  reader can study `fractal-core` without first learning wasm-bindgen.
- A native CLI renderer (e.g. produce a PNG from `fractal-core`) is trivially
  available as a future test / benchmark harness. Not committed to slice 0,
  but unblocked.

### Negative

- Slightly more layout ceremony than a single crate.
- The binding layer adds a thin pass-through; "where is `compute` exposed?"
  is two file hops instead of one.

## Alternatives considered

- **Single crate with `#[wasm_bindgen]` throughout.** Rejected. The fractal
  math becomes testable only via `wasm-bindgen-test` in a browser/Node runtime
  (slower iteration), and the algorithm gets coupled to its delivery
  mechanism. The flatter layout doesn't pay for those costs.

## Related

- [ADR-0001](0001-cpu-side-wasm-compute.md) — what `fractal-core` computes.
- [ADR-0002](0002-split-compute-and-colorize.md) — the two functions
  `fractal-core` exposes through the binding layer.
- [ADR-0004](0004-wasm-pack-and-vite-build.md) — `wasm-pack` builds the
  binding crate; `fractal-core` is its dependency.
