//! Smooth (continuous) escape-time iteration for the `z² + c` family.
//!
//! Iterate `z_{n+1} = z_n² + c` from a caller-chosen `z_0`. When
//! `|z_i|² > BAILOUT_SQR` the orbit has provably escaped; return the
//! smooth count
//!
//! ```text
//! nu = i + 1 − log₂(log₂(r2) / 2)
//! ```
//!
//! where `r2 = |z_i|²` at the bailout step. The smooth count is
//! continuous in both `z_0` and `c` (unlike the integer iteration
//! index, which jumps by 1 at orbit boundaries) and monotonic in
//! escape speed (faster escapers get smaller `nu`).
//!
//! If no escape is detected within `max_iter` iterations the orbit is
//! treated as "inside the set" and the function returns [`f32::NAN`].
//! Callers MUST detect inside-set points with [`f32::is_nan`], never
//! with `==` — NaN compares unequal to itself.
//!
//! The function is family-agnostic — Slice 5's two modes share this
//! one implementation, differing only in how the pipeline assigns
//! `(z_0, c)` per pixel:
//!
//! - **Mandelbrot**: `z_0 = 0`, `c = pixel`.
//! - **Julia(C)**: `z_0 = pixel`, `c = C` (the user-chosen parameter).
//!
//! Pre-bailout: the loop body's first action is the magnitude check
//! against `BAILOUT_SQR`, so a `z_0` already outside the bailout disk
//! returns at iteration `0` with `r2 = |z_0|²`. This is the desired
//! behaviour for Julia mode (a pixel far from the origin escapes
//! immediately) and is unreachable for Mandelbrot mode (where `z_0`
//! is always the origin).

use crate::complex::Complex64;

/// Bailout threshold: `|z|² > 65_536` ⇔ `|z| > 256`.
///
/// Slice 1 used `4.0` (`|z| > 2`), the textbook minimum that proves
/// escape. Slice 4 raises it because the smooth-iteration formula's
/// accuracy improves with bailout radius: at `|z|` close to the
/// minimum, the kink between the discrete index `i` and the smooth
/// correction is visible as banding; at `|z| > 256` it shrinks below
/// the perceptible level. `256² + epsilon` squared is `≈ 4.3·10⁹`,
/// well inside `f64` range, so the larger bailout costs no precision.
const BAILOUT_SQR: f64 = 65_536.0;

