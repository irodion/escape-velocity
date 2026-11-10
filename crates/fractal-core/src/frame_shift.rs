//! Reusing a frame's buffer after a pan (#170).
//!
//! A pan moves the centre by whole pixels and changes nothing else, so most of
//! the new frame is the old one shifted. [`whole_pixel_shift`] recognises such
//! a pair of viewports, [`shift_in_place`] moves the buffer's pixels to where
//! the new frame shows them and returns the [`Region`] they now cover, and
//! [`Region::exposed`] lists what a band of rows still has to compute.
//!
//! ## Tolerance
//!
//! A shifted pixel keeps the value sampled at the old frame's coordinate. A
//! fresh compute would sample `center' + offset · scale`, which rounds
//! differently: the two coordinates agree to within [`SHIFT_TOLERANCE_PX`] of a
//! pixel, plus the centre's own rounding (≤ ½ ULP). That is invisible, but not
//! bit-identical; a boundary pixel can land on a different iteration count. The
//! bit-identical guarantees (parallel vs serial, banded vs full) are about one
//! frame's compute and are unaffected.

use crate::viewport::Viewport;

/// How far from a whole number of pixels a pan may be and still reuse the
/// previous frame: 1% of a pixel. A pan committed in whole buffer pixels lands
/// within ~10⁻¹² px at ordinary zooms; at the deepest zooms the centre's own
/// rounding is a sizeable fraction of a pixel, the check fails, and the frame
/// is computed in full, as before.
pub const SHIFT_TOLERANCE_PX: f64 = 0.01;

/// The whole-pixel shift `(dx, dy)` that takes `from`'s frame to `to`'s, when
/// `to` is `from` panned by whole pixels (zoom and size unchanged) and the two
/// frames still overlap. `to`'s pixel `(x, y)` then shows `from`'s pixel
/// `(x - dx, y - dy)`, the same sign convention as [`Viewport::pan_by_pixels`].
///
/// `None` when the zoom or size differs, the pan is not within
/// [`SHIFT_TOLERANCE_PX`] of whole pixels, or it moves the frame entirely out
/// of view (nothing would carry over).
pub fn whole_pixel_shift(from: &Viewport, to: &Viewport) -> Option<(i64, i64)> {
    // Bitwise-equal zoom: the pixel scale must be exactly the one the cached
    // values were computed (and, for Distance Estimate, divided) with.
    if from.zoom.to_bits() != to.zoom.to_bits()
        || from.width != to.width
        || from.height != to.height
    {
        return None;
    }
    let scale = from.pixel_scale();
    let dx = (from.center.re - to.center.re) / scale;
    let dy = (to.center.im - from.center.im) / scale;
    let (rx, ry) = (dx.round(), dy.round());
    // `!(x <= t)` rather than `x > t`, so a NaN (an infinite or NaN centre)
    // fails the check too.
    if !((dx - rx).abs() <= SHIFT_TOLERANCE_PX && (dy - ry).abs() <= SHIFT_TOLERANCE_PX) {
        return None;
    }
    if rx.abs() >= f64::from(from.width) || ry.abs() >= f64::from(from.height) {
        return None;
    }
    // In range: |rx| < width ≤ u32::MAX, so the casts are exact.
    Some((rx as i64, ry as i64))
}

