# Architecture Decision Records

This directory records the architecturally significant decisions made for
Escape Velocity. Each ADR captures one decision: the **context** that forced a
choice, the **decision** taken, the **consequences** (including downsides), and
the **alternatives** that were considered and rejected.

ADRs are append-only history. If a decision changes, the existing ADR is marked
`Superseded by NNNN` and a new ADR is added; the old one is *never* edited to
agree with the new one — losing the original reasoning is the failure mode ADRs
exist to prevent.

## Format

Each ADR uses this minimal shape:

```
# ADR-NNNN: Title

- Status: Accepted | Superseded by NNNN | Deprecated
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
## Related
```

Numbering is zero-padded to four digits and never reused.

## Index

| #    | Title                                                                                  | Status   |
| ---- | -------------------------------------------------------------------------------------- | -------- |
| 0001 | [Run escape-time computation on the CPU in WebAssembly](0001-cpu-side-wasm-compute.md) | Accepted |
| 0002 | [Split the pipeline into compute() and colorize()](0002-split-compute-and-colorize.md) | Accepted |
| 0003 | [Vanilla HTML + TypeScript for the UI; no framework, no HTMX](0003-vanilla-html-typescript-ui.md) | Accepted |
| 0004 | [Build with wasm-pack and Vite](0004-wasm-pack-and-vite-build.md)                      | Accepted |
| 0005 | [Cargo workspace: fractal-core + fractal-wasm](0005-core-and-wasm-crate-workspace.md)  | Accepted |
| 0006 | [f64 precision; ~10¹³ zoom ceiling; perturbation theory out of scope](0006-f64-precision-ceiling.md) | Accepted |
| 0007 | [Parallelism via WASM threads (rayon), introduced worker-first](0007-parallelism-via-wasm-threads.md) | Accepted |
| 0008 | [Host on Cloudflare Pages](0008-host-on-cloudflare-pages.md)                           | Accepted |
| 0009 | [PWA as a late, dedicated slice](0009-pwa-as-late-slice.md)                            | Accepted |
| 0010 | [License under GPL-3.0-or-later](0010-gpl-3-license.md)                                | Accepted |

## Adding a new ADR

1. Pick the next free number.
2. Copy the format above.
3. Date in ISO `YYYY-MM-DD`.
4. Be honest in **Consequences** — list the downsides, not just the benefits.
5. In **Alternatives considered**, write down what you rejected *and why* — a
   future reader needs to know whether their "obvious idea" was already weighed.
6. Add a row to the index above.
