//! A rectangular window onto the complex plane.
//!
//! The viewport is the only input `compute` needs to know *where* to
//! sample the Mandelbrot set. It encodes the project's coordinate
//! convention so that every layer above (WASM binding, TS glue) can
//! treat the math as opaque.
//!
//! ## Coordinate convention
//!
//! At `zoom = 1.0`, the viewport's real-axis span is `3.5` — the
//! canonical full-Mandelbrot width. For any zoom, the per-pixel
//! complex-plane scale is `(3.5 / width) / zoom`, applied symmetrically
//! to both axes so one pixel is square in the complex plane (the
//! imaginary-axis span follows from the canvas aspect ratio).
//!
//! Pixel `(0, 0)` is the top-left of the canvas. Image-y grows
//! downwards; the imaginary axis grows upwards — so the y-mapping is
//! negated. The geometric centre of the pixel grid maps to
//! `viewport.center`.

use crate::complex::Complex64;

/// At `zoom = 1.0`, the viewport spans this much of the real axis.
/// 3.5 is wide enough to show the full canonical Mandelbrot set
/// (`re ∈ [−2.5, 1.0]`).
const BASE_RE_SPAN: f64 = 3.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub center: Complex64,
    pub zoom: f64,
    pub width: u32,
    pub height: u32,
}

impl Viewport {
    pub const fn new(center: Complex64, zoom: f64, width: u32, height: u32) -> Self {
        Self {
            center,
            zoom,
            width,
            height,
        }
    }

    /// Complex-plane size of one pixel. Identical on both axes
    /// (square pixels in the complex plane).
    pub fn pixel_scale(&self) -> f64 {
        (BASE_RE_SPAN / f64::from(self.width)) / self.zoom
    }

    /// Map an integer pixel index to its complex-plane sample point.
    ///
    /// `pixel_to_complex(0, 0)` is the top-left pixel; the geometric
    /// centre of the pixel grid maps to `self.center`.
    pub fn pixel_to_complex(&self, px: u32, py: u32) -> Complex64 {
        let scale = self.pixel_scale();
        let mid_x = f64::from(self.width - 1) / 2.0;
        let mid_y = f64::from(self.height - 1) / 2.0;
        Complex64::new(
            self.center.re + (f64::from(px) - mid_x) * scale,
            self.center.im - (f64::from(py) - mid_y) * scale,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_viewport() -> Viewport {
        Viewport::new(Complex64::new(-0.5, 0.0), 1.0, 800, 600)
    }

    #[test]
    fn top_left_pixel_is_top_left_corner() {
        let vp = sample_viewport();
        let scale = vp.pixel_scale();
        let mid_x = f64::from(vp.width - 1) / 2.0;
        let mid_y = f64::from(vp.height - 1) / 2.0;
        let expected = Complex64::new(vp.center.re - mid_x * scale, vp.center.im + mid_y * scale);
        assert_eq!(vp.pixel_to_complex(0, 0), expected);
    }

    #[test]
    fn bottom_right_pixel_is_bottom_right_corner() {
        let vp = sample_viewport();
        let scale = vp.pixel_scale();
        let mid_x = f64::from(vp.width - 1) / 2.0;
        let mid_y = f64::from(vp.height - 1) / 2.0;
        let expected = Complex64::new(vp.center.re + mid_x * scale, vp.center.im - mid_y * scale);
        assert_eq!(vp.pixel_to_complex(vp.width - 1, vp.height - 1), expected);
    }

    #[test]
    fn center_pixel_is_viewport_center_within_one_pixel_scale() {
        let vp = sample_viewport();
        let mid = vp.pixel_to_complex(vp.width / 2, vp.height / 2);
        let scale = vp.pixel_scale();
        assert!((mid.re - vp.center.re).abs() <= scale);
        assert!((mid.im - vp.center.im).abs() <= scale);
    }

    #[test]
    fn pixels_are_square_in_complex_plane() {
        let vp = sample_viewport();
        let dx = vp.pixel_to_complex(1, 0).re - vp.pixel_to_complex(0, 0).re;
        let dy = vp.pixel_to_complex(0, 0).im - vp.pixel_to_complex(0, 1).im;
        assert!((dx - dy).abs() < 1e-15);
    }

    #[test]
    fn zoom_scales_per_pixel_step_inversely() {
        let center = Complex64::new(0.0, 0.0);
        let vp1 = Viewport::new(center, 1.0, 800, 600);
        let vp2 = Viewport::new(center, 2.0, 800, 600);
        let step1 = vp1.pixel_to_complex(1, 0).re - vp1.pixel_to_complex(0, 0).re;
        let step2 = vp2.pixel_to_complex(1, 0).re - vp2.pixel_to_complex(0, 0).re;
        // Doubling zoom should halve the per-pixel step.
        assert!((step1 - 2.0 * step2).abs() < 1e-15);
    }

    #[test]
    fn re_axis_span_at_zoom_one_is_canonical() {
        // At zoom = 1.0 the viewport should span exactly 3.5 on the
        // real axis from pixel 0 to pixel width (one pixel past the
        // last sample); the sample-to-sample span is one pixel less.
        let vp = Viewport::new(Complex64::new(0.0, 0.0), 1.0, 800, 600);
        let sample_span = vp.pixel_to_complex(vp.width - 1, 0).re - vp.pixel_to_complex(0, 0).re;
        let expected = BASE_RE_SPAN * f64::from(vp.width - 1) / f64::from(vp.width);
        assert!((sample_span - expected).abs() < 1e-12);
    }
}
