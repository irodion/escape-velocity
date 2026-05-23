//! The Mandelbrot escape-time iteration — the pedagogical heart of the crate.
//!
//! For each complex `c`, iterate `z_{n+1} = z_n² + c` starting from
//! `z_0 = 0`. Return the iteration index `n` at which `|z_n|² > 4`
//! (the standard bailout radius of 2). If no escape is detected within
//! `max_iter` iterations, return `max_iter` — by convention this is
//! "inside the set" for rendering purposes, even though strictly it
//! only means "did not escape within our budget".

use crate::complex::Complex64;

/// Bailout threshold: `|z|² > 4` ⇔ `|z| > 2`. Once the orbit crosses
/// radius 2 it provably escapes to infinity.
const BAILOUT_SQR: f64 = 4.0;

pub fn escape_time(c: Complex64, max_iter: u32) -> u32 {
    let mut z = Complex64::new(0.0, 0.0);
    for i in 0..max_iter {
        if z.norm_sqr() > BAILOUT_SQR {
            return i;
        }
        z = z.square() + c;
    }
    max_iter
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_ITER: u32 = 256;

    #[test]
    fn origin_stays_inside_the_set() {
        // c = 0: z stays at 0 forever.
        assert_eq!(escape_time(Complex64::new(0.0, 0.0), MAX_ITER), MAX_ITER);
    }

    #[test]
    fn minus_one_stays_inside_the_set() {
        // c = −1: orbit is 0, −1, 0, −1, … (period 2).
        assert_eq!(escape_time(Complex64::new(-1.0, 0.0), MAX_ITER), MAX_ITER);
    }

    #[test]
    fn two_escapes_immediately() {
        // c = 2: z_1 = 2 (|z|²=4, exactly on bailout — strict ">"),
        // z_2 = 6 (|z|²=36, escaped). Returns 2.
        let n = escape_time(Complex64::new(2.0, 0.0), MAX_ITER);
        assert!(n <= 2, "expected escape within 2 iterations, got {n}");
    }

    #[test]
    fn half_escapes_in_a_small_bounded_count() {
        // c = 0.5 is well outside the set; it escapes quickly but
        // not on iteration 1 or 2.
        let n = escape_time(Complex64::new(0.5, 0.0), MAX_ITER);
        assert!(n < MAX_ITER, "expected escape, got {n}");
        assert!(n < 32, "expected fast escape, got {n}");
    }

    #[test]
    fn main_cardioid_boundary_stays_inside() {
        // c = 0.25 sits on the cusp of the main cardioid. The orbit
        // converges to z = 0.5 from below but never escapes |z| = 2.
        assert_eq!(escape_time(Complex64::new(0.25, 0.0), MAX_ITER), MAX_ITER);
    }
}
