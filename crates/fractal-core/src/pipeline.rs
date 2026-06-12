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
use crate::escape_distance::escape_distance;
use crate::escape_time::escape_time;
use crate::field::Field;
use crate::fractal_kind::FractalKind;
use crate::palette::{NormalizationMode, Palette};
use crate::viewport::Viewport;

/// Per-pixel `z_0` for Mandelbrot dispatch. Lifted out of the inner
/// loop so the constant doesn't get rebuilt at every pixel.
const ORIGIN: Complex64 = Complex64::new(0.0, 0.0);

/// `1 + 0i` — the Distance Estimate derivative seed (`dc` for Mandelbrot,
/// `dz_0` for Julia). Hoisted for the same reason as [`ORIGIN`].
const ONE: Complex64 = Complex64::new(1.0, 0.0);

/// Width, in **pixels**, of the `Clamped` distance ramp (ADR-0013): a
/// pixel whose buffer distance is `≥ k` paints the palette's far end, and
/// the gradient is spread linearly over the `[0, k)` shell next to the
/// boundary. Because the compute pipeline stores pixel-unit distance,
/// this constant is resolution-independent — a filament is `~k` pixels
/// wide at any zoom or buffer size.
///
/// `1.5` was chosen by eye (#63): tuned live against the Turbo palette in
/// the seahorse valley, comparing 1–16. Above ~3 the lit band reads as a
/// soft, thick rim rather than a hairline (and with a dark-starting
/// palette it just darkens the boundary); ~1.0 is the practical floor —
/// below it the one-pixel ramp loses its anti-aliasing and the finest
/// filaments break up. 1.5 sits right at the sharp end while keeping a
/// sliver of smoothing in reserve for deep zooms and the 0.5× render
/// scale. The hard `min(1, d/k)` clamp was kept (ADR-0013) — it looked
/// crisp, so the `tanh` fallback was not needed.
const CLAMPED_DISTANCE_K: f32 = 1.5;

/// Closed-form interior test for the two largest components of the
/// Mandelbrot set: the main cardioid and the period-2 bulb. Together they
/// cover the large majority of the set's interior *area*, and membership
/// in either is an O(1) algebraic test — no iteration.
///
/// Returns `true` only for points provably inside the set, whose orbit is
/// bounded forever. For such a point [`escape_time`] / [`escape_distance`]
/// would run the full `max_iter` loop and return the [`f32::NAN`]
/// inside-set sentinel; short-circuiting straight to `f32::NAN` is
/// therefore **output-identical** (the same sentinel, the same bit
/// pattern) while skipping up to `max_iter` iterations per interior pixel.
/// That is the whole win: a slider `max_iter` of 8192 over millions of
/// interior pixels otherwise burns the full loop on pixels whose answer is
/// analytically known.
///
/// Membership is exact, so there are **no false positives**: any point
/// this returns `false` for still runs the full kernel, so no exterior or
/// boundary pixel is ever misclassified — the inside/outside partition is
/// untouched. Mandelbrot-only: the family is known at the dispatch seam
/// (the kernels stay family-agnostic, ADR-0013), and the cardioid/bulb
/// geometry does not transfer to Julia.
fn in_main_cardioid_or_bulb(c: Complex64) -> bool {
    // Main cardioid: with `q = (re − ¼)² + im²`, the point lies inside iff
    // `q·(q + (re − ¼)) ≤ ¼·im²`. (The cusp `c = 0.25` satisfies it with
    // equality, so the boundary — part of the set — is included.)
    let x = c.re - 0.25;
    let q = x * x + c.im * c.im;
    if q * (q + x) <= 0.25 * c.im * c.im {
        return true;
    }
    // Period-2 bulb: the disc of radius ¼ centred at −1, i.e.
    // `(re + 1)² + im² ≤ 1/16`.
    let x1 = c.re + 1.0;
    x1 * x1 + c.im * c.im <= 0.0625
}

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
/// - [`Field::DistanceEstimate`] emits the boundary distance estimate
///   `d`, in **pixel units** (see [`compute_distance_estimate`]).
///
/// The Field match is hoisted out of the per-pixel work, exactly like the
/// `kind` match below it, so a frame carries one rule end-to-end.
pub fn compute(viewport: &Viewport, max_iter: u32, kind: FractalKind, field: Field) -> Vec<f32> {
    compute_rows(viewport, max_iter, kind, field, 0, viewport.height)
}

