//! End-to-end pipeline: viewport → smooth-iteration buffer → RGBA buffer.
//!
//! The split between [`compute`] and [`colorize`] is the contract
//! pinned by ADR-0002. `compute` is mathematics — it returns the
//! continuous escape-time count `nu` for every pixel. `colorize` is
//! presentation — it folds `nu` through a normalisation and a palette
//! into RGBA bytes. The two halves stay decoupled so a palette or
//! normalisation change can run without re-iterating; that fast-path
//! is wired up in the WASM crate (Slice 4B).
//!
//! Inside-set pixels carry [`f32::NAN`] through `compute` and are
//! always rendered as opaque black; `colorize` checks `nu.is_nan()`
//! explicitly (NaN compares unequal to itself, so `==` would silently
//! treat every NaN as an escape).

use crate::escape_time::escape_time;
use crate::palette::{NormalizationMode, Palette};
use crate::viewport::Viewport;

/// Run the smooth escape-time iteration for every pixel in `viewport`.
///
/// Returns a row-major buffer of length `viewport.width *
/// viewport.height` whose entry `[py * width + px]` is the smooth
/// continuous count for `viewport.pixel_to_complex(px, py)`. Inside-set
/// pixels are encoded as [`f32::NAN`].
pub fn compute(viewport: &Viewport, max_iter: u32) -> Vec<f32> {
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

/// Convert smooth-iteration counts to RGBA8 pixels.
///
/// Output buffer length is `4 * nus.len()`, in RGBA order. Alpha is
/// always 255 — the canvas is fully opaque. `nu.is_nan()` always maps
/// to opaque black regardless of palette or mode.
///
/// ## Modes
///
/// - [`NormalizationMode::Cycled`] divides each `nu` by
///   [`Palette::period`] and takes the Euclidean fractional part. The
///   bands repeat as `nu` advances, foregrounding the iteration-count
///   structure.
/// - [`NormalizationMode::Histogram`] equalises the finite-`nu`
///   distribution across `[0, 1]` via a two-pass CDF on the integer
///   floor of `nu`. The CDF lookup interpolates linearly between
///   `cdf[floor(nu)]` and `cdf[floor(nu) + 1]` by the fractional part,
///   keeping the smooth-iteration smoothness inside each integer
///   bucket. An all-NaN input short-circuits to all-black with no
///   panic.
pub fn colorize(nus: &[f32], palette: Palette, mode: NormalizationMode, max_iter: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(nus.len() * 4);
    match mode {
        NormalizationMode::Cycled => colorize_cycled(nus, palette, &mut out),
        NormalizationMode::Histogram => colorize_histogram(nus, palette, max_iter, &mut out),
    }
    out
}

fn colorize_cycled(nus: &[f32], palette: Palette, out: &mut Vec<u8>) {
    let period = palette.period();
    for &nu in nus {
        if nu.is_nan() {
            out.extend_from_slice(&[0, 0, 0, 255]);
            continue;
        }
        let t = (nu / period).rem_euclid(1.0);
        let [r, g, b] = palette.sample(t);
        out.extend_from_slice(&[r, g, b, 255]);
    }
}

fn colorize_histogram(nus: &[f32], palette: Palette, max_iter: u32, out: &mut Vec<u8>) {
    // Pass 1 — count escapers per integer bin. `nu` is bounded above
    // by `max_iter` (the loop exits earlier with NaN otherwise) and
    // bounded below by `i + 1 − log₂(log₂(BAILOUT_SQR)/2)`, which can
    // dip slightly negative for first-iteration escapers; clamp
    // negative and over-range `floor(nu)` so the index is always a
    // valid bin position.
    let bin_count = (max_iter as usize) + 1;
    let mut bins: Vec<u32> = vec![0; bin_count];
    for &nu in nus {
        if !nu.is_finite() {
            continue;
        }
        let k = nu.floor() as i64;
        if (0..bin_count as i64).contains(&k) {
            bins[k as usize] = bins[k as usize].saturating_add(1);
        }
    }

    let total: u64 = bins.iter().map(|&b| u64::from(b)).sum();
    if total == 0 {
        // All-NaN (or all-non-finite) input — every pixel is inside
        // the set, no escape statistics to equalise.
        for _ in nus {
            out.extend_from_slice(&[0, 0, 0, 255]);
        }
        return;
    }

    // Compute the CDF in place: bins[k] becomes Σ original_bins[0..=k].
    let mut cum: u32 = 0;
    for bin in &mut bins {
        cum = cum.saturating_add(*bin);
        *bin = cum;
    }
    let total_f = total as f32;

    // Pass 2 — palette lookup with linear interpolation between
    // adjacent CDF entries by the fractional part of `nu`.
    let last_idx = bin_count - 1;
    for &nu in nus {
        if nu.is_nan() {
            out.extend_from_slice(&[0, 0, 0, 255]);
            continue;
        }
        let k_signed = nu.floor() as i64;
        let k = k_signed.clamp(0, last_idx as i64) as usize;
        let frac = (nu - k as f32).clamp(0.0, 1.0);
        let cdf_k = bins[k] as f32 / total_f;
        let cdf_kp1 = if k + 1 < bin_count {
            bins[k + 1] as f32 / total_f
        } else {
            // cdf[max_iter + 1] is defined as 1.0 (the PRD sentinel).
            // bins[max_iter] already equals total → cdf[max_iter] = 1.0,
            // so this branch is only entered when `k == max_iter`.
            1.0
        };
        let t = cdf_k + (cdf_kp1 - cdf_k) * frac;
        let [r, g, b] = palette.sample(t);
        out.extend_from_slice(&[r, g, b, 255]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::complex::Complex64;

    const MAX_ITER: u32 = 256;

    const ALL_PALETTES: &[Palette] = &[
        Palette::Grayscale,
        Palette::Viridis,
        Palette::Magma,
        Palette::Inferno,
        Palette::Twilight,
    ];

    const ALL_MODES: &[NormalizationMode] =
        &[NormalizationMode::Cycled, NormalizationMode::Histogram];

    // --- compute() shape -----------------------------------------------

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
    fn compute_values_are_nan_or_below_max_iter() {
        let vp = seahorse_viewport();
        let buf = compute(&vp, MAX_ITER);
        for &nu in &buf {
            assert!(
                nu.is_nan() || nu <= (MAX_ITER as f32),
                "out-of-range nu: {nu}",
            );
        }
    }

    #[test]
    fn compute_center_pixel_of_origin_viewport_is_nan() {
        // A viewport centred on c = 0 (deep inside the main cardioid)
        // has its centre pixel return NaN — locking down the
        // "inside the set returns NaN" contract on a viewport where
        // that claim is mathematically true.
        let vp = Viewport::new(Complex64::new(0.0, 0.0), 1.0, 800, 600);
        let buf = compute(&vp, MAX_ITER);
        let center_idx = (vp.height / 2) as usize * (vp.width as usize) + (vp.width / 2) as usize;
        assert!(buf[center_idx].is_nan());
    }

    // --- colorize() shape ----------------------------------------------

    #[test]
    fn colorize_output_length_is_four_times_input_for_every_combo() {
        let nus = vec![f32::NAN, 0.0, 1.5, 10.25, 63.75, f32::NAN, 17.0];
        for &p in ALL_PALETTES {
            for &m in ALL_MODES {
                let out = colorize(&nus, p, m, MAX_ITER);
                assert_eq!(out.len(), nus.len() * 4, "{p:?}/{m:?}");
            }
        }
    }

    #[test]
    fn colorize_alpha_is_255_everywhere() {
        let nus = vec![f32::NAN, 0.0, 1.5, 10.25, 63.75, f32::NAN, 17.0];
        for &p in ALL_PALETTES {
            for &m in ALL_MODES {
                let out = colorize(&nus, p, m, MAX_ITER);
                for pixel in out.chunks_exact(4) {
                    assert_eq!(pixel[3], 255, "{p:?}/{m:?}");
                }
            }
        }
    }

    #[test]
    fn colorize_nan_maps_to_opaque_black_for_every_combo() {
        let nus = vec![f32::NAN];
        for &p in ALL_PALETTES {
            for &m in ALL_MODES {
                let out = colorize(&nus, p, m, MAX_ITER);
                assert_eq!(out, vec![0, 0, 0, 255], "{p:?}/{m:?}");
            }
        }
    }

    #[test]
    fn cycled_mode_wraps_by_palette_period() {
        // The Cycled-mode invariant: shifting `nu` by exactly one
        // period reproduces the same colour. This is what makes the
        // bands look continuous around the orbits. Pick `nu`s that
        // are exact multiples of `period * 2^-k` so that the `/`
        // and the wrap step are bit-exact on both sides of the
        // comparison — otherwise an epsilon-sized ratio drift can
        // round to an adjacent palette stop.
        for &p in ALL_PALETTES {
            let period = p.period();
            for &fraction in &[0.0_f32, 0.25, 0.5, 0.75] {
                let nu = period * fraction;
                let base = vec![nu];
                let shifted = vec![nu + period];
                let a = colorize(&base, p, NormalizationMode::Cycled, MAX_ITER);
                let b = colorize(&shifted, p, NormalizationMode::Cycled, MAX_ITER);
                assert_eq!(a, b, "{p:?} at fraction {fraction}");
            }
        }
    }

    #[test]
    fn colorize_is_pure_for_every_combo() {
        let nus = vec![f32::NAN, 0.0, 1.5, 10.25, 63.75, 17.0];
        for &p in ALL_PALETTES {
            for &m in ALL_MODES {
                let a = colorize(&nus, p, m, MAX_ITER);
                let b = colorize(&nus, p, m, MAX_ITER);
                assert_eq!(a, b, "{p:?}/{m:?}");
            }
        }
    }

    #[test]
    fn histogram_all_nan_input_is_all_black_no_panic() {
        let nus = vec![f32::NAN; 17];
        for &p in ALL_PALETTES {
            let out = colorize(&nus, p, NormalizationMode::Histogram, MAX_ITER);
            assert_eq!(out.len(), nus.len() * 4);
            for pixel in out.chunks_exact(4) {
                assert_eq!(pixel, &[0, 0, 0, 255], "{p:?}");
            }
        }
    }

    #[test]
    fn histogram_uniform_input_produces_approximately_uniform_output() {
        // Uniform input → uniform CDF → uniform output. Bin the
        // resulting red channel into 16 buckets; no bucket should hold
        // more than 2× the average count. Grayscale is the cleanest
        // palette to assert on because red == green == blue, so the
        // CDF maps directly to the red channel — we measure
        // distribution uniformity without palette-specific shape
        // confounding the assertion.
        let n = 4096_usize;
        let nus: Vec<f32> = (0..n)
            .map(|i| (i as f32) * (MAX_ITER as f32) / (n as f32))
            .collect();
        let out = colorize(
            &nus,
            Palette::Grayscale,
            NormalizationMode::Histogram,
            MAX_ITER,
        );
        let mut buckets = [0_u32; 16];
        for pixel in out.chunks_exact(4) {
            let bucket = (pixel[0] as usize) * 16 / 256;
            buckets[bucket] += 1;
        }
        let avg = n / 16;
        for (i, &count) in buckets.iter().enumerate() {
            assert!(
                (count as usize) <= 2 * avg,
                "bucket {i} overloaded: {count} > 2 × {avg}",
            );
        }
    }
}
