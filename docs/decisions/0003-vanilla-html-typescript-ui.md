# ADR-0003: Vanilla HTML + TypeScript for the UI; no framework, no HTMX

- Status: Accepted
- Date: 2026-05-23

## Context

The Escape Velocity UI is structurally tiny: one `<canvas>` element plus a
handful of controls (max-iter, resolution, palette select, Mandelbrot/Julia
toggle, two numeric `c` inputs). There is no component tree, no list of
heterogeneous items, no client-side routing.

The original idea statement floated HTMX. Two other plausible options were
present implicitly: a JavaScript UI framework (React/Svelte/Solid) or a Rust
WASM UI framework (Leptos/Yew/Dioxus).

## Decision

The UI is **plain HTML** plus a **thin TypeScript glue layer** (target
~150–300 lines). No UI framework. **HTMX is rejected.**

TypeScript is preferred over plain JavaScript specifically so the wasm-bindgen-
generated `.d.ts` files give typed access to the WASM API — the type
information is most valuable exactly at the JS↔Rust boundary.

## Consequences

### Positive

- Minimal learning surface for the UI — the project's pedagogical mass stays
  in Rust / WASM / the fractal algorithm.
- Typed WASM bindings without ceremony.
- No framework lock-in, no reactive overhead, no virtual-DOM machinery a
  single-canvas app would never use.
- Build pipeline stays small ([ADR-0004](0004-wasm-pack-and-vite-build.md))
  because there's no framework runtime to bundle.

### Negative

- DOM event wiring is manual. If the UI ever grows real complexity (multiple
  views, modals, list rendering of saved bookmarks), this ADR should be
  revisited — but that complexity is not on the roadmap.

## Alternatives considered

- **HTMX.** Rejected. HTMX's entire job is swapping server-rendered HTML
  fragments in response to user actions. Escape Velocity has no server — it
  is a static client-only app. HTMX would have nothing to do.
- **A Rust WASM UI framework (Leptos / Yew / Dioxus).** Rejected. Appealing
  for a "Rust everywhere" learn-Rust project, but triples the slice-1
  learning load and pulls in a reactive DOM model that a one-canvas app
  fundamentally doesn't need. A future "rewrite the UI in Rust" is a
  horizontal rewrite, not a vertical slice — it doesn't fit the project's
  methodology.
- **A JS framework (React / Svelte / Solid).** Rejected without serious
  consideration — same reasoning as the Rust framework option, with the
  added penalty of pulling more JavaScript than the WASM module itself.

## Related

- [ADR-0004](0004-wasm-pack-and-vite-build.md) — the build pipeline that
  serves this thin TS layer alongside the WASM module.
