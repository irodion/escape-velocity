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

use rayon::prelude::*;

use crate::complex::Complex64;
use crate::escape_time::escape_time;
use crate::field::Field;
use crate::fractal_kind::FractalKind;
use crate::palette::{NormalizationMode, Palette};
use crate::viewport::Viewport;

/// Per-pixel `z_0` for Mandelbrot dispatch. Lifted out of the inner
/// loop so the constant doesn't get rebuilt at every pixel.
const ORIGIN: Complex64 = Complex64::new(0.0, 0.0);

/// Run `compute` for every pixel in `viewport`, dispatching first on the
/// [`Field`] (what scalar each pixel carries) and then on `kind` (which
/// fractal family).
///
/// Returns a row-major buffer of length `viewport.width *
/// viewport.height` whose entry `[py * width + px]` is the chosen Field's
/// scalar for that pixel; inside-set pixels are encoded as [`f32::NAN`]
/// regardless of Field (ADR-0013's shared sentinel).
///
/// - [`Field::EscapeTime`] emits the smooth continuous escape-time count
///   `nu` — the existing, unchanged hot path (see
///   [`compute_escape_time`]).
/// - [`Field::DistanceEstimate`] emits the distance estimate `d`. Its
///   kernel lands in Slice 2 (#61); until then this arm is unreachable —
///   the UI never offers Distance Estimate — so it is left a `todo!()`.
///
/// The Field match is hoisted out of the per-pixel work, exactly like the
/// `kind` match below it, so a frame carries one rule end-to-end.
pub fn compute(viewport: &Viewport, max_iter: u32, kind: FractalKind, field: Field) -> Vec<f32> {
    match field {
        Field::EscapeTime => compute_escape_time(viewport, max_iter, kind),
        // The Distance Estimate Field needs a separate `escape_distance`
        // kernel that tracks the orbit derivative `z'`; it cannot be
        // recovered from `nu`. That work is Slice 2 (#61). The axis is
        // wired end-to-end now (WASM enum, worker cache invalidation, UI
        // select) so the plumbing ships and is tested against Escape Time;
        // Distance Estimate stays unselectable in the UI until #61, which
        // is what makes this arm unreachable in production.
        Field::DistanceEstimate => todo!("Distance Estimate Field — Slice 2 (#61)"),
    }
}

/// The smooth escape-time computation: a row-major buffer whose entry
/// `[py * width + px]` is the smooth continuous count for the pixel under
/// `kind`'s `(z_0, c)` rule:
///
/// - [`FractalKind::Mandelbrot`]: `z_0 = 0`, `c = pixel` — the
///   classic Mandelbrot rendering.
/// - [`FractalKind::Julia { c }`]: `z_0 = pixel`, `c = <fixed>` —
///   the filled Julia set for the chosen `c` parameter.
///
/// Inside-set pixels are encoded as [`f32::NAN`]. The match on `kind`
/// is hoisted out of the per-pixel work so the branch predictor sees
/// the same target every pixel within one frame.
///
/// The per-pixel escape-time calls are independent, so the work fans
/// out across a `rayon` parallel iterator over pixel **rows**: each row
/// `py` contributes its `width` pixels in order via `flat_map_iter`, and
/// rayon preserves the produced order, so the buffer stays row-major
/// (`buf[py * width + px]`) and bit-identical to a serial walk —
/// parallelism is invisible in the output. Iterating rows keeps the
/// parallel bound a `u32` row count and never forms the `width * height`
/// product, which would overflow `usize` on a 32-bit target such as
/// wasm32. Natively this uses rayon's OS-thread pool; in the browser the
/// worker first stands up a `wasm-bindgen-rayon` thread pool (Slice 7C)
/// that backs the same `par_iter`.
fn compute_escape_time(viewport: &Viewport, max_iter: u32, kind: FractalKind) -> Vec<f32> {
    let width = viewport.width;
    let height = viewport.height;
    // Dispatch on `kind` once, outside the parallel map, so the hot
    // closure carries a single escape-time rule per frame — the same
    // branch-hoist the serial nested loops relied on.
    match kind {
        FractalKind::Mandelbrot => (0..height)
            .into_par_iter()
            .flat_map_iter(|py| {
                (0..width)
                    .map(move |px| escape_time(ORIGIN, viewport.pixel_to_complex(px, py), max_iter))
            })
            .collect(),
        FractalKind::Julia { c } => (0..height)
            .into_par_iter()
            .flat_map_iter(|py| {
                (0..width)
                    .map(move |px| escape_time(viewport.pixel_to_complex(px, py), c, max_iter))
            })
            .collect(),
    }
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
        NormalizationMode::Linear => colorize_global(nus, palette, |s| s, &mut out),
        NormalizationMode::SquareRoot => colorize_global(nus, palette, f32::sqrt, &mut out),
        NormalizationMode::Logarithmic => {
            // ln(1 + s·(e − 1)) maps [0, 1] → [0, 1] (s = 1 gives
            // ln(e) = 1) with no division, expanding the low end so
            // small-`nu` escapers spread across the palette.
            colorize_global(
                nus,
                palette,
                |s| (1.0 + s * (std::f32::consts::E - 1.0)).ln(),
                &mut out,
            )
        }
    }
    out
}

