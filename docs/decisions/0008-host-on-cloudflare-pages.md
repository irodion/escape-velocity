# ADR-0008: Host on Cloudflare Pages

- Status: Accepted
- Date: 2026-05-23

## Context

The parallelism decision ([ADR-0007](0007-parallelism-via-wasm-threads.md))
commits the project to using `SharedArrayBuffer`, which browsers only enable
when the page is served with cross-origin isolation headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

GitHub Pages — the default free host for an open-source project — **cannot**
set custom HTTP headers. The workaround is `coi-serviceworker`, a service
worker that intercepts every fetch and retro-fits the headers. It works, but
introduces fragility.

Three plausible hosts can serve the headers natively:

- **Cloudflare Pages** — `_headers` file, free, GitHub-repo CI integration.
- **Netlify** — `_headers` file or `netlify.toml`, free, GitHub-repo CI.
- **Vercel** — `vercel.json` headers.

## Decision

Host the production deployment on **Cloudflare Pages**. COOP and COEP are
configured via a `_headers` file in the build output. CI deploys are
triggered from the GitHub repository.

## Consequences

### Positive

- Clean header support — no retro-fitting hacks.
- The only service worker the app ships is the PWA service worker from
  [ADR-0009](0009-pwa-as-late-slice.md). One SW, one mental model.
- Free tier is generous for a static site of this size.

### Negative

- The project is not on GitHub Pages — slightly more "where does it live"
  surface area for a contributor (the repo lives on GitHub, the site lives
  on Cloudflare).
- Deployment configuration is platform-specific (`_headers`, Cloudflare's
  build settings) — a non-trivial migration cost if Cloudflare's offering
  ever changes.

## Alternatives considered

- **Netlify.** Functionally equivalent: `_headers` / `netlify.toml`, free
  tier, GitHub CI. Pure preference — either keeps the header story clean.
  Cloudflare picked for the generous free tier and edge network.
- **GitHub Pages + `coi-serviceworker`.** Rejected. The hack works, but it
  introduces a *second* service worker that must coexist with the PWA SW
  from slice 8 (sequencing, registration order, scope conflicts), plus a
  forced page-reload on first load to install the COI SW. Not worth it when
  free alternatives just set the headers.

## Related

- [ADR-0007](0007-parallelism-via-wasm-threads.md) — the reason headers are
  needed.
- [ADR-0009](0009-pwa-as-late-slice.md) — the other service worker in play.
