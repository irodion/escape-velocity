//! The fractal family selector.
//!
//! Slice 5 generalises the renderer from "Mandelbrot only" to
//! "Mandelbrot or a numeric-`c` Julia set". Both families share the
//! same `z_{n+1} = z_n² + c` recurrence; they differ only in how the
//! per-pixel `(z_0, c)` pair is assigned:
//!
//! - **Mandelbrot**: vary `c` across the plane, fix `z_0 = 0`. Each
//!   pixel is a different `c`; the iterate starts at the origin.
//! - **Julia(c)**: fix `c` (the parameter chosen by the user), vary
//!   `z_0` across the plane. Each pixel is a different `z_0`; the
//!   parameter `c` is the same everywhere in the image.
//!
//! `FractalKind` captures that distinction at the call site of
//! `compute`. The pipeline matches on it once per render and dispatches
//! the per-pixel `escape_time` call accordingly; nothing else
//! downstream needs to know which family produced the iteration buffer
//! (`colorize` and the palette/normalisation modes are family-agnostic).
//!
//! `Copy` is deliberate: the enum is two `f64`s in the worst case
//! (Julia's `c`), small enough that pass-by-value is always cheaper
//! than reference indirection in the hot dispatch.

use crate::complex::Complex64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FractalKind {
    Mandelbrot,
    Julia { c: Complex64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compile-time guard: the enum is `Copy`. If a future change adds
    // a non-Copy payload (e.g. a `Vec`), this fails to compile and
    // forces the author to reconsider — the dispatch in `compute`
    // relies on cheap pass-by-value.
    #[test]
    fn fractal_kind_is_copy() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<FractalKind>();
    }

    // Compile-time guard: every variant is reachable from an
    // exhaustive `match`. Adding a third variant without updating the
    // pipeline dispatch (or any other match site) will fail to
    // compile, surfacing the omission at build time rather than as a
    // silent runtime fallback.
    #[test]
    fn exhaustive_match_covers_every_variant() {
        fn name(kind: FractalKind) -> &'static str {
            match kind {
                FractalKind::Mandelbrot => "mandelbrot",
                FractalKind::Julia { .. } => "julia",
            }
        }
        assert_eq!(name(FractalKind::Mandelbrot), "mandelbrot");
        assert_eq!(
            name(FractalKind::Julia {
                c: Complex64::new(-0.7, 0.27015),
            }),
            "julia",
        );
    }

    #[test]
    fn julia_carries_c_through_clone_and_equality() {
        // The `c` payload must survive a Copy/Clone round-trip
        // unchanged, and equality must compare the payload — these
        // are the two properties the dispatch and any future
        // memoisation will rely on.
        let c = Complex64::new(-0.7, 0.27015);
        let a = FractalKind::Julia { c };
        let b = a;
        let cloned = a;
        assert_eq!(a, b);
        assert_eq!(a, cloned);
        assert_eq!(a, FractalKind::Julia { c });
        assert_ne!(
            FractalKind::Julia { c },
            FractalKind::Julia {
                c: Complex64::new(0.0, 0.0),
            },
        );
        assert_ne!(FractalKind::Mandelbrot, FractalKind::Julia { c });
    }
}
