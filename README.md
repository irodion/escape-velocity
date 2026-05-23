# Escape Velocity

An educational, open-source fractal explorer. Renders the **Mandelbrot** and
**Julia** sets in the browser, with the escape-time iteration written in Rust
and compiled to WebAssembly.

This project exists to be *learned from*. The code is built and documented so
that reading it teaches Rust, WebAssembly, and the mathematics of escape-time
fractals. It is not a commercial product.

## Status

**Pre-slice-1.** This repository currently contains only its design record:
this README and the [Architecture Decision Records](docs/decisions/). No fractal
renders yet — that is [Slice 1](#roadmap).

## What it is

- A Mandelbrot / Julia set viewer running entirely in the browser — no server.
- Escape-time iteration written in Rust, compiled to WASM, run on the **CPU**
  (the GPU is a possible later slice, not a commitment — see
  [ADR-0001](docs/decisions/0001-cpu-side-wasm-compute.md)).
- A deliberately thin TypeScript UI: one `<canvas>` and a handful of controls.
- Shipped as a Progressive Web App in a late dedicated slice.

## How it is built

The project is developed in **vertical slices**. Each slice is a thin thread
through every layer — Rust core → WASM binding → TypeScript glue → canvas — that
delivers a working, visible increment. We never finish one layer in isolation
before starting the next.

See the [roadmap](#roadmap) for the slice sequence.

## Architecture at a glance

| Concern        | Decision                                                                          | ADR |
| -------------- | --------------------------------------------------------------------------------- | --- |
| Compute site   | Rust escape-time loop → WASM, on the CPU. GPU is an optional later slice.         | [0001](docs/decisions/0001-cpu-side-wasm-compute.md) |
| WASM contract  | Two Rust fns: `compute(viewport) → iteration buffer`, `colorize(buffer, palette) → RGBA`. | [0002](docs/decisions/0002-split-compute-and-colorize.md) |
| Render surface | Canvas2D `putImageData`.                                                          | [0001](docs/decisions/0001-cpu-side-wasm-compute.md) |
| UI layer       | Vanilla HTML + thin TypeScript. No framework. No HTMX.                            | [0003](docs/decisions/0003-vanilla-html-typescript-ui.md) |
| Build          | wasm-pack + Vite.                                                                 | [0004](docs/decisions/0004-wasm-pack-and-vite-build.md) |
| Crate layout   | Cargo workspace: `fractal-core` (pure Rust) + thin `fractal-wasm` binding.        | [0005](docs/decisions/0005-core-and-wasm-crate-workspace.md) |
| Precision      | f64, ~10¹³ zoom ceiling. Perturbation theory out of scope.                        | [0006](docs/decisions/0006-f64-precision-ceiling.md) |
| Parallelism    | wasm-bindgen-rayon (shared-memory WASM threads); worker-first decomposition.      | [0007](docs/decisions/0007-parallelism-via-wasm-threads.md) |
| Hosting        | Cloudflare Pages (`_headers` sets COOP/COEP).                                     | [0008](docs/decisions/0008-host-on-cloudflare-pages.md) |
| PWA            | Late dedicated slice, via `vite-plugin-pwa`.                                      | [0009](docs/decisions/0009-pwa-as-late-slice.md) |
| License        | GPL-3.0.                                                                          | [0010](docs/decisions/0010-gpl-3-license.md) |

Every row is backed by an [ADR](docs/decisions/) that records the context, the
decision, and the trade-offs — including the options we rejected.

## Roadmap

Each slice is a self-contained, end-to-end increment. Performance slices (6, 7)
deliver no new feature but real user-visible improvements (responsiveness,
smoothness) — they count as legitimate vertical slices.

| #   | Slice                                  | What you can do after it lands                                  |
| --- | -------------------------------------- | --------------------------------------------------------------- |
| 0   | Repo scaffold                          | Clone, `cargo test`, CI is green on every commit.               |
| 1   | Static hardcoded Mandelbrot            | Open the page, see one fixed Mandelbrot view (no interaction).  |
| 2   | Pan & zoom                             | Drag to pan, wheel to zoom.                                     |
| 3   | Iteration & resolution controls       | Adjust max iterations and render resolution from the form.      |
| 4   | Smooth coloring + palettes             | Pick a palette; smooth, banding-free coloring.                  |
| 5   | Julia mode (numeric `c`)               | Toggle Mandelbrot / Julia; enter `c.re` and `c.im` numerically. |
| 6   | Single coordinating Web Worker         | Compute runs off the main thread; renders are cancellable.      |
| 7   | rayon multicore (WASM threads)         | Multicore speedup; deep zooms feel fast.                        |
| 8   | PWA                                    | Installable, works offline.                                     |

**Backlog** — genuine later slices, *not* scope creep for slice 1:

- Click-the-Mandelbrot-to-pick-`c` (the pedagogically magical Julia UX)
- GPU compute slice (a deliberate fork — see ADR-0001)
- Touch / pinch zoom
- Shareable URL state (viewport encoded in the hash)
- Live side-by-side Mandelbrot + Julia with hover-preview

## Watch-list

Things that bite *late* — captured here so they don't ambush slice 7 or 8.

1. **The COEP trap.** Once `COEP: require-corp` is set for WASM threads, *every*
   resource must be same-origin or send a CORP header. No Google Fonts CDN, no
   third-party analytics. **Self-host everything from slice 0** so this doesn't
   ambush slice 7.
2. **Vite dev server needs the headers too.** Configure `server.headers` for
   COOP/COEP, or rayon will only work in the deployed build. Easy once known.
3. **wasm-bindgen-rayon is the fiddly slice.** Custom build flags
   (`atomics`, `bulk-memory`) and an async threadpool init that must complete
   before first compute call. Budget real time for slice 7 — that's why slice 6
   carries the first-worker plumbing.
4. **Cancellation.** Give the Worker protocol a render-epoch ID from slice 6, so
   a new pan discards stale in-flight tiles instead of painting them.
5. **The GPU slice is a fork, not an upgrade.** It inverts ADR-0001 *and*
   regresses f64→f32 precision (WGSL/GLSL core has no f64). Decide it
   deliberately, and not in slice 1.

## Planned repository layout

```
escape-velocity/
├── Cargo.toml              # workspace
├── crates/
│   ├── fractal-core/       # pure Rust: escape-time, smooth coloring, palettes
│   └── fractal-wasm/       # thin wasm-bindgen binding layer
├── web/                    # Vite + TypeScript frontend
├── docs/
│   └── decisions/          # ADRs
├── .github/workflows/      # CI: cargo test, clippy, fmt, wasm build
├── LICENSE                 # GPL-3.0
└── README.md
```

## Building

Toolchain (filled in fully during Slice 0):

- Rust stable (`rustup`).
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).
- Node.js LTS + a package manager (npm / pnpm).

Commands will live here after Slice 0 lands. Until then there is nothing
to build.

## Contributing

The project is GPL-3.0 ([ADR-0010](docs/decisions/0010-gpl-3-license.md)) —
contributions are welcome under the same license. Contributor docs
(`CONTRIBUTING.md`, issue / PR templates) are deferred until Slice 1 actually
ships ([ADR-0011-style rationale captured in this README](#status) — keep the
process bureaucracy proportional to what exists to contribute *to*).

## License

[GPL-3.0-or-later](LICENSE). See
[ADR-0010](docs/decisions/0010-gpl-3-license.md) for the reasoning.
