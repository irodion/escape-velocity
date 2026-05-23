//! Two-component complex number for escape-time iteration.
//!
//! Deliberately minimal: only the operations the inner loop needs
//! (`add`, `square`, `norm_sqr`). Not a general-purpose complex type —
//! when `fractal-core` outgrows this, replace it crate-wide rather
//! than incrementally expanding the API.

use std::ops::Add;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Complex64 {
    pub re: f64,
    pub im: f64,
}

impl Complex64 {
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    /// `|z|²` — squared modulus. Avoids the `sqrt` the escape-time
    /// bailout check would otherwise need.
    pub fn norm_sqr(self) -> f64 {
        self.re * self.re + self.im * self.im
    }

    /// `self * self`. `(a + bi)² = (a² − b²) + 2ab·i`.
    pub fn square(self) -> Self {
        Self {
            re: self.re * self.re - self.im * self.im,
            im: 2.0 * self.re * self.im,
        }
    }
}

impl Add for Complex64 {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self {
            re: self.re + rhs.re,
            im: self.im + rhs.im,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_componentwise() {
        let a = Complex64::new(1.0, 2.0);
        let b = Complex64::new(3.0, -4.0);
        assert_eq!(a + b, Complex64::new(4.0, -2.0));
    }

    #[test]
    fn square_of_pure_real() {
        let z = Complex64::new(3.0, 0.0);
        assert_eq!(z.square(), Complex64::new(9.0, 0.0));
    }

    #[test]
    fn square_of_pure_imaginary() {
        // (i)² = −1
        let z = Complex64::new(0.0, 1.0);
        assert_eq!(z.square(), Complex64::new(-1.0, 0.0));
    }

    #[test]
    fn square_of_mixed() {
        // (1 + 2i)² = (1 − 4) + 4i = −3 + 4i
        let z = Complex64::new(1.0, 2.0);
        assert_eq!(z.square(), Complex64::new(-3.0, 4.0));
    }

    #[test]
    fn norm_sqr_matches_definition() {
        let z = Complex64::new(3.0, 4.0);
        assert_eq!(z.norm_sqr(), 25.0);
    }
}