/// A rectangle of a frame's pixels, columns `[x0, x1)` × rows `[y0, y1)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Region {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Region {
    /// No pixels: what a frame computed from scratch carries over.
    pub const EMPTY: Region = Region {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    };

    /// Where a `width` × `height` frame's pixels land after a shift of
    /// `(dx, dy)`: the part of the new frame [`shift_in_place`] fills with
    /// carried values. Same contract: `|dx| < width`, `|dy| < height`.
    pub fn carried(width: u32, height: u32, dx: i64, dy: i64) -> Region {
        let (w, h) = (i64::from(width), i64::from(height));
        // The contract keeps every bound in [0, width] / [0, height]: the
        // casts are exact.
        Region {
            x0: dx.max(0) as u32,
            x1: (w + dx).min(w) as u32,
            y0: dy.max(0) as u32,
            y1: (h + dy).min(h) as u32,
        }
    }

    pub fn is_empty(self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }

    /// The parts of rows `[y0, y1)` of a `width`-wide frame that lie outside
    /// this region, as `(y0, y1, x0, x1)` rectangles: whole rows above and
    /// below it, and the strips left and right of it in the rows it spans.
    /// Together with the region they tile the band exactly once. Empty
    /// rectangles are left out.
    pub fn exposed(self, width: u32, y0: u32, y1: u32) -> Vec<(u32, u32, u32, u32)> {
        if self.is_empty() {
            return if y0 < y1 {
                vec![(y0, y1, 0, width)]
            } else {
                Vec::new()
            };
        }
        let mut out = Vec::with_capacity(4);
        // Rows above and below the region: whole rows.
        let above = (y0, y1.min(self.y0));
        let below = (y0.max(self.y1), y1);
        // Rows the region spans: the strips either side of it.
        let beside = (y0.max(self.y0), y1.min(self.y1));
        if above.0 < above.1 {
            out.push((above.0, above.1, 0, width));
        }
        if beside.0 < beside.1 {
            if self.x0 > 0 {
                out.push((beside.0, beside.1, 0, self.x0));
            }
            if self.x1 < width {
                out.push((beside.0, beside.1, self.x1, width));
            }
        }
        if below.0 < below.1 {
            out.push((below.0, below.1, 0, width));
        }
        out
    }
}