fn colorize_cycled(nus: &[f32], palette: Palette, out: &mut Vec<u8>) {
    let period = palette.period();
    for &nu in nus {
        // Treat any non-finite `nu` (NaN inside-set sentinel and the
        // theoretical ±Inf escapees alike) as opaque black so the
        // mode-dispatch behaviour is symmetric with Histogram pass 1.
        if !nu.is_finite() {
            out.extend_from_slice(&[0, 0, 0, 255]);
            continue;
        }
        let t = (nu / period).rem_euclid(1.0);
        let [r, g, b] = palette.sample(t);
        out.extend_from_slice(&[r, g, b, 255]);
    }
}

/// The "global" normalisation family: rescale each finite `nu` against
/// the frame's own `[min, max]` into `s ∈ [0, 1]`, apply `transfer`,
/// and sample the palette. `transfer` is the only thing that differs
/// between Linear (identity), SquareRoot (`√s`), and Logarithmic.
///
/// Like the other modes, non-finite `nu` (the NaN inside-set sentinel
/// and any ±Inf) paints opaque black. A frame with no finite escapers
/// at all is entirely black — there is no range to normalise against.
/// A degenerate `min == max` frame maps every pixel to `s = 0` (the
/// palette's start) rather than dividing by zero.
fn colorize_global(nus: &[f32], palette: Palette, transfer: fn(f32) -> f32, out: &mut Vec<u8>) {
    // Pass 1 — frame extent over finite values only.
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for &nu in nus {
        if nu.is_finite() {
            min = min.min(nu);
            max = max.max(nu);
        }
    }

    // `min` stays +∞ iff no finite value was seen — every pixel is
    // inside the set (or non-finite). Symmetric with histogram's
    // all-NaN short-circuit.
    if !min.is_finite() {
        for _ in nus {
            out.extend_from_slice(&[0, 0, 0, 255]);
        }
        return;
    }

    let range = max - min;
    // Pass 2 — rescale, curve, sample.
    for &nu in nus {
        if !nu.is_finite() {
            out.extend_from_slice(&[0, 0, 0, 255]);
            continue;
        }
        let s = if range > 0.0 { (nu - min) / range } else { 0.0 };
        let t = transfer(s).clamp(0.0, 1.0);
        let [r, g, b] = palette.sample(t);
        out.extend_from_slice(&[r, g, b, 255]);
    }
}

