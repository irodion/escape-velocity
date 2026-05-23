# ADR-0009: PWA as a late, dedicated slice

- Status: Accepted
- Date: 2026-05-23

## Context

Progressive Web App capability — manifest, service worker, offline cache,
installability — is a **horizontal** wrapper around the whole application. It
is not a vertical capability ("see a fractal", "pan and zoom") but a
cross-cutting concern that affects every asset and the deployment story.

The project's methodology is vertical slices that deliver user-visible
increments. PWA-ness fits awkwardly: it adds no new feature, only delivery
properties (offline, installable). Where does it sit in the slice sequence?

## Decision

PWA capability is **slice 8** — the last slice on the roadmap. It is built
after the full fractal experience (render, pan/zoom, controls, coloring,
Julia, worker, multicore) is in place, using
[`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/).

## Consequences

### Positive

- Active development is not slowed down by an aggressive service-worker
  cache that loves to serve stale assets. (Service workers + active iteration
  is a famously painful combination.)
- The service-worker work, when it comes, is its own focused, learning-rich
  slice — caching strategies, manifest design, install UX.
- `vite-plugin-pwa` makes the slice itself cheap once we reach it.
- Only **one** service worker is in play in production, alongside no other
  SWs from hosting hacks ([ADR-0008](0008-host-on-cloudflare-pages.md)).

### Negative

- The application is not installable or offline-capable until slice 8.
- The PWA SW must be designed to coexist with `COEP: require-corp`
  ([ADR-0007](0007-parallelism-via-wasm-threads.md)): every cached resource
  must remain CORP-compatible, and the service worker's own response
  headers should not strip the cross-origin isolation guarantees.

## Alternatives considered

- **PWA early (slice 2 or 3).** Rejected. Aggressive caching during active
  development causes maddening stale-asset bugs, and the slice distracts
  from the Rust/WASM/fractal learning core.
- **Drop PWA entirely.** Rejected. The slice has genuine educational value
  (service workers, manifests, caching strategies) and "PWA" was on the
  user's original wish list. Postponing keeps it; cancelling discards it.

## Related

- [ADR-0007](0007-parallelism-via-wasm-threads.md) — COEP constraints on the
  service worker.
- [ADR-0008](0008-host-on-cloudflare-pages.md) — the only other SW in play
  is `coi-serviceworker`, which we explicitly avoided.
- [ADR-0004](0004-wasm-pack-and-vite-build.md) — `vite-plugin-pwa` is the
  implementation route.
