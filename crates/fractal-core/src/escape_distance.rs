//! Distance-to-boundary estimate for the `z² + c` family (ADR-0013).
//!
//! Iterate `z_{n+1} = z_n² + c` from a caller-chosen `z_0`, tracking the
//! orbit derivative `z'` alongside it. When the orbit escapes
//! (`|z_i|² > BAILOUT_SQR`) the **distance estimate**
//!
//! ```text
//! d ≈ |z| · ln|z| / |z'|
//! ```
//!
//! (Milnor / Hubbard) approximates the distance from `z_0` to the set
//! boundary, in **complex-plane units**. It is the quantity that renders
//! the boundary as razor-sharp filaments: `d → 0` exactly on the
//! boundary and grows smoothly away from it, so a hard clamp of the first
//! few pixels of distance (the `Clamped` normalisation) draws hairlines.
//!
//! If no escape is detected within `max_iter` iterations the orbit is
//! treated as "inside the set" and the function returns [`f32::NAN`] —
//! the **same** inside/outside partition and sentinel contract as
//! [`crate::escape_time`], so the two Fields agree on which pixels are
//! interior. Callers MUST detect inside-set points with [`f32::is_nan`],
//! never with `==`.
//!
//! Like `escape_time`, the kernel is **family-agnostic** (ADR-0013): the
//! family difference lives entirely in the seeds the caller passes, never
//! in a branch on the fractal family.
//!
//! - **Mandelbrot** (differentiate w.r.t. `c`): `z_0 = 0`, `c = pixel`,
//!   `dz_0 = 0`, `dc = 1`.
//! - **Julia(C)** (differentiate w.r.t. `z_0`): `z_0 = pixel`, `c = C`,
//!   `dz_0 = 1`, `dc = 0`.
//!
//! Derivative recurrence: differentiating `z_{n+1} = z_n² + c` gives
//! `z'_{n+1} = 2·z_n·z'_n + dc`, evaluated with the *current* `z_n`
//! before `z` advances.

use crate::complex::Complex64;

/// Bailout threshold, identical to [`crate::escape_time`]'s
/// (`|z|² > 65_536` ⇔ `|z| > 256`). Sharing it keeps the inside-set
/// partition bit-for-bit consistent between the Escape Time and Distance
/// Estimate Fields, so switching Field never reclassifies a pixel as
/// interior vs. exterior. The large radius also sharpens the distance
/// estimate: the `|z|·ln|z|/|z'|` approximation tightens as `|z|` grows.
const BAILOUT_SQR: f64 = 65_536.0;

