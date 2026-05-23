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

/// Floor for `zoom`. Below `0.25` the set shrinks to a few pixels and
/// the interaction stops being useful — a UX floor, not a numerical
/// one.
pub const MIN_ZOOM: f64 = 0.25;

/// Ceiling for `zoom`. ADR-0006 pins the project to `f64` throughout
/// and accepts the ~10^13 zoom horizon that implies; past that, the
/// per-pixel complex-plane step underflows the mantissa and the image
/// degrades into a posterised mush. Slices 7+ (perturbation theory)
/// would raise this; until then, clamping here is the correct fix.
pub const MAX_ZOOM: f64 = 1e13;

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
        self.pixel_to_complex_f(f64::from(px), f64::from(py))
    }

    /// Sub-pixel form of [`Self::pixel_to_complex`]. Required by pan
    /// (sub-pixel drag offsets are representable in `f64` but not in
    /// `u32`) and by cursor-invariant zoom (a wheel event arrives with
    /// `f64` cursor coordinates from `getBoundingClientRect`).
    ///
    /// Agrees with [`Self::pixel_to_complex`] when `px`/`py` are exact
    /// integers cast from `u32`.
    pub fn pixel_to_complex_f(&self, px: f64, py: f64) -> Complex64 {
        let scale = self.pixel_scale();
        let mid_x = f64::from(self.width - 1) / 2.0;
        let mid_y = f64::from(self.height - 1) / 2.0;
        Complex64::new(
            self.center.re + (px - mid_x) * scale,
            self.center.im - (py - mid_y) * scale,
        )
    }

    /// Shift the viewport by `(dx_pixels, dy_pixels)` measured in
    /// canvas pixels.
    ///
    /// ## Sign convention
    ///
    /// `dx_pixels` / `dy_pixels` are the displacement the *rendered
    /// image* should appear to undergo — positive `dx_pixels` shifts
    /// the image right on screen, positive `dy_pixels` shifts it down.
    /// Concretely, after `pan_by_pixels(dx, dy)`,
    /// `new.pixel_to_complex_f(p + dx, q + dy)` equals
    /// `self.pixel_to_complex_f(p, q)` for every `(p, q)`.
    ///
    /// In complex-plane terms: positive `dx_pixels` decreases
    /// `center.re` by `dx_pixels × pixel_scale`. Positive `dy_pixels`
    /// *increases* `center.im` by `dy_pixels × pixel_scale` — image-y
    /// grows downward while the imaginary axis grows upward, the same
    /// flip [`Self::pixel_to_complex_f`] applies.
    ///
    /// `f64` deltas keep sub-pixel drag offsets representable. `zoom`,
    /// `width`, and `height` are preserved exactly.
    pub fn pan_by_pixels(&self, dx_pixels: f64, dy_pixels: f64) -> Viewport {
        let scale = self.pixel_scale();
        Self {
            center: Complex64::new(
                self.center.re - dx_pixels * scale,
                self.center.im + dy_pixels * scale,
            ),
            zoom: self.zoom,
            width: self.width,
            height: self.height,
        }
    }

    /// Multiply `zoom` by `factor` while keeping the complex-plane
    /// point under `(pixel_x, pixel_y)` invariant.
    ///
    /// This is the load-bearing property for wheel-zoom UX: the point
    /// under the cursor stays under the cursor across the zoom step.
    /// `pixel_x` / `pixel_y` are `f64` so the cursor coordinates
    /// reported by `getBoundingClientRect` survive without rounding.
    ///
    /// The resulting `zoom` is clamped to `[MIN_ZOOM, MAX_ZOOM]`; at
    /// the clamp boundary the cursor-invariant property still holds
    /// exactly (the algebra computes the post-clamp center). `factor
    /// = 1.0` is the identity (modulo floating-point noise from the
    /// pre/post difference, which cancels to zero analytically).
    /// `width` and `height` are preserved exactly.
    pub fn zoom_around(&self, pixel_x: f64, pixel_y: f64, factor: f64) -> Viewport {
        let pre = self.pixel_to_complex_f(pixel_x, pixel_y);
        let new_zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let candidate = Self {
            center: self.center,
            zoom: new_zoom,
            width: self.width,
            height: self.height,
        };
        let post = candidate.pixel_to_complex_f(pixel_x, pixel_y);
        Self {
            center: Complex64::new(
                candidate.center.re + (pre.re - post.re),
                candidate.center.im + (pre.im - post.im),
            ),
            zoom: new_zoom,
            width: self.width,
            height: self.height,
        }
    }

    /// Return a viewport sampling the same complex-plane region at a
    /// different pixel resolution. `center` and `zoom` are preserved
    /// exactly; only `width` and `height` change.
    ///
    /// `pixel_scale` follows the new `width` per the formula in
    /// [`Self::pixel_scale`] — doubling `width` halves the per-pixel
    /// step, so the same window is sampled at finer granularity.
    ///
    /// Validation follows the PR #5 convention: `fractal-core` trusts
    /// callers, so `width == 0` is not rejected here. The
    /// `fractal-wasm` binding rejects zero at the WASM boundary.
    pub fn with_resolution(&self, width: u32, height: u32) -> Viewport {
        Self {
            center: self.center,
            zoom: self.zoom,
            width,
            height,
        }
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

    // --- pixel_to_complex_f -------------------------------------------

    #[test]
    fn pixel_to_complex_f_agrees_with_integer_form() {
        let vp = sample_viewport();
        // Sweep a handful of pixels across the grid — including the
        // edges where mid_x/mid_y interact most.
        for &(px, py) in &[
            (0_u32, 0_u32),
            (1, 0),
            (0, 1),
            (vp.width / 2, vp.height / 2),
            (vp.width - 1, vp.height - 1),
        ] {
            assert_eq!(
                vp.pixel_to_complex(px, py),
                vp.pixel_to_complex_f(f64::from(px), f64::from(py)),
            );
        }
    }

    #[test]
    fn pixel_to_complex_f_half_pixel_is_midpoint() {
        let vp = sample_viewport();
        let a = vp.pixel_to_complex(0, 0);
        let b = vp.pixel_to_complex(1, 1);
        let mid = vp.pixel_to_complex_f(0.5, 0.5);
        assert!((mid.re - (a.re + b.re) / 2.0).abs() < 1e-15);
        assert!((mid.im - (a.im + b.im) / 2.0).abs() < 1e-15);
    }

    // --- pan_by_pixels ------------------------------------------------

    #[test]
    fn pan_by_zero_is_identity() {
        let vp = sample_viewport();
        assert_eq!(vp.pan_by_pixels(0.0, 0.0), vp);
    }

    #[test]
    fn pan_then_unpan_round_trips() {
        let vp = sample_viewport();
        let dx = 137.5;
        let dy = -42.25;
        let round = vp.pan_by_pixels(dx, dy).pan_by_pixels(-dx, -dy);
        assert!((round.center.re - vp.center.re).abs() < 1e-15);
        assert!((round.center.im - vp.center.im).abs() < 1e-15);
        assert_eq!(round.zoom, vp.zoom);
        assert_eq!(round.width, vp.width);
        assert_eq!(round.height, vp.height);
    }

    #[test]
    fn pan_shifts_center_re_by_exactly_minus_dx_times_scale() {
        let vp = sample_viewport();
        let dx = 50.0;
        let panned = vp.pan_by_pixels(dx, 0.0);
        assert_eq!(panned.center.re, vp.center.re - dx * vp.pixel_scale());
        assert_eq!(panned.center.im, vp.center.im);
    }

    #[test]
    fn pan_shifts_center_im_by_exactly_plus_dy_times_scale() {
        let vp = sample_viewport();
        let dy = 50.0;
        let panned = vp.pan_by_pixels(0.0, dy);
        assert_eq!(panned.center.re, vp.center.re);
        assert_eq!(panned.center.im, vp.center.im + dy * vp.pixel_scale());
    }

    #[test]
    fn pan_preserves_zoom_width_height() {
        let vp = sample_viewport();
        let panned = vp.pan_by_pixels(12.5, -7.5);
        assert_eq!(panned.zoom, vp.zoom);
        assert_eq!(panned.width, vp.width);
        assert_eq!(panned.height, vp.height);
    }

    #[test]
    fn pan_shifts_image_so_new_pixel_p_plus_d_shows_old_pixel_p() {
        // The load-bearing property: after pan_by_pixels(dx, dy), the
        // world point at new pixel (p + dx, q + dy) equals the world
        // point at old pixel (p, q). This is what makes drag-to-pan
        // visually continuous on the InputController side.
        let vp = sample_viewport();
        let dx = 50.0;
        let dy = -25.0;
        let panned = vp.pan_by_pixels(dx, dy);
        let p = 100.0_f64;
        let q = 200.0_f64;
        let before = vp.pixel_to_complex_f(p, q);
        let after = panned.pixel_to_complex_f(p + dx, q + dy);
        assert!((after.re - before.re).abs() < 1e-12);
        assert!((after.im - before.im).abs() < 1e-12);
    }

    // --- zoom_around --------------------------------------------------

    #[test]
    fn zoom_around_factor_one_is_identity_for_any_pixel() {
        let vp = sample_viewport();
        for &(px, py) in &[(0.0, 0.0), (123.5, 77.0), (799.0, 599.0)] {
            let zoomed = vp.zoom_around(px, py, 1.0);
            assert_eq!(zoomed.zoom, vp.zoom);
            assert!((zoomed.center.re - vp.center.re).abs() < 1e-15);
            assert!((zoomed.center.im - vp.center.im).abs() < 1e-15);
            assert_eq!(zoomed.width, vp.width);
            assert_eq!(zoomed.height, vp.height);
        }
    }

    #[test]
    fn zoom_around_keeps_point_under_cursor_invariant() {
        // The cursor-invariant property: pixel_to_complex_f(px, py) is
        // the same before and after zoom_around(px, py, factor). Sweep
        // a few zoom levels and a few cursor positions.
        let cases = [
            (1.0_f64, 100.0_f64, 100.0_f64, 1.25_f64),
            (1.0, 400.0, 300.0, 4.0),
            (50.0, 0.0, 0.0, 1.1),
            (1e3, 799.0, 599.0, 2.0),
            (1e6, 250.5, 175.25, 0.5),
        ];
        for &(zoom, px, py, factor) in &cases {
            let vp = Viewport::new(Complex64::new(-0.5, 0.1), zoom, 800, 600);
            let before = vp.pixel_to_complex_f(px, py);
            let zoomed = vp.zoom_around(px, py, factor);
            let after = zoomed.pixel_to_complex_f(px, py);
            assert!(
                (after.re - before.re).abs() < 1e-12,
                "re drift {} at zoom={} factor={}",
                (after.re - before.re).abs(),
                zoom,
                factor,
            );
            assert!(
                (after.im - before.im).abs() < 1e-12,
                "im drift {} at zoom={} factor={}",
                (after.im - before.im).abs(),
                zoom,
                factor,
            );
        }
    }

    #[test]
    fn zoom_then_unzoom_returns_to_original() {
        // Same pixel, reciprocal factor — should round-trip the
        // viewport. Stays away from the clamp boundaries so the
        // round-trip is meaningful.
        let vp = Viewport::new(Complex64::new(-0.5, 0.1), 10.0, 800, 600);
        let px = 250.0;
        let py = 175.0;
        let factor = 3.7;
        let round = vp
            .zoom_around(px, py, factor)
            .zoom_around(px, py, 1.0 / factor);
        assert!((round.zoom - vp.zoom).abs() < 1e-12);
        assert!((round.center.re - vp.center.re).abs() < 1e-12);
        assert!((round.center.im - vp.center.im).abs() < 1e-12);
    }

    #[test]
    fn zoom_clamps_at_max_zoom() {
        let vp = Viewport::new(Complex64::new(0.0, 0.0), MAX_ZOOM, 800, 600);
        let zoomed = vp.zoom_around(400.0, 300.0, 10.0);
        assert_eq!(zoomed.zoom, MAX_ZOOM);
    }

    #[test]
    fn zoom_clamps_at_min_zoom() {
        let vp = Viewport::new(Complex64::new(0.0, 0.0), MIN_ZOOM, 800, 600);
        let zoomed = vp.zoom_around(400.0, 300.0, 0.1);
        assert_eq!(zoomed.zoom, MIN_ZOOM);
    }

    #[test]
    fn zoom_clamp_does_not_overshoot_when_approaching_max() {
        // Crossing the ceiling from below: a single zoom-in step large
        // enough to overshoot must land exactly on MAX_ZOOM, not past
        // it.
        let vp = Viewport::new(Complex64::new(0.0, 0.0), MAX_ZOOM / 2.0, 800, 600);
        let zoomed = vp.zoom_around(400.0, 300.0, 10.0);
        assert_eq!(zoomed.zoom, MAX_ZOOM);
    }

    #[test]
    fn zoom_preserves_width_and_height() {
        let vp = sample_viewport();
        let zoomed = vp.zoom_around(123.0, 77.0, 2.5);
        assert_eq!(zoomed.width, vp.width);
        assert_eq!(zoomed.height, vp.height);
    }

    // --- with_resolution ----------------------------------------------

    #[test]
    fn with_resolution_preserves_center_exactly() {
        let vp = sample_viewport();
        let resized = vp.with_resolution(1600, 1200);
        assert_eq!(resized.center, vp.center);
    }

    #[test]
    fn with_resolution_preserves_zoom_exactly() {
        let vp = sample_viewport();
        let resized = vp.with_resolution(1600, 1200);
        assert_eq!(resized.zoom, vp.zoom);
    }

    #[test]
    fn with_resolution_sets_dimensions_exactly() {
        let vp = sample_viewport();
        let resized = vp.with_resolution(1600, 1200);
        assert_eq!(resized.width, 1600);
        assert_eq!(resized.height, 1200);
    }

    #[test]
    fn with_resolution_identity_at_same_dimensions() {
        let vp = sample_viewport();
        assert_eq!(vp.with_resolution(vp.width, vp.height), vp);
    }

    #[test]
    fn with_resolution_halves_pixel_scale_at_double_width() {
        let vp = sample_viewport();
        let resized = vp.with_resolution(vp.width * 2, vp.height * 2);
        assert_eq!(resized.pixel_scale(), vp.pixel_scale() / 2.0);
    }

    #[test]
    fn with_resolution_center_pixel_maps_to_same_complex_point() {
        // The pixel grid's geometric centre maps to `center` in both
        // viewports; choosing the integer pixel nearest the centre
        // introduces at most one pixel-scale of drift, which the new
        // (finer) pixel-scale bounds.
        let vp = sample_viewport();
        let resized = vp.with_resolution(1600, 1200);
        let before = vp.pixel_to_complex(vp.width / 2, vp.height / 2);
        let after = resized.pixel_to_complex(resized.width / 2, resized.height / 2);
        let tolerance = vp.pixel_scale();
        assert!((after.re - before.re).abs() <= tolerance);
        assert!((after.im - before.im).abs() <= tolerance);
    }
}