/// Compute the chosen Field for the pixel **rows** `[y0, y1)` of
/// `viewport`, returning a row-major buffer of length `(y1 - y0) *
/// viewport.width` whose entry `[(py - y0) * width + px]` is the scalar for
/// absolute pixel `(px, py)`.
///
/// This is [`compute`] restricted to a horizontal band. Every row is keyed
/// to its **absolute** `py` (via [`Viewport::pixel_to_complex`]), so the
/// band carries exactly the pixels `compute` would put at those rows —
/// concatenating the buffers of any contiguous partition of `[0, height)`
/// reproduces the full `compute` buffer bit-for-bit. That invariant is what
/// lets the render worker compute a frame in cancellable bands (P2, #78):
/// it yields between bands and abandons the rest when a newer viewport
/// supersedes the in-flight one, instead of running a doomed full `compute`
/// to completion before the latest request can even start.
///
/// `y0 <= y1 <= viewport.height` is the caller's contract; the WASM binding
/// (`compute_band`) validates it at the boundary. An empty band
/// (`y0 == y1`) yields an empty buffer.
pub fn compute_rows(
    viewport: &Viewport,
    max_iter: u32,
    kind: FractalKind,
    field: Field,
    y0: u32,
    y1: u32,
) -> Vec<f32> {
    let mut out = vec![0.0f32; ((y1 - y0) as usize) * (viewport.width as usize)];
    compute_rows_into(viewport, max_iter, kind, field, y0, y1, &mut out);
    out
}