fn colorize_histogram(nus: &[f32], palette: Palette, max_iter: u32, out: &mut Vec<u8>) {
    // Pass 1 — count escapers per integer bin. `nu` is bounded above
    // by `max_iter` (the loop exits earlier with NaN otherwise) and
    // bounded below by `i + 1 − log₂(log₂(BAILOUT_SQR)/2)`, which can
    // dip negative for first-iteration escapers far from the set —
    // clamp `k` into `[0, max_iter]` so those escapers still appear
    // in the distribution. Without this, a viewport composed entirely
    // of negative-`nu` pixels would land `total = 0` and paint
    // all-black on pass 2 even though every pixel escaped; clamping
    // here keeps Pass 1 and Pass 2 (which clamps the same way for
    // the CDF lookup) in lockstep.
    let bin_count = (max_iter as usize) + 1;
    let last_idx = bin_count - 1;
    let mut bins: Vec<u32> = vec![0; bin_count];
    for &nu in nus {
        if !nu.is_finite() {
            continue;
        }
        let k_signed = nu.floor() as i64;
        let k = k_signed.clamp(0, last_idx as i64) as usize;
        bins[k] = bins[k].saturating_add(1);
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
    // adjacent CDF entries by the fractional part of `nu`. Reject
    // any non-finite value (NaN and ±Inf alike) symmetrically with
    // pass 1 — keeping the two passes consistent forecloses a
    // latent asymmetry where ±Inf would skip the bin count yet
    // still land at a clamped colour.
    for &nu in nus {
        if !nu.is_finite() {
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

    // Canonical Julia c shared by every Julia-mode test: the Douady
    // rabbit (`c = -0.123 + 0.745i`). Picked because `c` sits inside
    // the period-3 bulb of the Mandelbrot set, so the corresponding
    // filled Julia set is connected and `z_0 = 0` is inside it —
    // giving every test a clean "inside vs outside" witness.
    //
    // The Slice 5C UI defaults to a different `c` (which renders a
    // Cantor-dust Julia) — the two choices are independent.
    const JULIA_C: Complex64 = Complex64::new(-0.123, 0.745);

    const ALL_PALETTES: &[Palette] = &[
        Palette::Grayscale,
        Palette::Viridis,
        Palette::Magma,
        Palette::Inferno,
        Palette::Twilight,
        Palette::Plasma,
        Palette::Turbo,
        Palette::Cubehelix,
        Palette::EarthAndSky,
        Palette::Rainbow,
        Palette::Ocean,
        Palette::KaholLavan,
        // Cosine (procedural) palettes — exercise the non-stop path
        // through colorize end to end.
        Palette::Solar,
        Palette::Spectral,
        Palette::Cosmic,
    ];

    const ALL_MODES: &[NormalizationMode] = &[
        NormalizationMode::Cycled,
        NormalizationMode::Histogram,
        NormalizationMode::Linear,
        NormalizationMode::SquareRoot,
        NormalizationMode::Logarithmic,
    ];

    // The global-normalisation family, which shares one implementation
    // (`colorize_global`) parameterised by a transfer curve.
    const GLOBAL_MODES: &[NormalizationMode] = &[
        NormalizationMode::Linear,
        NormalizationMode::SquareRoot,
        NormalizationMode::Logarithmic,
    ];

    // --- compute() shape -----------------------------------------------

    fn seahorse_viewport() -> Viewport {
        Viewport::new(Complex64::new(-0.7435, 0.1314), 200.0, 800, 600)
    }

    fn origin_viewport() -> Viewport {
        Viewport::new(Complex64::new(0.0, 0.0), 1.0, 800, 600)
    }

    fn center_idx(vp: &Viewport) -> usize {
        (vp.height / 2) as usize * (vp.width as usize) + (vp.width / 2) as usize
    }

    #[test]
    fn compute_output_length_matches_viewport_pixels() {
        let vp = seahorse_viewport();
        let buf = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        assert_eq!(buf.len(), (vp.width as usize) * (vp.height as usize));
    }

    #[test]
    fn compute_values_are_nan_or_below_max_iter() {
        let vp = seahorse_viewport();
        let buf = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
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
        let vp = origin_viewport();
        let buf = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        assert!(buf[center_idx(&vp)].is_nan());
    }

    // --- Julia-mode dispatch ----------------------------------------------

    #[test]
    fn julia_compute_output_length_matches_mandelbrot() {
        // Both kinds visit every pixel once and push one f32 per pixel.
        let vp = origin_viewport();
        let m = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        let j = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::EscapeTime,
        );
        assert_eq!(m.len(), j.len());
        assert_eq!(j.len(), (vp.width as usize) * (vp.height as usize));
    }

    #[test]
    fn julia_compute_center_pixel_of_origin_viewport_is_nan() {
        // An origin-centred viewport has its centre pixel map to
        // `z_0 = 0`, which is inside the `c = (-0.7, 0.27015)` Julia
        // set — so the centre pixel must come back as NaN.
        let vp = origin_viewport();
        let buf = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::EscapeTime,
        );
        assert!(buf[center_idx(&vp)].is_nan());
    }

    #[test]
    fn julia_compute_has_at_least_one_finite_escaper() {
        // The four corners of an origin-centred zoom=1 viewport sit at
        // |z_0| ≈ 2, comfortably outside the filled Julia set for
        // c = (-0.7, 0.27015) — so the buffer must contain at least
        // one finite (non-NaN) entry. Without this, an "all inside the
        // set" bug in the Julia path could hide behind the NaN sentinel.
        let vp = origin_viewport();
        let buf = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::EscapeTime,
        );
        assert!(
            buf.iter().any(|nu| nu.is_finite()),
            "Julia buffer has no escapers — dispatch broken?",
        );
    }

    #[test]
    fn julia_and_mandelbrot_produce_different_buffers() {
        // Locks in that the two modes actually dispatch differently.
        // A regression that wired Julia mode back to the Mandelbrot
        // recurrence would still pass the length and NaN-centre checks
        // (the origin viewport's centre maps to z_0=0 either way) —
        // this assertion is the one that breaks.
        let vp = origin_viewport();
        let m = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        let j = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::EscapeTime,
        );
        assert_ne!(
            m, j,
            "Mandelbrot and Julia compute produced identical buffers"
        );
    }

    // --- compute() parallelism -----------------------------------------

    // A serial reference computation, structurally the pre-Slice-7A
    // nested-loop walk. The parallel `compute` must reproduce this
    // buffer exactly; keeping the reference inline pins the contract
    // independently of the production implementation.
    fn compute_serial(viewport: &Viewport, max_iter: u32, kind: FractalKind) -> Vec<f32> {
        let total = (viewport.width as usize) * (viewport.height as usize);
        let mut buf = Vec::with_capacity(total);
        match kind {
            FractalKind::Mandelbrot => {
                for py in 0..viewport.height {
                    for px in 0..viewport.width {
                        buf.push(escape_time(
                            ORIGIN,
                            viewport.pixel_to_complex(px, py),
                            max_iter,
                        ));
                    }
                }
            }
            FractalKind::Julia { c } => {
                for py in 0..viewport.height {
                    for px in 0..viewport.width {
                        buf.push(escape_time(viewport.pixel_to_complex(px, py), c, max_iter));
                    }
                }
            }
        }
        buf
    }

    // Compare two `nu` buffers by raw bits, so the `f32::NAN` inside-set
    // sentinels compare equal by representation (`NaN == NaN` is false,
    // which would make a plain `assert_eq!` on the buffers spuriously
    // fail wherever the set is hit).
    fn assert_buffers_bit_identical(a: &[f32], b: &[f32], ctx: &str) {
        assert_eq!(a.len(), b.len(), "length mismatch: {ctx}");
        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            assert_eq!(x.to_bits(), y.to_bits(), "pixel {i} differs: {ctx}");
        }
    }

    // A deliberately non-square viewport (width != height): an
    // accidental `px`/`py` transpose in the flat-index → pixel mapping
    // would still produce a buffer of the right length, so only a
    // non-square frame makes the bit-for-bit comparison catch it.
    // Centred in the seahorse valley so the buffer mixes inside-set
    // (NaN) and escaping pixels, exercising both arms of the bit check.
    // Small enough to keep the test snappy.
    fn mapping_viewport() -> Viewport {
        Viewport::new(Complex64::new(-0.7435, 0.1314), 200.0, 173, 97)
    }

    #[test]
    fn parallel_compute_matches_serial_reference_bit_for_bit() {
        // The load-bearing parallelism test: the parallel `compute`
        // output must equal the serial reference element-for-element for
        // both fractal families, guarding the flat-index mapping against
        // a transpose or off-by-one that would silently corrupt or
        // mirror the image.
        let vp = mapping_viewport();
        for kind in [FractalKind::Mandelbrot, FractalKind::Julia { c: JULIA_C }] {
            let parallel = compute(&vp, MAX_ITER, kind, Field::EscapeTime);
            let serial = compute_serial(&vp, MAX_ITER, kind);
            assert_buffers_bit_identical(&parallel, &serial, &format!("{kind:?}"));
        }
    }

    #[test]
    fn parallel_compute_is_deterministic_across_repeated_calls() {
        // Repeated calls must return identical buffers, so the
        // non-deterministic scheduling of the parallel iterator can
        // never leak into the output.
        let vp = mapping_viewport();
        for kind in [FractalKind::Mandelbrot, FractalKind::Julia { c: JULIA_C }] {
            let first = compute(&vp, MAX_ITER, kind, Field::EscapeTime);
            let second = compute(&vp, MAX_ITER, kind, Field::EscapeTime);
            assert_buffers_bit_identical(&first, &second, &format!("{kind:?}"));
        }
    }

    // --- Field axis (ADR-0013) -----------------------------------------

    #[test]
    fn escape_time_field_matches_the_pre_field_escape_time_path() {
        // The Field axis must not perturb the existing Escape Time render:
        // `compute(.., Field::EscapeTime)` has to reproduce the serial
        // escape-time reference bit-for-bit, for both families. This is the
        // load-bearing "nothing changes until you opt in" guarantee.
        let vp = mapping_viewport();
        for kind in [FractalKind::Mandelbrot, FractalKind::Julia { c: JULIA_C }] {
            let via_field = compute(&vp, MAX_ITER, kind, Field::EscapeTime);
            let reference = compute_serial(&vp, MAX_ITER, kind);
            assert_buffers_bit_identical(&via_field, &reference, &format!("{kind:?}"));
        }
    }

    #[test]
    fn default_field_is_escape_time() {
        // `Field::default()` is the historical behaviour, so an explicit
        // EscapeTime and the defaulted Field produce the same buffer.
        let vp = mapping_viewport();
        let explicit = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        let defaulted = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::default());
        assert_buffers_bit_identical(&explicit, &defaulted, "default == EscapeTime");
    }

    #[test]
    #[should_panic(expected = "Slice 2")]
    fn distance_estimate_field_is_not_yet_implemented() {
        // Slice 1 wires the Field axis but not the Distance Estimate maths
        // (#61). The arm is a `todo!()`; the UI never offers it, so this is
        // unreachable in production. Pin it as deliberately-stubbed so the
        // day #61 lands, removing the `todo!()` flips this test red and
        // forces it to be updated alongside the new kernel.
        let vp = origin_viewport();
        let _ = compute(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
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
    fn histogram_all_negative_finite_input_is_not_painted_as_inside_set() {
        // A viewport composed entirely of fast escapers can produce
        // only negative `nu` values under the smooth formula at
        // bailout 256 (`nu ≈ i - 2 - δ` for `i = 1`). The Histogram
        // mode must treat those as escapers — not collapse them to
        // bin 0's count being zero and short-circuiting to all-black,
        // which would mis-paint them as if they were inside the set.
        let nus = vec![-1.5_f32, -0.7, -2.0, -3.25];
        for &p in ALL_PALETTES {
            let out = colorize(&nus, p, NormalizationMode::Histogram, MAX_ITER);
            assert_eq!(out.len(), nus.len() * 4);
            // The escapers should land at `t = cdf[0]`, sampled at the
            // first stop. For Grayscale that's RGB (0, 0, 0), so the
            // "not painted as inside-set" check there would be
            // vacuous — but every other palette has a non-black first
            // stop, which proves the all-NaN short-circuit didn't
            // fire.
            if p == Palette::Grayscale {
                continue;
            }
            for pixel in out.chunks_exact(4) {
                assert_ne!(
                    pixel,
                    &[0, 0, 0, 255],
                    "{p:?}: negative-nu escapers painted as inside-set",
                );
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

    #[test]
    fn global_all_nan_input_is_all_black_no_panic() {
        // Symmetric with the histogram all-NaN case: a frame entirely
        // inside the set has no extent to normalise against, so every
        // pixel is opaque black rather than a divide-by-zero panic.
        let nus = vec![f32::NAN; 13];
        for &p in ALL_PALETTES {
            for &m in GLOBAL_MODES {
                let out = colorize(&nus, p, m, MAX_ITER);
                assert_eq!(out.len(), nus.len() * 4, "{p:?}/{m:?}");
                for pixel in out.chunks_exact(4) {
                    assert_eq!(pixel, &[0, 0, 0, 255], "{p:?}/{m:?}");
                }
            }
        }
    }

    #[test]
    fn global_modes_map_frame_extent_to_palette_endpoints() {
        // Every global transfer fixes 0 and 1, so the frame's min finite
        // `nu` lands at `t = 0` and its max at `t = 1`. On Grayscale that
        // is black → white, independent of the curve in between.
        let nus = vec![f32::NAN, 5.0, 20.0, 60.0, 100.0];
        for &m in GLOBAL_MODES {
            let out = colorize(&nus, Palette::Grayscale, m, MAX_ITER);
            // pixel 1 is the min (5.0); pixel 4 is the max (100.0).
            assert_eq!(&out[4..8], &[0, 0, 0, 255], "{m:?} min not at start");
            assert_eq!(&out[16..20], &[255, 255, 255, 255], "{m:?} max not at end");
        }
    }

    #[test]
    fn global_curved_modes_expand_low_end_vs_linear() {
        // The reason the curved pair exists: √ and log pull mid-low
        // values toward the bright end, so a mid-range escaper is at
        // least as bright under them as under linear. Grayscale makes
        // brightness == the red channel, and `nu = 25` of `[0, 100]`
        // sits in the expanded region.
        let nus = vec![0.0_f32, 25.0, 100.0];
        let red = |m| colorize(&nus, Palette::Grayscale, m, MAX_ITER)[4];
        let lin = red(NormalizationMode::Linear);
        let sqrt = red(NormalizationMode::SquareRoot);
        let log = red(NormalizationMode::Logarithmic);
        assert!(sqrt >= lin, "sqrt {sqrt} < linear {lin}");
        assert!(log >= lin, "log {log} < linear {lin}");
    }

    #[test]
    fn global_degenerate_uniform_input_does_not_panic() {
        // min == max → zero range. Must map every pixel to the palette
        // start (s = 0) instead of dividing by zero.
        let nus = vec![42.0_f32; 8];
        for &p in ALL_PALETTES {
            for &m in GLOBAL_MODES {
                let out = colorize(&nus, p, m, MAX_ITER);
                assert_eq!(out.len(), nus.len() * 4, "{p:?}/{m:?}");
                let first = &out[0..4];
                for pixel in out.chunks_exact(4) {
                    assert_eq!(pixel, first, "{p:?}/{m:?} not uniform");
                }
            }
        }
    }
}
