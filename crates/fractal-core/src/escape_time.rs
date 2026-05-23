//! Smooth (continuous) Mandelbrot escape-time iteration.
//!
//! For each complex `c`, iterate `z_{n+1} = z_n² + c` starting from
//! `z_0 = 0`. When `|z_i|² > BAILOUT_SQR` the orbit has provably
//! escaped; return the smooth count
//!
//! ```text
//! nu = i + 1 − log₂(log₂(r2) / 2)
//! ```
//!
//! where `r2 = |z_i|²` at the bailout step. The smooth count is
//! continuous in `c` (unlike the integer iteration index, which jumps
//! by 1 at orbit boundaries) and monotonic in escape speed (faster
//! escapers get smaller `nu`).
//!
//! If no escape is detected within `max_iter` iterations the orbit is
//! treated as "inside the set" and the function returns [`f32::NAN`].
//! Callers MUST detect inside-set points with [`f32::is_nan`], never
//! with `==` — NaN compares unequal to itself.

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

pub fn escape_time(c: Complex64, max_iter: u32) -> f32 {
    let mut z = Complex64::new(0.0, 0.0);
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

    // --- inside-set sentinel ----------------------------------------------

    #[test]
    fn origin_returns_nan() {
        // c = 0: z stays at 0 forever — inside the set.
        assert!(escape_time(Complex64::new(0.0, 0.0), MAX_ITER).is_nan());
    }

    #[test]
    fn minus_one_returns_nan() {
        // c = −1: orbit is 0, −1, 0, −1, … (period 2) — inside the set.
        assert!(escape_time(Complex64::new(-1.0, 0.0), MAX_ITER).is_nan());
    }

    #[test]
    fn main_cardioid_boundary_returns_nan() {
        // c = 0.25 sits on the cusp of the main cardioid; the orbit
        // converges to z = 0.5 from below but never escapes.
        assert!(escape_time(Complex64::new(0.25, 0.0), MAX_ITER).is_nan());
    }

    // --- smooth escape shape ----------------------------------------------

    #[test]
    fn fast_escaper_nu_is_finite_and_smaller_than_max_iter() {
        // c = (3, 0) escapes in a handful of iterations. The smooth nu
        // for bailout 256 lands within (1, 2] — log₂(log₂(|z_4|))≈3.85
        // and `nu = 4 + 1 − 3.85 ≈ 1.15`.
        let nu = escape_time(Complex64::new(3.0, 0.0), MAX_ITER);
        assert!(nu.is_finite(), "nu must be finite for an escaper, got {nu}");
        let i = nu.floor();
        assert!(nu > i && nu <= i + 1.0, "nu={nu} not in (i, i+1]");
        // Also sanity-check the magnitude — c=(3,0) escapes in a
        // single-digit number of iterations.
        assert!(nu < 4.0, "fast escaper produced unexpectedly large nu={nu}");
    }

    #[test]
    fn fast_escaper_smaller_nu_than_slow_escaper() {
        // c = (3, 0) escapes after one orbit step at large modulus;
        // c = (0.5, 0) takes several. Smooth nu must reflect that
        // ordering — smaller nu means faster escape.
        let fast = escape_time(Complex64::new(3.0, 0.0), MAX_ITER);
        let slow = escape_time(Complex64::new(0.5, 0.0), MAX_ITER);
        assert!(fast.is_finite() && slow.is_finite());
        assert!(fast < slow, "fast={fast} not < slow={slow}");
    }

    #[test]
    fn nu_is_smooth_between_neighbours() {
        // Two pixels a small step apart should produce nu values that
        // differ by less than one whole iteration — this is the
        // smoothness property that the new formula buys us. Without
        // smoothing, neighbouring pixels can jump by a full integer.
        let a = escape_time(Complex64::new(1.0, 0.0), MAX_ITER);
        let b = escape_time(Complex64::new(1.0001, 0.0), MAX_ITER);
        assert!(a.is_finite() && b.is_finite());
        assert!(
            (a - b).abs() < 1.0,
            "neighbouring nu jumped: |{a} − {b}| = {}",
            (a - b).abs(),
        );
    }

    #[test]
    fn nu_is_finite_across_sweep_grid_of_escapers() {
        // A coarse grid clear of the main cardioid and period-2 bulb.
        // Every cell must return a finite nu (no NaN, no inf).
        for j in 0..8 {
            for i in 0..8 {
                let re = 1.0 + (f64::from(i)) * 0.25;
                let im = (f64::from(j)) * 0.25;
                let nu = escape_time(Complex64::new(re, im), MAX_ITER);
                assert!(nu.is_finite(), "non-finite nu at ({re}, {im}): {nu}",);
            }
        }
    }
}