/// Fill the chosen Field for rows `[y0, y1)` of `viewport` **into `out`**, the
/// allocation-free core of [`compute_rows`]. `out` must be exactly `(y1 - y0) *
/// viewport.width` elements; pixel `(px, py)` for `py ∈ [y0, y1)` is written at
/// the band-relative index `(py - y0) * width + px`, so the band is byte-
/// identical to the matching slice of a full-frame compute.
///
/// Filling in place is what lets the WASM layer write each render band straight
/// into the persistent iteration buffer (P4, #80): no per-band `Vec` is
/// allocated and no concatenating copy runs — unlike returning a fresh buffer
/// the caller must then splice in.
pub fn compute_rows_into(
    viewport: &Viewport,
    max_iter: u32,
    kind: FractalKind,
    field: Field,
    y0: u32,
    y1: u32,
    out: &mut [f32],
) {
    debug_assert_eq!(
        out.len(),
        ((y1 - y0) as usize) * (viewport.width as usize),
        "compute_rows_into: out length must equal (y1 - y0) * width",
    );
    match field {
        Field::EscapeTime => fill_escape_time(viewport, max_iter, kind, y0, out),
        Field::DistanceEstimate => fill_distance_estimate(viewport, max_iter, kind, y0, out),
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
/// The per-pixel escape-time calls are independent, so the work fans out
/// across a `rayon` parallel iterator over pixel **rows** — `out` is split
/// into `width`-sized row chunks by [`par_chunks_mut`], and each chunk is
/// filled in place. `par_chunks_mut` is an *indexed* parallel iterator, so
/// rayon writes straight into `out` with no per-split intermediate buffers and
/// no concatenating copy (the cost the old `flat_map_iter → collect` paid every
/// frame, P4 #80). Order is preserved: band-relative chunk `i` is absolute row
/// `py = y0 + i`, so `out[(py - y0) * width + px]` stays row-major and
/// bit-identical to a serial walk — parallelism is invisible in the output.
/// Natively this uses rayon's OS-thread pool; in the browser the worker first
/// stands up a `wasm-bindgen-rayon` thread pool (Slice 7C) that backs the same
/// `par_iter`.
fn fill_escape_time(
    viewport: &Viewport,
    max_iter: u32,
    kind: FractalKind,
    y0: u32,
    out: &mut [f32],
) {
    let width = viewport.width as usize;
    // Dispatch on `kind` once, outside the parallel map, so the hot
    // closure carries a single escape-time rule per frame — the same
    // branch-hoist the serial nested loops relied on.
    match kind {
        FractalKind::Mandelbrot => out.par_chunks_mut(width).enumerate().for_each(|(i, row)| {
            let py = y0 + i as u32;
            for (px, slot) in row.iter_mut().enumerate() {
                let c = viewport.pixel_to_complex(px as u32, py);
                // O(1) interior cull: the cardioid/bulb pixels are the bulk of
                // the set's area and resolve to the same NaN sentinel the full
                // loop would return (see `in_main_cardioid_or_bulb`).
                *slot = if in_main_cardioid_or_bulb(c) {
                    f32::NAN
                } else {
                    escape_time(ORIGIN, c, max_iter)
                };
            }
        }),
        FractalKind::Julia { c } => out.par_chunks_mut(width).enumerate().for_each(|(i, row)| {
            let py = y0 + i as u32;
            for (px, slot) in row.iter_mut().enumerate() {
                *slot = escape_time(viewport.pixel_to_complex(px as u32, py), c, max_iter);
            }
        }),
    }
}

/// The Distance Estimate computation: a row-major buffer whose entry
/// `[py * width + px]` is the pixel's distance to the set boundary in
/// **pixel units** (`f32::NAN` for inside-set pixels — the shared
/// sentinel).
///
/// The [`escape_distance`] kernel returns the estimate in complex-plane
/// units; this pipeline divides by the Viewport's per-pixel scale (which
/// is keyed to the reference width, ADR-0011) so the buffer carries
/// pixel-distance. That is what keeps the boundary filaments a fixed
/// width in pixels — and the `Clamped` constant `k` resolution-
/// independent — as the user zooms: in plane terms the filaments grow
/// under magnification, but in pixel terms they hold steady, and
/// `colorize` never needs to know the Viewport (ADR-0013 keeps it
/// Field-blind). Dividing a `NaN` plane-distance leaves `NaN`, so the
/// inside-set sentinel survives the conversion untouched.
///
/// Family dispatch mirrors [`compute_escape_time`] and passes the
/// per-family derivative seeds (ADR-0013): Mandelbrot differentiates
/// w.r.t. `c` (`dz_0 = 0`, `dc = 1`), Julia w.r.t. `z_0` (`dz_0 = 1`,
/// `dc = 0`). The kernel itself stays family-agnostic. Slice 2 (#61)
/// ships the Mandelbrot path as the headline; the Julia arm rides the
/// same family-agnostic kernel so selecting Distance Estimate in Julia
/// mode renders correctly rather than panicking — Slice 3 (#62) adds its
/// dedicated witness tests and acceptance.
fn fill_distance_estimate(
    viewport: &Viewport,
    max_iter: u32,
    kind: FractalKind,
    y0: u32,
    out: &mut [f32],
) {
    let width = viewport.width as usize;
    // Plane → pixel units. Hoisted out of the per-pixel closure; the
    // scale depends only on `zoom` (ADR-0011), constant across the frame.
    let scale = viewport.pixel_scale();
    // Same in-place, row-chunked fan-out as `fill_escape_time` (P4 #80).
    match kind {
        FractalKind::Mandelbrot => out.par_chunks_mut(width).enumerate().for_each(|(i, row)| {
            let py = y0 + i as u32;
            for (px, slot) in row.iter_mut().enumerate() {
                let c = viewport.pixel_to_complex(px as u32, py);
                // Same interior cull as the Escape Time path: an inside point's
                // distance is the NaN sentinel, which the `f64::from(NaN) /
                // scale` cast below would produce anyway — short-circuit it
                // (ADR-0013 shares the sentinel, so the Field partition stays in
                // lockstep).
                *slot = if in_main_cardioid_or_bulb(c) {
                    f32::NAN
                } else {
                    let d = escape_distance(ORIGIN, c, ORIGIN, ONE, max_iter);
                    (f64::from(d) / scale) as f32
                };
            }
        }),
        FractalKind::Julia { c } => out.par_chunks_mut(width).enumerate().for_each(|(i, row)| {
            let py = y0 + i as u32;
            for (px, slot) in row.iter_mut().enumerate() {
                let z0 = viewport.pixel_to_complex(px as u32, py);
                let d = escape_distance(z0, c, ONE, ORIGIN, max_iter);
                *slot = (f64::from(d) / scale) as f32;
            }
        }),
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
    let mut out = Vec::new();
    colorize_into(nus, palette, mode, max_iter, &mut out);
    out
}

/// Colorize **into `out`**, reusing its existing capacity — the allocation-free
/// core of [`colorize`]. `out` is cleared (keeping its backing allocation) and
/// reserved to the exact RGBA size, so the per-pixel `extend_from_slice` in each
/// mode never reallocates. The WASM layer hands in a persistent thread-local
/// buffer so a frame's colorize doesn't allocate a fresh `4·N`-byte `Vec` each
/// time (P4, #80).
pub fn colorize_into(
    nus: &[f32],
    palette: Palette,
    mode: NormalizationMode,
    max_iter: u32,
    out: &mut Vec<u8>,
) {
    out.clear();
    out.reserve(nus.len() * 4);
    match mode {
        NormalizationMode::Cycled => colorize_cycled(nus, palette, out),
        NormalizationMode::Histogram => colorize_histogram(nus, palette, max_iter, out),
        NormalizationMode::Linear => colorize_global(nus, palette, |s| s, out),
        NormalizationMode::SquareRoot => colorize_global(nus, palette, f32::sqrt, out),
        NormalizationMode::Logarithmic => {
            // ln(1 + s·(e − 1)) maps [0, 1] → [0, 1] (s = 1 gives
            // ln(e) = 1) with no division, expanding the low end so
            // small-`nu` escapers spread across the palette.
            colorize_global(
                nus,
                palette,
                |s| (1.0 + s * (std::f32::consts::E - 1.0)).ln(),
                out,
            )
        }
        NormalizationMode::Clamped => colorize_clamped(nus, palette, out),
    }
}

/// The `Clamped` distance ramp (ADR-0013) — the Distance Estimate Field's
/// default normalisation. Each finite scalar `d` (a pixel-unit distance,
/// though `colorize` stays Field-blind and never assumes so) maps through
/// `t = min(1, d / k)`: a hard linear ramp over the first
/// [`CLAMPED_DISTANCE_K`] units, flat at the palette's far end beyond. The
/// gradient stays inside the thin boundary shell, so the boundary renders
/// as hairline filaments rather than a soft halo.
///
/// Unlike the global family, this does **not** rescale against the
/// frame's `[min, max]`: the clamp is absolute, against the fixed `k`.
/// That is exactly what makes it resolution-independent — `k` is in the
/// same pixel units the compute pipeline puts in the buffer, so a filament
/// stays `k` pixels wide at any zoom or buffer size.
///
/// Non-finite scalars (the NaN inside-set sentinel and any ±Inf) paint
/// opaque black, symmetric with every other mode. Negative scalars (not
/// expected from a distance, but cheap to guard) clamp to the palette
/// start.
fn colorize_clamped(nus: &[f32], palette: Palette, out: &mut Vec<u8>) {
    for &d in nus {
        if !d.is_finite() {
            out.extend_from_slice(&[0, 0, 0, 255]);
            continue;
        }
        let t = (d / CLAMPED_DISTANCE_K).clamp(0.0, 1.0);
        let [r, g, b] = palette.sample(t);
        out.extend_from_slice(&[r, g, b, 255]);
    }
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
        NormalizationMode::Clamped,
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

    // --- Cardioid / bulb interior cull (P1, #77) -----------------------

    #[test]
    fn cardioid_bulb_test_accepts_known_interior_points() {
        // Points provably inside the set whose component the cull covers:
        // the cardioid centre region (c = 0 and c = −0.5), the cardioid
        // cusp on its boundary (c = 0.25, included by the `≤`), and the
        // period-2 bulb (its centre c = −1, and the bulb-boundary point
        // c = −0.75 where it meets the cardioid).
        for c in [
            Complex64::new(0.0, 0.0),
            Complex64::new(-0.5, 0.0),
            Complex64::new(0.25, 0.0),
            Complex64::new(-1.0, 0.0),
            Complex64::new(-0.75, 0.0),
            Complex64::new(0.0, 0.3),
        ] {
            assert!(
                in_main_cardioid_or_bulb(c),
                "{c:?} should be culled as interior",
            );
        }
    }

    #[test]
    fn cardioid_bulb_test_rejects_exterior_and_uncovered_points() {
        // Exterior points must NOT be culled (they'd be mis-painted as
        // inside the set). Also reject interior points the cull does *not*
        // cover — a period-3 bulb centre (c ≈ −0.1226 + 0.7449i) and the
        // c = −0.123 + 0.745i rabbit param: these are inside the set but
        // outside the cardioid/bulb, so the test must return false and let
        // the full kernel run (a false positive here would be a bug).
        for c in [
            Complex64::new(2.0, 0.0),      // far exterior
            Complex64::new(0.35, 0.0),     // just right of the cusp, exterior
            Complex64::new(-2.0, 0.0),     // far exterior
            Complex64::new(0.30, 0.5),     // exterior
            Complex64::new(-0.123, 0.745), // period-3 bulb interior, NOT covered
        ] {
            assert!(!in_main_cardioid_or_bulb(c), "{c:?} should not be culled",);
        }
    }

    // An unoptimised serial Distance Estimate reference, mirroring
    // `compute_serial` for the Escape Time Field: it never calls the
    // cardioid/bulb cull, so comparing the production buffer against it
    // proves the cull changes no output (not even the NaN bit pattern).
    fn compute_distance_estimate_serial(viewport: &Viewport, max_iter: u32) -> Vec<f32> {
        let scale = viewport.pixel_scale();
        let total = (viewport.width as usize) * (viewport.height as usize);
        let mut buf = Vec::with_capacity(total);
        for py in 0..viewport.height {
            for px in 0..viewport.width {
                let c = viewport.pixel_to_complex(px, py);
                let d = escape_distance(ORIGIN, c, ORIGIN, ONE, max_iter);
                buf.push((f64::from(d) / scale) as f32);
            }
        }
        buf
    }

    #[test]
    fn cardioid_cull_is_output_identical_to_unoptimised_reference() {
        // The load-bearing equivalence test for the cull: on an
        // origin-centred viewport that straddles the whole set — so the
        // main cardioid and period-2 bulb fill most of the frame and the
        // cull fires on the bulk of pixels — the optimised production
        // `compute` must reproduce the unoptimised serial reference
        // bit-for-bit, for BOTH Fields. The cull's NaN sentinel and the
        // full loop's NaN sentinel share a bit pattern, so any drift here
        // would mean a real misclassification, not a benign NaN difference.
        let vp = origin_viewport();

        let et_opt = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        let et_ref = compute_serial(&vp, MAX_ITER, FractalKind::Mandelbrot);
        assert_buffers_bit_identical(&et_opt, &et_ref, "EscapeTime cull vs serial");

        let de_opt = compute(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
        let de_ref = compute_distance_estimate_serial(&vp, MAX_ITER);
        assert_buffers_bit_identical(&de_opt, &de_ref, "DistanceEstimate cull vs serial");
    }

    // --- Band-range compute (P2, #78) ----------------------------------

    // Split [0, height) into a deliberately uneven set of contiguous bands
    // (so an off-by-one in a band boundary, or a row keyed to a band-relative
    // rather than absolute py, would surface), compute each via `compute_rows`,
    // and concatenate. Centred in the seahorse valley via `mapping_viewport`
    // (non-square, mixes inside/outside) and additionally exercised on the
    // origin viewport (which fires the cardioid cull) below.
    fn assert_banded_matches_full(vp: &Viewport, kind: FractalKind, field: Field, ctx: &str) {
        let full = compute(vp, MAX_ITER, kind, field);
        // Uneven band edges across the full height, always ending at height.
        let h = vp.height;
        let mut edges = vec![0u32];
        for e in [1, 2, 3, 5, 8, 13, 21] {
            if e < h {
                edges.push(e);
            }
        }
        edges.push(h);
        edges.dedup();

        let mut banded: Vec<f32> = Vec::with_capacity(full.len());
        for w in edges.windows(2) {
            let (y0, y1) = (w[0], w[1]);
            let band = compute_rows(vp, MAX_ITER, kind, field, y0, y1);
            assert_eq!(
                band.len(),
                ((y1 - y0) as usize) * (vp.width as usize),
                "band [{y0},{y1}) wrong length: {ctx}",
            );
            banded.extend_from_slice(&band);
        }
        assert_buffers_bit_identical(&banded, &full, ctx);
    }

    #[test]
    fn banded_compute_concatenates_to_full_compute_bit_for_bit() {
        // The load-bearing banding invariant: a contiguous partition of the
        // rows, computed band-by-band, reproduces the single-shot `compute`
        // exactly — for both Fields and both families. This is what lets the
        // worker render in cancellable chunks without changing a single
        // output pixel.
        for vp in [mapping_viewport(), origin_viewport()] {
            for kind in [FractalKind::Mandelbrot, FractalKind::Julia { c: JULIA_C }] {
                for field in [Field::EscapeTime, Field::DistanceEstimate] {
                    assert_banded_matches_full(&vp, kind, field, &format!("{kind:?}/{field:?}"));
                }
            }
        }
    }

    #[test]
    fn compute_rows_empty_band_is_empty() {
        // A zero-height band (y0 == y1) produces no pixels — the worker's
        // band planner never emits one, but the contract is total.
        let vp = mapping_viewport();
        let band = compute_rows(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::EscapeTime,
            4,
            4,
        );
        assert!(band.is_empty());
    }

    #[test]
    fn compute_rows_full_range_equals_compute() {
        // `compute` is defined as `compute_rows(.., 0, height)`; pin that the
        // delegation is exact (not merely close) for a non-square frame.
        let vp = mapping_viewport();
        let full = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        let rows = compute_rows(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::EscapeTime,
            0,
            vp.height,
        );
        assert_buffers_bit_identical(&rows, &full, "full-range compute_rows == compute");
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
    fn distance_estimate_is_finite_outside_and_nan_inside() {
        // The Distance Estimate Field must keep the same inside/outside
        // partition as Escape Time: NaN inside the set, finite outside.
        // An origin-centred viewport straddles the main cardioid, so the
        // buffer must contain both.
        let vp = origin_viewport();
        let buf = compute(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
        assert_eq!(buf.len(), (vp.width as usize) * (vp.height as usize));
        assert!(buf[center_idx(&vp)].is_nan(), "set interior must be NaN");
        assert!(
            buf.iter().any(|d| d.is_finite()),
            "no finite distances — exterior not rendered?",
        );
        // Every finite distance is non-negative (it is a distance).
        for &d in &buf {
            assert!(d.is_nan() || d >= 0.0, "negative distance: {d}");
        }
    }

    #[test]
    fn distance_estimate_inside_outside_partition_matches_escape_time() {
        // Switching Field must never reclassify a pixel as interior vs.
        // exterior: both kernels share the bailout, so a pixel is NaN under
        // Distance Estimate iff it is NaN under Escape Time.
        let vp = mapping_viewport();
        let et = compute(&vp, MAX_ITER, FractalKind::Mandelbrot, Field::EscapeTime);
        let de = compute(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
        assert_eq!(et.len(), de.len());
        for (i, (e, d)) in et.iter().zip(de.iter()).enumerate() {
            assert_eq!(
                e.is_nan(),
                d.is_nan(),
                "pixel {i}: NaN partition differs (et={e}, de={d})",
            );
        }
    }

    #[test]
    fn distance_estimate_is_resolution_independent_in_pixel_units() {
        // The headline property: because the buffer carries *pixel*-unit
        // distance (plane distance ÷ pixel_scale, and pixel_scale is keyed
        // to the reference width, ADR-0011), the same plane point reads the
        // same distance regardless of buffer dimensions at a fixed zoom.
        //
        // Doubling both dimensions keeps the per-pixel scale identical, and
        // the centre offset algebra lines up exactly: for an N-wide buffer,
        // pixel ⌊N/2⌋ sits ½·scale right of centre; doubling N keeps that
        // half-pixel offset. So vp1's centre pixel and vp2's centre pixel
        // sample the *same* complex point — their pixel-distances must be
        // bit-identical, not merely close.
        let center = Complex64::new(0.35, 0.0); // just right of the cusp → exterior
        let vp1 = Viewport::new(center, 200.0, 100, 100);
        let vp2 = Viewport::new(center, 200.0, 200, 200);
        // Same plane point in both (proven by construction; assert it too).
        assert_eq!(vp1.pixel_to_complex(50, 50), vp2.pixel_to_complex(100, 100));
        let b1 = compute(
            &vp1,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
        let b2 = compute(
            &vp2,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
        let d1 = b1[50 * 100 + 50];
        let d2 = b2[100 * 200 + 100];
        assert!(d1.is_finite() && d2.is_finite(), "centre must be exterior");
        assert_eq!(
            d1.to_bits(),
            d2.to_bits(),
            "pixel-distance drifted with resolution: {d1} vs {d2}",
        );
    }

    // --- Distance Estimate for Julia (#62) -----------------------------
    //
    // The Julia compute path rides the same family-agnostic kernel as
    // Mandelbrot (wired in #61); these lock its behaviour at the pipeline
    // level — finite exterior, NaN interior, the partition agreeing with
    // Escape Time, and the Julia seeds genuinely driving a different image
    // than the Mandelbrot seeds on the same viewport.

    #[test]
    fn julia_distance_estimate_is_finite_outside_and_nan_inside() {
        // Origin-centred view of the Douady-rabbit Julia set: the centre
        // pixel maps to z_0 = 0, inside the connected filled set → NaN;
        // the exterior (corners) escapes → finite. Mirrors the Mandelbrot
        // DE shape test on the Julia family.
        let vp = origin_viewport();
        let buf = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::DistanceEstimate,
        );
        assert_eq!(buf.len(), (vp.width as usize) * (vp.height as usize));
        assert!(
            buf[center_idx(&vp)].is_nan(),
            "Julia set interior must be NaN"
        );
        assert!(
            buf.iter().any(|d| d.is_finite()),
            "no finite Julia distances — exterior not rendered?",
        );
        for &d in &buf {
            assert!(d.is_nan() || d >= 0.0, "negative Julia distance: {d}");
        }
    }

    #[test]
    fn julia_distance_estimate_partition_matches_escape_time() {
        // Switching Field must not reclassify Julia pixels either: a pixel
        // is NaN under Distance Estimate iff it is NaN under Escape Time,
        // because both kernels share the bailout.
        let vp = mapping_viewport();
        let et = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::EscapeTime,
        );
        let de = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::DistanceEstimate,
        );
        assert_eq!(et.len(), de.len());
        for (i, (e, d)) in et.iter().zip(de.iter()).enumerate() {
            assert_eq!(
                e.is_nan(),
                d.is_nan(),
                "Julia pixel {i}: NaN partition differs (et={e}, de={d})",
            );
        }
    }

    #[test]
    fn julia_and_mandelbrot_distance_estimate_produce_different_buffers() {
        // Proves the Julia seed pair (dz_0=1, dc=0) actually flows through
        // the compute branch: on the same viewport, the Julia and
        // Mandelbrot Distance Estimate buffers must differ. A regression
        // that wired Julia DE back to the Mandelbrot seeds would still pass
        // the shape and partition checks (the origin viewport's centre is
        // interior either way) — this is the assertion that breaks.
        let vp = origin_viewport();
        let m = compute(
            &vp,
            MAX_ITER,
            FractalKind::Mandelbrot,
            Field::DistanceEstimate,
        );
        let j = compute(
            &vp,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::DistanceEstimate,
        );
        assert_ne!(m, j, "Julia and Mandelbrot DE buffers are identical");
    }

    #[test]
    fn julia_distance_estimate_is_resolution_independent_in_pixel_units() {
        // The same pixel-unit resolution-independence the Mandelbrot path
        // has, on the Julia family: a shared plane point reads a
        // bit-identical pixel-distance when both dimensions double at a
        // fixed zoom. Centre on an exterior z_0 so the probed pixel escapes.
        let center = Complex64::new(1.5, 0.0); // well outside the rabbit set
        let vp1 = Viewport::new(center, 200.0, 100, 100);
        let vp2 = Viewport::new(center, 200.0, 200, 200);
        assert_eq!(vp1.pixel_to_complex(50, 50), vp2.pixel_to_complex(100, 100));
        let b1 = compute(
            &vp1,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::DistanceEstimate,
        );
        let b2 = compute(
            &vp2,
            MAX_ITER,
            FractalKind::Julia { c: JULIA_C },
            Field::DistanceEstimate,
        );
        let d1 = b1[50 * 100 + 50];
        let d2 = b2[100 * 200 + 100];
        assert!(d1.is_finite() && d2.is_finite(), "centre must be exterior");
        assert_eq!(
            d1.to_bits(),
            d2.to_bits(),
            "Julia pixel-distance drifted with resolution: {d1} vs {d2}",
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

    // --- Clamped mode (ADR-0013) ---------------------------------------

    #[test]
    fn clamped_maps_zero_distance_to_palette_start() {
        // d = 0 (on the boundary) → t = 0 → the palette's first colour.
        // On Grayscale that is black.
        let out = colorize(
            &[0.0],
            Palette::Grayscale,
            NormalizationMode::Clamped,
            MAX_ITER,
        );
        assert_eq!(out, vec![0, 0, 0, 255]);
    }

    #[test]
    fn clamped_saturates_at_and_beyond_k() {
        // d ≥ k → t = 1 → the palette's last colour, and it stays there
        // for any larger distance (the flat tail). On Grayscale that is
        // white. Reference the constant so the test tracks the tuned value
        // (#63) rather than a hard-coded width; probe at exactly k and
        // well past it.
        let k = CLAMPED_DISTANCE_K;
        for &d in &[k, k * 2.0, 100.0, 1.0e6] {
            let out = colorize(
                &[d],
                Palette::Grayscale,
                NormalizationMode::Clamped,
                MAX_ITER,
            );
            assert_eq!(
                out,
                vec![255, 255, 255, 255],
                "d={d} did not saturate to white"
            );
        }
        // Just inside the ramp (d = k/2) is mid-grey, NOT yet saturated —
        // proves a ramp exists rather than a pure step at k.
        let mid = colorize(
            &[k * 0.5],
            Palette::Grayscale,
            NormalizationMode::Clamped,
            MAX_ITER,
        );
        assert_ne!(
            mid,
            vec![255, 255, 255, 255],
            "d=k/2 should be mid-ramp, not white"
        );
    }

    #[test]
    fn clamped_is_monotonic_nondecreasing_in_distance() {
        // Within the ramp, a larger distance is at least as bright — the
        // gradient never reverses. Grayscale makes brightness == red.
        let samples: Vec<f32> = (0..=20).map(|i| i as f32 * 0.1).collect(); // 0.0 .. 2.0
        let mut prev = 0u8;
        for &d in &samples {
            let out = colorize(
                &[d],
                Palette::Grayscale,
                NormalizationMode::Clamped,
                MAX_ITER,
            );
            let red = out[0];
            assert!(
                red >= prev,
                "clamped not monotonic at d={d}: {red} < {prev}"
            );
            prev = red;
        }
    }

    #[test]
    fn clamped_nan_maps_to_opaque_black_for_every_palette() {
        // The inside-set sentinel paints opaque black under Clamped too,
        // symmetric with every other mode (also covered by the combo
        // sweep; spelled out here for the DE default specifically).
        for &p in ALL_PALETTES {
            let out = colorize(&[f32::NAN], p, NormalizationMode::Clamped, MAX_ITER);
            assert_eq!(out, vec![0, 0, 0, 255], "{p:?}");
        }
    }
}
