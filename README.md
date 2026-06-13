# Escape Velocity

An educational, open-source fractal explorer. Renders the **Mandelbrot** and
**Julia** sets in the browser, with the escape-time iteration written in Rust
and compiled to WebAssembly.

This project exists to be *learned from*. The code is built and documented so
that reading it teaches Rust, WebAssembly, and the mathematics of escape-time
fractals. It is not a commercial product.

## Status

**All roadmap slices shipped (0–8).** The fractal explorer is feature-complete:
it renders the Mandelbrot and Julia sets, pans and zooms, exposes
iteration / resolution / palette / coloring / mode controls, runs compute off
the main thread across a multicore WASM thread pool, and is an installable,
offline-capable PWA. Every increment landed through its own PR, each backed by
an [Architecture Decision Record](docs/decisions/).

What remains is the [backlog](#roadmap) — genuine future ideas, none required
for the core experience.

## What it is

- A Mandelbrot / Julia set viewer running entirely in the browser — no server.
- Escape-time iteration written in Rust, compiled to WASM, run on the **CPU**
  (the GPU is a possible later slice, not a commitment — see
  [ADR-0001](docs/decisions/0001-cpu-side-wasm-compute.md)).
- A deliberately thin TypeScript UI: one `<canvas>` and a handful of controls.
- Shipped as an installable, offline-capable Progressive Web App.

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

Every slice below has **shipped** (✅). Each was a self-contained, end-to-end
increment; the performance slices (6, 7) delivered no new feature but real
user-visible improvements (responsiveness, smoothness) — legitimate vertical
slices all the same.

| #   | Slice                            | Status | What you can do after it lands                                  |
| --- | -------------------------------- | ------ | --------------------------------------------------------------- |
| 0   | Repo scaffold                    | ✅     | Clone, `cargo test`, CI is green on every commit.               |
| 1   | Static hardcoded Mandelbrot      | ✅     | Open the page, see one fixed Mandelbrot view (no interaction).  |
| 2   | Pan & zoom                       | ✅     | Drag to pan, wheel to zoom.                                     |
| 3   | Iteration & resolution controls  | ✅     | Adjust max iterations and render resolution from the form.      |
| 4   | Smooth coloring + palettes       | ✅     | Pick a palette; smooth, banding-free coloring.                  |
| 5   | Julia mode (numeric `c`)         | ✅     | Toggle Mandelbrot / Julia; enter `c.re` and `c.im` numerically. |
| 6   | Single coordinating Web Worker   | ✅     | Compute runs off the main thread; renders are cancellable.      |
| 7   | rayon multicore (WASM threads)   | ✅     | Multicore speedup; deep zooms feel fast.                        |
| 8   | PWA                              | ✅     | Installable, works offline.                                     |

**Backlog** — genuine future slices, deliberately out of the shipped roadmap:

- Click-the-Mandelbrot-to-pick-`c` (the pedagogically magical Julia UX)
- GPU compute slice (a deliberate fork — see ADR-0001)
- Touch / pinch zoom
- Shareable URL state (viewport encoded in the hash)
- Live side-by-side Mandelbrot + Julia with hover-preview

## Watch-list

Things that bite *late* — captured up front so they wouldn't ambush slices 7–8.
All five were navigated as planned; kept here as a record of how.

1. **The COEP trap.** Once `COEP: require-corp` is set for WASM threads, *every*
   resource must be same-origin or send a CORP header. No Google Fonts CDN, no
   third-party analytics. → *Handled: everything self-hosted from Slice 0, so
   the Slice 8 service worker precaches only same-origin assets and cross-origin
   isolation survives offline.*
2. **Vite dev server needs the headers too.** Configure `server.headers` for
   COOP/COEP, or rayon will only work in the deployed build. → *Handled in
   Slice 7: `server.headers` / `preview.headers` in `vite.config.ts`; production
   COOP/COEP ship via the `public/_headers` file added in Slice 8.*
3. **wasm-bindgen-rayon is the fiddly slice.** Custom build flags
   (`atomics`, `bulk-memory`) and an async threadpool init that must complete
   before first compute call. → *Handled in Slice 7: a pinned nightly +
   `build-std` atomics build, with `initThreadPool` awaited before the worker
   announces `ready`; Slice 6 carried the first-worker plumbing so this stayed a
   single-axis change.*
4. **Cancellation.** Give the Worker protocol a render-epoch ID from slice 6, so
   a new pan discards stale in-flight tiles instead of painting them. →
   *Handled in Slice 6: epoch-tagged requests, single-slot coalescing, and stale
   responses dropped before they paint.*
5. **The GPU slice is a fork, not an upgrade.** It inverts ADR-0001 *and*
   regresses f64→f32 precision (WGSL/GLSL core has no f64). → *Still deferred —
   it remains a [backlog](#roadmap) fork, intentionally not taken.*

## Repository layout

```text
escape-velocity/
├── Cargo.toml              # workspace
├── rust-toolchain.toml     # pins Rust 1.94.1 stable
├── crates/
│   ├── fractal-core/       # pure Rust: escape-time, smooth coloring, palettes
│   └── fractal-wasm/       # thin wasm-bindgen binding layer (Slice 1)
├── web/                    # Vite + TypeScript frontend (biome.json for fmt+lint)
├── docs/
│   └── decisions/          # ADRs
├── .github/workflows/      # CI: rust (fmt/clippy/test) + web (biome/typecheck/build) + safedep/vet
├── LICENSE                 # GPL-3.0-or-later
└── README.md
```

## Building

Toolchain:

- **Rust (stable)** pinned via [`rust-toolchain.toml`](rust-toolchain.toml) (currently `1.94.1`).
  Install [`rustup`](https://rustup.rs) and `cd` into the repo — it auto-installs the right toolchain.
  This is the toolchain for everyday work: `cargo test`, `clippy`, `fmt`.
- **Rust (nightly), for the WASM build only** — since Slice 7, the browser artifact links
  shared-memory WASM threads (`wasm-bindgen-rayon`, ADR-0007), which needs `std` recompiled
  with atomics (`build-std`) — nightly-only. Install the pinned nightly once:
  `rustup toolchain install nightly-2025-11-15 --component rust-src --target wasm32-unknown-unknown`.
  The `wasm:build` script (and CI) invoke it via `rustup run`; native work stays on stable.
- **Node.js 24** (current LTS).
- **pnpm 10.30.1** — pinned in `web/package.json#packageManager`. Run `corepack enable` if you don't have it.
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) — needed from Slice 1 onward.

Slice 0 verification (matches CI):

```sh
# Rust side
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Web side
cd web
pnpm install
pnpm lint          # biome ci
pnpm typecheck     # tsc --noEmit
pnpm build         # vite build
pnpm fmt           # biome auto-fix (local convenience, not in CI)
```

## Contributing

The project is GPL-3.0 ([ADR-0010](docs/decisions/0010-gpl-3-license.md)) —
contributions are welcome under the same license. Now that the roadmap has
shipped there is a real codebase to contribute *to*; formal contributor docs
(`CONTRIBUTING.md`, issue / PR templates) are not in place yet and are a
sensible next addition. In the meantime, the build / verify steps above mirror
CI, and every change goes through a PR.

Versioned git hooks live in [`.githooks/`](.githooks). They are opt-in (Git
only runs hooks from `.git/hooks` by default), so point Git at them once per
clone:

```sh
git config core.hooksPath .githooks
```

The `pre-push` hook blocks direct pushes to `main` — work goes through a feature
branch + PR. For a genuinely intended, approved push to main, override with
`ALLOW_MAIN_PUSH=1 git push origin main`.

## License

[GPL-3.0-or-later](LICENSE). See
[ADR-0010](docs/decisions/0010-gpl-3-license.md) for the reasoning.
