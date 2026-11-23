# AGENTS.md

Escape Velocity is a fractal explorer: Rust escape-time code compiled to WebAssembly, with a vanilla TypeScript UI
in `web/`. The README has the architecture, the roadmap and the setup, and `docs/decisions/` the ADRs.

## Setup

- `pnpm test`, `pnpm typecheck`, `pnpm dev` and `pnpm build` in `web/` first run `pnpm wasm:build`, which builds
  `web/wasm/` with the pinned nightly and `wasm-pack`. Without them those commands fail: install both as the
  README's prerequisites say.

## Pull requests

- CodeRabbit never reviews this repo on its own (repos with fewer than 10 stars get no automatic reviews), whatever
  `.coderabbit.yaml` says: ask for each review with a `@coderabbitai review` PR comment. The free plan rate-limits
  reviews; its notice says when the next is available, then ask again. It reads `.coderabbit.yaml` from the PR's
  branch.
