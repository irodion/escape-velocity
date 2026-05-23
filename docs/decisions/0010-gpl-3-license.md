# ADR-0010: License under GPL-3.0-or-later

- Status: Accepted
- Date: 2026-05-23

## Context

The project is open source from day one and exists primarily to be learned
from. License choice ranged across the usual spectrum:

- **Permissive** (MIT, dual `MIT OR Apache-2.0` — the Rust ecosystem
  standard): maximal reuse, including in closed-source derivatives.
- **Copyleft** (GPL-3.0): derivatives must also remain open source.

The author wanted derivative work to *stay open* — a "share back" ethos.

## Decision

The project is licensed under **GPL-3.0**.

The precise SPDX identifier (`GPL-3.0-only` vs `GPL-3.0-or-later`) is to be
confirmed when the `LICENSE` file is added in Slice 0.

## Consequences

### Positive

- Anyone who builds on Escape Velocity must keep their derivative open
  source under a compatible license. Aligns the project's reuse with its
  educational ethos.
- Clear single-license story (no dual-licensing complexity).

### Negative

- If `fractal-core` were ever published to `crates.io` as a general-purpose
  library, GPL is an unconventional and reuse-limiting choice for a Rust
  crate — most of the Rust ecosystem is `MIT OR Apache-2.0`, and GPL
  dependencies are uncommon in non-GPL projects. **Acceptable here because
  `fractal-core` is an application component, not a general-purpose
  library.** If that ever changes, this ADR must be revisited.
- Contributors must be comfortable with their contributions being GPL-3.0.

## Alternatives considered

- **Dual `MIT OR Apache-2.0`.** Rust ecosystem standard, maximally
  permissive, with Apache-2.0 providing an explicit patent grant. Rejected
  in favour of copyleft.
- **MIT only.** Rejected. Simpler than the dual license, but same direction
  (permissive) as `MIT OR Apache-2.0` and worse on the patent grant.

## Related

- The project README's [Contributing](../../README.md#contributing) section
  inherits this license.

## Update — 2026-05-23

SPDX identifier resolved to **`GPL-3.0-or-later`**. The canonical FSF
GPL-3.0 text was added as `/LICENSE` in the same change.

Rationale for `-or-later`: FSF-recommended; future-proofs the project
against issues fixed in any later GPL version; conventional choice for
new GPL projects. The trade-off (agreeing in advance to terms the FSF
has not yet written) was accepted.
