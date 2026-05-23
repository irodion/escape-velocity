//! End-to-end pipeline: viewport → iteration buffer → RGBA buffer.
//!
//! The split between `compute` and `colorize` is the contract pinned
//! by ADR-0002. `compute` is mathematics; `colorize` is presentation.
//! Slice 4 replaces the body of `colorize` with smooth coloring and
//! palettes — the *signature* of `colorize` is the load-bearing
//! interface, not the greyscale rule it currently encodes.

use crate::escape_time::escape_time;
use crate::viewport::Viewport;

/// Run the escape-time iteration for every pixel in `viewport`.
///
/// Returns a row-major buffer of length `viewport.width *
/// viewport.height` whose entry `[py * width + px]` is
/// `escape_time(viewport.pixel_to_complex(px, py), max_iter)`.
pub fn compute(viewport: &Viewport, max_iter: u32) -> Vec<u32> {
    let total = (viewport.width as usize) * (viewport.height as usize);
    let mut buf = Vec::with_capacity(total);
    for py in 0..viewport.height {
        for px in 0..viewport.width {
            let c = viewport.pixel_to_complex(px, py);
            buf.push(escape_time(c, max_iter));
        }
    }
    buf
}

/// Convert iteration counts to RGBA8 pixels using a hardcoded greyscale rule.
///
/// **Convention** (Slice 1 only; Slice 4 replaces this with palettes):
///
/// - `iter == max_iter` (point did not escape — "inside" the set) → `(0, 0, 0, 255)` (black).
/// - Otherwise `grey = (iter * 255 / max_iter) as u8`; output `(grey, grey, grey, 255)`.
///
/// Note that `iter == 0` *also* maps to black (`grey = 0`). Both
/// endpoints of the iteration range are dark, with the brightest
/// pixels coming from orbits that escaped near the end of the
/// iteration budget. This is the canonical "void" look: the set
/// itself is black and the surrounding rings darken back toward black
/// as orbits escape faster.
///
/// Output buffer length is `4 * iters.len()`, in RGBA order. Alpha is
/// always 255 — the canvas is fully opaque.
pub fn colorize(iters: &[u32], max_iter: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(iters.len() * 4);
    for &iter in iters {
        let grey: u8 = if iter >= max_iter {
            0
        } else {
            // u64 intermediate: `iter * 255` could overflow u32 for
            // pathologically large `max_iter`, but never u64.
            (u64::from(iter) * 255 / u64::from(max_iter)) as u8
        };
        out.push(grey);
        out.push(grey);
        out.push(grey);
        out.push(255);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::complex::Complex64;

    const MAX_ITER: u32 = 256;

    // --- colorize -----------------------------------------------------

    #[test]
    fn colorize_max_iter_is_black() {
        let out = colorize(&[MAX_ITER], MAX_ITER);
        assert_eq!(out, vec![0, 0, 0, 255]);
    }

    #[test]
    fn colorize_zero_is_also_black() {
        // Both endpoints collapse to black under the greyscale rule;
        // documented in the colorize doc-comment.
        let out = colorize(&[0], MAX_ITER);
        assert_eq!(out, vec![0, 0, 0, 255]);
    }

    #[test]
    fn colorize_is_monotone_on_open_interval() {
        let iters: Vec<u32> = (1..MAX_ITER).collect();
        let rgba = colorize(&iters, MAX_ITER);
        let greys: Vec<u8> = rgba.chunks_exact(4).map(|p| p[0]).collect();
        for w in greys.windows(2) {
            assert!(
                w[0] <= w[1],
                "greyscale not monotone non-decreasing: {} > {}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn colorize_buffer_length_is_four_times_iters() {
        let iters = vec![0_u32, 1, 2, 3, 4, 100, 200, MAX_ITER];
        let out = colorize(&iters, MAX_ITER);
        assert_eq!(out.len(), iters.len() * 4);
    }

    #[test]
    fn colorize_all_pixels_have_alpha_255() {
        let iters: Vec<u32> = (0..=MAX_ITER).collect();
        let rgba = colorize(&iters, MAX_ITER);
        for pixel in rgba.chunks_exact(4) {
            assert_eq!(pixel[3], 255);
        }
    }

    #[test]
    fn colorize_rgb_channels_are_equal_per_pixel() {
        let iters = vec![0_u32, 17, 99, 128, MAX_ITER];
        let rgba = colorize(&iters, MAX_ITER);
        for pixel in rgba.chunks_exact(4) {
            assert_eq!(pixel[0], pixel[1]);
            assert_eq!(pixel[1], pixel[2]);
        }
    }

    // --- end-to-end compute() shape -----------------------------------

    fn seahorse_viewport() -> Viewport {
        Viewport::new(Complex64::new(-0.7435, 0.1314), 200.0, 800, 600)
    }

    #[test]
    fn compute_output_length_matches_viewport_pixels() {
        let vp = seahorse_viewport();
        let buf = compute(&vp, MAX_ITER);
        assert_eq!(buf.len(), (vp.width as usize) * (vp.height as usize));
    }

    #[test]
    fn compute_values_are_in_zero_to_max_iter_inclusive() {
        let vp = seahorse_viewport();
        let buf = compute(&vp, MAX_ITER);
        for &iter in &buf {
            assert!(iter <= MAX_ITER);
        }
    }

    #[test]
    fn compute_center_pixel_matches_direct_escape_time_call() {
        // Plumbing check: compute's center cell must equal an
        // independent `escape_time` call at the same complex point.
        // This verifies sampling + buffer indexing without depending on
        // whether that specific point is in the Mandelbrot set.
        //
        // (PRD #2 claimed the Seahorse Valley centre at
        // `(-0.7435, 0.1314)` is inside the set; empirically it sits
        // ~0.6% outside the main cardioid and escapes in 62 iterations.
        // The viewport is still the right hardcoded Slice 1 render
        // target — Seahorse Valley *is* mostly escape-land, which is
        // why seahorses are visible at all.)
        use crate::escape_time::escape_time;

        let vp = seahorse_viewport();
        let buf = compute(&vp, MAX_ITER);
        let cx = vp.width / 2;
        let cy = vp.height / 2;
        let center_idx = (cy as usize) * (vp.width as usize) + (cx as usize);
        let expected = escape_time(vp.pixel_to_complex(cx, cy), MAX_ITER);
        assert_eq!(buf[center_idx], expected);
    }

    #[test]
    fn compute_center_pixel_of_origin_viewport_is_inside_the_set() {
        // A viewport centred on c = 0 (deep inside the main cardioid)
        // *does* have its centre pixel return max_iter — locking down
        // the "inside the set returns max_iter" contract on a viewport
        // where that claim is mathematically true.
        let vp = Viewport::new(Complex64::new(0.0, 0.0), 1.0, 800, 600);
        let buf = compute(&vp, MAX_ITER);
        let center_idx = (vp.height / 2) as usize * (vp.width as usize) + (vp.width / 2) as usize;
        assert_eq!(buf[center_idx], MAX_ITER);
    }
}