/// Estimate the distance from `z0` to the set boundary in complex-plane
/// units, or [`f32::NAN`] if the orbit stays bounded for `max_iter`
/// iterations (inside the set).
///
/// `dz0` / `dc` are the derivative seeds; see the module docs for the
/// per-family values. The function never branches on the fractal family.
pub fn escape_distance(
    z0: Complex64,
    c: Complex64,
    dz0: Complex64,
    dc: Complex64,
    max_iter: u32,
) -> f32 {
    let mut z = z0;
    let mut dz = dz0;
    for _ in 0..max_iter {
        let r2 = z.norm_sqr();
        if r2 > BAILOUT_SQR {
            let dz2 = dz.norm_sqr();
            // A collapsed derivative (`|z'| = 0`) has no usable gradient;
            // treat the point as on-boundary (distance 0) rather than
            // dividing by zero. Unreachable for the two seed pairs we ship
            // (Mandelbrot's `dz` becomes 1 after the first step from
            // `z_0 = 0`; Julia seeds `dz_0 = 1`), but keeps the kernel
            // total for arbitrary seeds.
            if dz2 == 0.0 {
                return 0.0;
            }
            // d = |z|·ln|z| / |z'|, all from squared magnitudes:
            //   |z|    = √r2
            //   ln|z|  = ½·ln(r2)
            //   |z'|   = √dz2
            let mod_z = r2.sqrt();
            let d = mod_z * (0.5 * r2.ln()) / dz2.sqrt();
            return d as f32;
        }
        // z'_{n+1} = 2·z_n·z'_n + dc, using the current `z` before it
        // advances. Written componentwise so `Complex64` keeps its
        // deliberately-minimal surface (no general complex multiply):
        // 2·(a+bi)(p+qi) = 2·((ap − bq) + (aq + bp)i).
        let dz_re = 2.0 * (z.re * dz.re - z.im * dz.im) + dc.re;
        let dz_im = 2.0 * (z.re * dz.im + z.im * dz.re) + dc.im;
        dz = Complex64::new(dz_re, dz_im);
        z = z.square() + c;
    }
    f32::NAN
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_ITER: u32 = 256;
    const ORIGIN: Complex64 = Complex64::new(0.0, 0.0);
    const ONE: Complex64 = Complex64::new(1.0, 0.0);

    // Mandelbrot seeds: vary c, fix z_0 = 0; dz_0 = 0, dc = 1.
    fn mandelbrot_distance(c: Complex64) -> f32 {
        escape_distance(ORIGIN, c, ORIGIN, ONE, MAX_ITER)
    }

    // The Douady rabbit — c inside the Mandelbrot set, so z_0 = 0 is
    // inside its connected filled Julia set. Same witness escape_time
    // uses, so the two kernels' inside/outside agreement is testable on a
    // shared, mathematically clean case.
    const JULIA_C_RABBIT: Complex64 = Complex64::new(-0.123, 0.745);

    // Julia seeds: vary z_0, fix c; dz_0 = 1, dc = 0.
    fn julia_distance(z0: Complex64, c: Complex64) -> f32 {
        escape_distance(z0, c, ONE, ORIGIN, MAX_ITER)
    }

    // --- Mandelbrot: inside-set → NaN ----------------------------------

    #[test]
    fn mandelbrot_origin_is_inside_nan() {
        // c = 0: orbit pinned at 0 forever — inside the set.
        assert!(mandelbrot_distance(Complex64::new(0.0, 0.0)).is_nan());
    }

    #[test]
    fn mandelbrot_main_cardioid_is_inside_nan() {
        // c = 0.25 sits on the cardioid cusp; the orbit never escapes.
        assert!(mandelbrot_distance(Complex64::new(0.25, 0.0)).is_nan());
    }

    #[test]
    fn mandelbrot_period_two_bulb_is_inside_nan() {
        // c = −1 is the centre of the period-2 bulb — inside the set.
        assert!(mandelbrot_distance(Complex64::new(-1.0, 0.0)).is_nan());
    }

    // --- Mandelbrot: outside-set → finite, positive distance -----------

    #[test]
    fn mandelbrot_exterior_point_has_finite_positive_distance() {
        // c = 2 is well outside the set (nearest set point on the real
        // axis is the cusp at 0.25). The estimate must be finite and > 0.
        let d = mandelbrot_distance(Complex64::new(2.0, 0.0));
        assert!(d.is_finite(), "exterior distance must be finite, got {d}");
        assert!(d > 0.0, "exterior distance must be positive, got {d}");
    }

    #[test]
    fn mandelbrot_distance_grows_with_distance_from_set() {
        // The estimate approximates true distance to the boundary, so a
        // point far from the set must read a larger distance than one just
        // outside it. c = 2.0 is ≈1.75 from the cusp (0.25); c = 0.30 is
        // ≈0.05 from it.
        let far = mandelbrot_distance(Complex64::new(2.0, 0.0));
        let near = mandelbrot_distance(Complex64::new(0.30, 0.0));
        assert!(far.is_finite() && near.is_finite());
        assert!(near > 0.0, "near distance must be positive, got {near}");
        assert!(
            far > near,
            "distance estimate not monotone: far={far} should exceed near={near}",
        );
    }

    #[test]
    fn mandelbrot_distance_is_smooth_between_neighbours() {
        // Distance is continuous, so two exterior pixels a tiny step apart
        // produce distances that differ by far less than one unit — this
        // smoothness is what yields anti-aliased filaments.
        let a = mandelbrot_distance(Complex64::new(1.0, 0.0));
        let b = mandelbrot_distance(Complex64::new(1.0001, 0.0));
        assert!(a.is_finite() && b.is_finite());
        assert!(
            (a - b).abs() < 0.01,
            "neighbouring distance jumped: |{a} − {b}| = {}",
            (a - b).abs(),
        );
    }

    // --- Family-agnostic: the same kernel serves Julia seeds -----------
    //
    // Slice 2 (#61) ships the Mandelbrot compute path; these lock the
    // kernel's family-agnostic contract on the Julia seed pair too, so
    // Slice 3 (#62) wires Julia in confident the maths already holds.

    #[test]
    fn julia_inside_set_origin_is_nan() {
        // z_0 = 0 is inside the Douady-rabbit filled Julia set (period-3
        // bounded orbit) — distance is the NaN inside-set sentinel.
        assert!(julia_distance(ORIGIN, JULIA_C_RABBIT).is_nan());
    }

    #[test]
    fn julia_exterior_point_has_finite_positive_distance() {
        // z_0 = (2, 2) is well outside the filled Julia set — finite, > 0.
        let d = julia_distance(Complex64::new(2.0, 2.0), JULIA_C_RABBIT);
        assert!(
            d.is_finite(),
            "Julia exterior distance must be finite, got {d}"
        );
        assert!(d > 0.0, "Julia exterior distance must be positive, got {d}");
    }

    #[test]
    fn seed_pairs_produce_distinct_results_on_the_same_point() {
        // The two seed pairs encode genuinely different derivatives: at the
        // same plane point, the Mandelbrot estimate (dz_0=0, dc=1) and the
        // Julia estimate (dz_0=1, dc=0) must differ — proving the seeds,
        // not a hidden family branch, drive the result. Use an exterior
        // point for the canonical UI Julia c so both escape.
        let p = Complex64::new(0.8, 0.6);
        let c = Complex64::new(-0.7, 0.27015);
        let m = escape_distance(ORIGIN, p, ORIGIN, ONE, MAX_ITER); // Mandelbrot at c = p
        let j = escape_distance(p, c, ONE, ORIGIN, MAX_ITER); // Julia at z_0 = p
        assert!(m.is_finite() && j.is_finite());
        assert!(m != j, "seed pairs gave identical results: {m} == {j}");
    }
}