/// Shift a `width` × `height` row-major frame by `(dx, dy)` pixels in place,
/// so that pixel `(x, y)` takes the value pixel `(x - dx, y - dy)` held, and
/// return the [`Region`] those carried values now cover. Pixels outside it keep
/// stale values; the caller computes them.
///
/// `|dx| < width`, `|dy| < height` and `buf.len() == width * height` are the
/// caller's contract ([`whole_pixel_shift`] returns only such shifts).
pub fn shift_in_place(buf: &mut [f32], width: u32, height: u32, dx: i64, dy: i64) -> Region {
    debug_assert_eq!(buf.len(), (width as usize) * (height as usize));
    debug_assert!(dx.unsigned_abs() < u64::from(width) && dy.unsigned_abs() < u64::from(height));
    let region = Region::carried(width, height, dx, dy);
    let row_len = (region.x1 - region.x0) as usize;
    let src_x0 = (i64::from(region.x0) - dx) as usize;
    let copy_row = |buf: &mut [f32], y: u32| {
        let src_y = (i64::from(y) - dy) as usize;
        let src = src_y * width as usize + src_x0;
        let dst = y as usize * width as usize + region.x0 as usize;
        buf.copy_within(src..src + row_len, dst);
    };
    // Walk rows so each source row is read before anything overwrites it:
    // moving down, start from the bottom; moving up (or not at all), the top.
    // Within a row `copy_within` handles the overlap.
    if dy > 0 {
        for y in (region.y0..region.y1).rev() {
            copy_row(buf, y);
        }
    } else {
        for y in region.y0..region.y1 {
            copy_row(buf, y);
        }
    }
    region
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::complex::Complex64;
    use crate::field::Field;
    use crate::fractal_kind::FractalKind;
    use crate::pipeline::{compute, compute_region_into};

    fn viewport(re: f64, im: f64) -> Viewport {
        Viewport::new(Complex64::new(re, im), 200.0, 64, 48)
    }

    #[test]
    fn a_whole_pixel_pan_is_recognised_with_pan_by_pixels_signs() {
        let from = viewport(-0.7435, 0.1314);
        for (dx, dy) in [(0, 0), (5, 0), (-13, 7), (63, -47), (-63, 47)] {
            let to = from.pan_by_pixels(dx as f64, dy as f64);
            assert_eq!(
                whole_pixel_shift(&from, &to),
                Some((dx, dy)),
                "pan ({dx}, {dy})"
            );
        }
    }

    #[test]
    fn anything_but_a_whole_pixel_pan_of_the_same_frame_is_refused() {
        let from = viewport(-0.7435, 0.1314);
        // Sub-pixel.
        assert_eq!(
            whole_pixel_shift(&from, &from.pan_by_pixels(3.4, 0.0)),
            None
        );
        assert_eq!(
            whole_pixel_shift(&from, &from.pan_by_pixels(0.0, -0.05)),
            None
        );
        // Out of view.
        assert_eq!(
            whole_pixel_shift(&from, &from.pan_by_pixels(64.0, 0.0)),
            None
        );
        assert_eq!(
            whole_pixel_shift(&from, &from.pan_by_pixels(0.0, -48.0)),
            None
        );
        // Another zoom or size.
        let zoomed = Viewport {
            zoom: 201.0,
            ..from
        };
        assert_eq!(whole_pixel_shift(&from, &zoomed), None);
        assert_eq!(
            whole_pixel_shift(&from, &from.with_resolution(65, 48)),
            None
        );
        // A non-finite centre.
        assert_eq!(whole_pixel_shift(&from, &viewport(f64::NAN, 0.1314)), None);
    }

    #[test]
    fn a_shift_carries_each_pixel_to_where_the_pan_shows_it() {
        let (w, h) = (7u32, 5u32);
        let original: Vec<f32> = (0..w * h).map(|i| i as f32).collect();
        for dx in -6..=6_i64 {
            for dy in -4..=4_i64 {
                let mut buf = original.clone();
                let region = shift_in_place(&mut buf, w, h, dx, dy);
                for y in 0..h {
                    for x in 0..w {
                        let inside = (region.x0..region.x1).contains(&x)
                            && (region.y0..region.y1).contains(&y);
                        let (sx, sy) = (i64::from(x) - dx, i64::from(y) - dy);
                        let in_old =
                            (0..i64::from(w)).contains(&sx) && (0..i64::from(h)).contains(&sy);
                        assert_eq!(inside, in_old, "({x}, {y}) shift ({dx}, {dy})");
                        if inside {
                            let expected = original[(sy * i64::from(w) + sx) as usize];
                            assert_eq!(buf[(y * w + x) as usize], expected);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_exposed_rectangles_and_the_region_tile_a_band_once() {
        let (w, h) = (9u32, 8u32);
        let regions = [
            Region::EMPTY,
            Region {
                x0: 0,
                y0: 0,
                x1: w,
                y1: h,
            },
            Region {
                x0: 3,
                y0: 0,
                x1: w,
                y1: h,
            },
            Region {
                x0: 0,
                y0: 2,
                x1: 6,
                y1: h,
            },
            Region {
                x0: 2,
                y0: 3,
                x1: 5,
                y1: 6,
            },
        ];
        for region in regions {
            for (y0, y1) in [(0, h), (0, 3), (2, 5), (5, h), (4, 4)] {
                let mut covered = vec![0u8; (w * h) as usize];
                for (ry0, ry1, rx0, rx1) in region.exposed(w, y0, y1) {
                    assert!(
                        ry0 < ry1 && rx0 < rx1,
                        "{region:?} band ({y0}, {y1}): empty rect"
                    );
                    for y in ry0..ry1 {
                        for x in rx0..rx1 {
                            covered[(y * w + x) as usize] += 1;
                        }
                    }
                }
                for y in 0..h {
                    for x in 0..w {
                        let in_band = (y0..y1).contains(&y);
                        let in_region = !region.is_empty()
                            && (region.x0..region.x1).contains(&x)
                            && (region.y0..region.y1).contains(&y);
                        let expected = u8::from(in_band && !in_region);
                        assert_eq!(
                            covered[(y * w + x) as usize],
                            expected,
                            "{region:?} band ({y0}, {y1}) pixel ({x}, {y})"
                        );
                    }
                }
            }
        }
    }

    /// A panned frame built the #170 way: the old frame shifted, then each
    /// band's exposed rectangles computed.
    fn panned(from: &Viewport, to: &Viewport, kind: FractalKind, field: Field) -> Vec<f32> {
        let (dx, dy) = whole_pixel_shift(from, to).expect("a whole-pixel pan");
        let mut buf = compute(from, 256, kind, field);
        let region = shift_in_place(&mut buf, to.width, to.height, dx, dy);
        let w = to.width as usize;
        for (y0, y1) in [(0, 17), (17, 30), (30, to.height)] {
            let band = &mut buf[y0 as usize * w..y1 as usize * w];
            for (ry0, ry1, x0, x1) in region.exposed(to.width, y0, y1) {
                let rows = &mut band[(ry0 - y0) as usize * w..(ry1 - y0) as usize * w];
                compute_region_into(to, 256, kind, field, ry0, ry1, x0, x1, rows);
            }
        }
        buf
    }

    #[test]
    fn a_region_compute_matches_the_same_pixels_of_a_full_compute() {
        let vp = viewport(-0.7435, 0.1314);
        let full = compute(&vp, 256, FractalKind::Mandelbrot, Field::EscapeTime);
        let w = vp.width as usize;
        let mut rows = vec![-1.0f32; 10 * w];
        compute_region_into(
            &vp,
            256,
            FractalKind::Mandelbrot,
            Field::EscapeTime,
            20,
            30,
            11,
            40,
            &mut rows,
        );
        for y in 20..30 {
            for x in 0..w {
                let got = rows[(y - 20) * w + x];
                if (11..40).contains(&x) {
                    assert_eq!(got.to_bits(), full[y * w + x].to_bits(), "({x}, {y})");
                } else {
                    assert_eq!(got, -1.0, "({x}, {y}) is outside the region");
                }
            }
        }
    }

    #[test]
    fn a_panned_frame_matches_a_fresh_compute() {
        let from = viewport(-0.7435, 0.1314);
        let kinds = [
            FractalKind::Mandelbrot,
            FractalKind::Julia {
                c: Complex64::new(-0.7, 0.27015),
            },
        ];
        for kind in kinds {
            for field in [Field::EscapeTime, Field::DistanceEstimate] {
                for (dx, dy) in [(9, 0), (-20, 13), (0, -30)] {
                    let to = from.pan_by_pixels(f64::from(dx), f64::from(dy));
                    let got = panned(&from, &to, kind, field);
                    let fresh = compute(&to, 256, kind, field);
                    let region = Region::carried(to.width, to.height, dx.into(), dy.into());
                    let mut carried_diffs = 0;
                    for (i, (a, b)) in got.iter().zip(&fresh).enumerate() {
                        let (x, y) = ((i as u32) % to.width, (i as u32) / to.width);
                        let carried = (region.x0..region.x1).contains(&x)
                            && (region.y0..region.y1).contains(&y);
                        if !carried {
                            // Computed fresh for `to`: bit-identical.
                            assert_eq!(
                                a.to_bits(),
                                b.to_bits(),
                                "{kind:?} {field:?} ({dx}, {dy}) exposed ({x}, {y})"
                            );
                        } else if a.to_bits() != b.to_bits() {
                            carried_diffs += 1;
                        }
                    }
                    // Carried pixels were sampled ~1 ULP of the coordinate
                    // away (see the module doc): nearly all match exactly.
                    assert!(
                        carried_diffs * 100 <= got.len(),
                        "{kind:?} {field:?} ({dx}, {dy}): {carried_diffs} carried pixels differ"
                    );
                }
            }
        }
    }
}