pub fn escape_time(z0: Complex64, c: Complex64, max_iter: u32) -> f32 {
    let mut z = z0;
    for i in 0..max_iter {
        let r2 = z.norm_sqr();
        if r2 > BAILOUT_SQR {
            // log₂(|z|) = log₂(√r2) = log₂(r2) / 2, computed without
            // the sqrt to keep the inner loop allocation-free.
            let log_z = r2.log2() * 0.5;
            return (f64::from(i) + 1.0 - log_z.log2()) as f32;
        }
        z = z.square() + c;
    }
    f32::NAN
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_ITER: u32 = 256;
    const ORIGIN: Complex64 = Complex64::new(0.0, 0.0);

    // --- Mandelbrot back-compat: z_0 = 0 -----------------------------------
    //
    // These four assertions were the Slice 4 contract on `escape_time`.
    // After widening, they re-run as `escape_time(ORIGIN, c, n)` — the
    // mathematical content is identical, only the spelling changed. If
    // any of these regress, the Mandelbrot half of Slice 5 has broken.

    #[test]
    fn mandelbrot_origin_returns_nan() {
        // c = 0: z stays at 0 forever — inside the set.
        assert!(escape_time(ORIGIN, Complex64::new(0.0, 0.0), MAX_ITER).is_nan());
    }

    #[test]
    fn mandelbrot_minus_one_returns_nan() {
        // c = −1: orbit is 0, −1, 0, −1, … (period 2) — inside the set.
        assert!(escape_time(ORIGIN, Complex64::new(-1.0, 0.0), MAX_ITER).is_nan());
    }

    #[test]
    fn mandelbrot_main_cardioid_boundary_returns_nan() {
        // c = 0.25 sits on the cusp of the main cardioid; the orbit
        // converges to z = 0.5 from below but never escapes.
        assert!(escape_time(ORIGIN, Complex64::new(0.25, 0.0), MAX_ITER).is_nan());
    }

    #[test]
    fn mandelbrot_fast_escaper_nu_is_finite_and_smaller_than_max_iter() {
        // c = (3, 0) escapes in a handful of iterations. The smooth nu
        // for bailout 256 lands within (1, 2] — log₂(log₂(|z_4|))≈3.85
        // and `nu = 4 + 1 − 3.85 ≈ 1.15`.
        let nu = escape_time(ORIGIN, Complex64::new(3.0, 0.0), MAX_ITER);
        assert!(nu.is_finite(), "nu must be finite for an escaper, got {nu}");
        let i = nu.floor();
        assert!(nu > i && nu <= i + 1.0, "nu={nu} not in (i, i+1]");
        assert!(nu < 4.0, "fast escaper produced unexpectedly large nu={nu}");
    }

    #[test]
    fn mandelbrot_fast_escaper_smaller_nu_than_slow_escaper() {
        // c = (3, 0) escapes after one orbit step at large modulus;
        // c = (0.5, 0) takes several. Smooth nu must reflect that
        // ordering — smaller nu means faster escape.
        let fast = escape_time(ORIGIN, Complex64::new(3.0, 0.0), MAX_ITER);
        let slow = escape_time(ORIGIN, Complex64::new(0.5, 0.0), MAX_ITER);
        assert!(fast.is_finite() && slow.is_finite());
        assert!(fast < slow, "fast={fast} not < slow={slow}");
    }

    #[test]
    fn mandelbrot_nu_is_smooth_between_neighbours() {
        // Two pixels a small step apart should produce nu values that
        // differ by less than one whole iteration — this is the
        // smoothness property that the new formula buys us.
        let a = escape_time(ORIGIN, Complex64::new(1.0, 0.0), MAX_ITER);
        let b = escape_time(ORIGIN, Complex64::new(1.0001, 0.0), MAX_ITER);
        assert!(a.is_finite() && b.is_finite());
        assert!(
            (a - b).abs() < 1.0,
            "neighbouring nu jumped: |{a} − {b}| = {}",
            (a - b).abs(),
        );
    }

    #[test]
    fn mandelbrot_nu_is_finite_across_sweep_grid_of_escapers() {
        // A coarse grid clear of the main cardioid and period-2 bulb.
        // Every cell must return a finite nu (no NaN, no inf).
        for j in 0..8 {
            for i in 0..8 {
                let re = 1.0 + (f64::from(i)) * 0.25;
                let im = (f64::from(j)) * 0.25;
                let nu = escape_time(ORIGIN, Complex64::new(re, im), MAX_ITER);
                assert!(nu.is_finite(), "non-finite nu at ({re}, {im}): {nu}",);
            }
        }
    }

    // --- Julia mode: vary z_0, fix c ---------------------------------------
    //
    // The Douady rabbit (`c = -0.123 + 0.745i`) is canonical: `c` sits
    // inside the period-3 bulb of the Mandelbrot set, so the orbit of
    // `z_0 = 0` is bounded by definition (that's what Mandelbrot-set
    // membership *means*) and the corresponding filled Julia set is
    // connected with `z_0 = 0` inside it. These tests pin the two
    // endpoints of the inside/outside contract on that connected case.
    //
    // The Slice 5C UI defaults to `c = (-0.7, 0.27015)` — a *Cantor
    // dust* Julia (that c is outside the Mandelbrot set), which is
    // still a valid render but does NOT have `z_0 = 0` inside the
    // filled set. We deliberately use a different `c` here so the
    // inside-set assertion has a mathematically clean witness.

    const JULIA_C_RABBIT: Complex64 = Complex64::new(-0.123, 0.745);

    #[test]
    fn julia_origin_z0_is_inside_set() {
        // `z_0 = 0` lies inside the Douady-rabbit filled Julia set —
        // the orbit stays bounded (period-3 cycle).
        assert!(escape_time(ORIGIN, JULIA_C_RABBIT, MAX_ITER).is_nan());
    }

    #[test]
    fn julia_far_z0_escapes_with_finite_nu() {
        // `z_0 = (2, 2)` is well outside the filled Julia set — must
        // escape within a handful of iterations and return a finite
        // smooth count.
        let nu = escape_time(Complex64::new(2.0, 2.0), JULIA_C_RABBIT, MAX_ITER);
        assert!(nu.is_finite(), "Julia far-z0 must escape, got {nu}");
        assert!(nu < f32::from(20_u16), "Julia escape too slow: nu={nu}");
    }

    #[test]
    fn first_iteration_bailout_from_large_z0() {
        // A `z_0` already beyond the bailout disk returns at iteration
        // `i = 0`, so `nu = 1 − log₂(log₂(r2)/2)`. For `r2 = 90_000`
        // (z_0 = 300+0i), `log_z ≈ 8.075`, `log₂ log_z ≈ 3.014`, so
        // `nu ≈ -2.014`. The exact value doesn't matter — the contract
        // is "returns a finite number, not NaN". The `c` value is
        // irrelevant: the bailout check fires before `c` enters the
        // recurrence.
        for &c in &[
            Complex64::new(0.0, 0.0),
            JULIA_C_RABBIT,
            Complex64::new(1.5, -0.3),
        ] {
            let nu = escape_time(Complex64::new(300.0, 0.0), c, MAX_ITER);
            assert!(
                nu.is_finite(),
                "first-iteration bailout must be finite, got {nu} for c={c:?}"
            );
        }
    }

    #[test]
    fn julia_nu_is_smooth_in_z0() {
        // Smoothness in z_0: two z_0 values a small step apart in
        // escape-land must produce nu values that differ by less than
        // one whole iteration. Without smoothing they'd jump by a full
        // integer at the orbit boundary.
        let a = escape_time(Complex64::new(1.5, 0.5), JULIA_C_RABBIT, MAX_ITER);
        let b = escape_time(Complex64::new(1.5001, 0.5), JULIA_C_RABBIT, MAX_ITER);
        assert!(a.is_finite() && b.is_finite());
        assert!(
            (a - b).abs() < 1.0,
            "Julia neighbouring nu jumped: |{a} − {b}| = {}",
            (a - b).abs(),
        );
    }
}
