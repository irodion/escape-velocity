//! `wasm-bindgen` binding layer over `fractal-core`.
//!
//! A deliberately thin pass-through (ADR-0005). All math lives in
//! `fractal-core`; this crate only flattens the `Complex64` newtype for
//! JS, validates inputs at the WASM↔JS boundary, surfaces typed enum
//! mirrors of the core's `Palette` / `NormalizationMode` so JS sees a
//! discriminant-checked enum surface instead of magic numbers, and
//! exposes pointer + length handles into WASM linear memory so the JS
//! side can build typed-array views without copying.
//!
//! ## Buffer lifetime
//!
//! `compute_band` returns a pointer into a `thread_local!` `Vec<f32>`; that
//! pointer is invalidated as soon as the next frame's first band (`y0 == 0`)
//! refills the `Vec` in place (a `resize` that can move the allocation if the
//! new frame is larger than the buffer's retained capacity).
//! `colorize` may be called repeatedly against the same `(iter_ptr,
//! len)` pair — that is the load-bearing fast-path payoff of Slice 4:
//! changing palette or normalisation alone reuses the same iteration
//! buffer instead of triggering a recompute. The caller is responsible
//! for not interleaving a fresh frame's bands between a cached
//! `(iter_ptr, len)` and its next `colorize`; the JS render layer
//! enforces this with a module-level cache that is invalidated only
//! after a full `render` cycle.

use std::cell::RefCell;

use fractal_core::{
    Complex64, Field as CoreField, FractalKind as CoreFractalKind, FrameColoring,
    NormalizationMode as CoreMode, Palette as CorePalette, Viewport as CoreViewport,
};
use wasm_bindgen::prelude::*;

/// Stand up the rayon thread pool that backs `fractal_core::compute`'s
/// parallel iterator inside the worker (ADR-0007, Slice 7). Re-exported
/// from `wasm-bindgen-rayon` so the generated glue surfaces it as the
/// async JS function `initThreadPool(numThreads)`. The worker awaits it
/// once, after `init()` and before announcing readiness, so the pool is
/// live before the first render runs (Slice 7C). On a single-core
/// device a pool of one is created and rendering still works.
///
/// This is the *only* export Slice 7 adds; `compute_band` / `colorize` and
/// their lengths, and the `Viewport` class, keep their exact prior
/// signatures — the parallelism is internal to the core compute.
pub use wasm_bindgen_rayon::init_thread_pool;

thread_local! {
    static ITER_BUFFER: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static RGBA_BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// The frame colouring the last [`colorize`] painted with, cached so the
    /// pixel-inspector probe (E2, #95) reads one pixel without re-reducing the
    /// whole frame (the global family's `[min, max]`, Histogram's CDF) or
    /// rebuilding the palette LUT. The key pins it to the `(palette, mode,
    /// max_iter, len)` it was built for, so a probe whose settings drift from
    /// the last paint rebuilds rather than reusing a stale colouring.
    static LAST_NORM: RefCell<Option<NormCache>> = const { RefCell::new(None) };
}

/// The cached frame colouring plus the key identifying which frame / settings
/// it belongs to (see [`LAST_NORM`]).
struct NormCache {
    palette: Palette,
    mode: NormalizationMode,
    max_iter: u32,
    len: usize,
    coloring: FrameColoring,
}

impl NormCache {
    /// Whether this cache entry is valid for a probe against `(palette, mode,
    /// max_iter, len)`. Palette matters because `Cycled`'s period is the
    /// palette's; `len` guards against a buffer resized out from under us.
    fn matches(
        &self,
        palette: Palette,
        mode: NormalizationMode,
        max_iter: u32,
        len: usize,
    ) -> bool {
        self.palette as u32 == palette as u32
            && self.mode as u32 == mode as u32
            && self.max_iter == max_iter
            && self.len == len
    }
}

/// Numeric discriminants are explicit so the JS↔WASM boundary stays
/// stable even if the variant order in `fractal-core` changes.
/// `wasm-bindgen` already rejects out-of-range integers at the binding
/// layer; no further boundary validation is needed inside the
/// `From` impls below.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum Palette {
    Grayscale = 0,
    Viridis = 1,
    Magma = 2,
    Inferno = 3,
    Twilight = 4,
    Plasma = 5,
    Turbo = 6,
    Cubehelix = 7,
    EarthAndSky = 8,
    Rainbow = 9,
    Ocean = 10,
    KaholLavan = 11,
    Solar = 12,
    Spectral = 13,
    Cosmic = 14,
}

#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum NormalizationMode {
    Cycled = 0,
    Histogram = 1,
    Linear = 2,
    SquareRoot = 3,
    Logarithmic = 4,
    Clamped = 5,
}

/// JS-visible fractal-family discriminant. Mirrors
/// `fractal_core::FractalKind` but carries no payload — the core's
/// `Julia { c }` payload arrives as flat `c_re` / `c_im` scalars
/// alongside the discriminant in [`compute_band`], matching the calling
/// convention the JS side already uses for the viewport constructor
/// (no wasm-bindgen `Complex` struct). Translating the
/// (`kind`, `c_re`, `c_im`) triple into a `CoreFractalKind` (via
/// `core_fractal_kind`) is the natural shape because that's the only place
/// the scalar payload exists.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum FractalKind {
    Mandelbrot = 0,
    Julia = 1,
}

/// JS-visible **Field** discriminant (ADR-0013) — selects the per-pixel
/// scalar the `fractal_core` kernels produce. Mirrors `fractal_core::Field`.
/// Numeric values are
/// explicit and **appended** so the JS↔WASM wire format stays stable as
/// new Fields arrive, exactly like the palette/mode enums above.
///
/// Only [`Field::EscapeTime`] is wired through the core in this slice;
/// [`Field::DistanceEstimate`] is reserved here (the UI never selects it)
/// and gains its kernel in Slice 2 (#61).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum Field {
    EscapeTime = 0,
    DistanceEstimate = 1,
}

impl From<Palette> for CorePalette {
    fn from(p: Palette) -> Self {
        match p {
            Palette::Grayscale => CorePalette::Grayscale,
            Palette::Viridis => CorePalette::Viridis,
            Palette::Magma => CorePalette::Magma,
            Palette::Inferno => CorePalette::Inferno,
            Palette::Twilight => CorePalette::Twilight,
            Palette::Plasma => CorePalette::Plasma,
            Palette::Turbo => CorePalette::Turbo,
            Palette::Cubehelix => CorePalette::Cubehelix,
            Palette::EarthAndSky => CorePalette::EarthAndSky,
            Palette::Rainbow => CorePalette::Rainbow,
            Palette::Ocean => CorePalette::Ocean,
            Palette::KaholLavan => CorePalette::KaholLavan,
            Palette::Solar => CorePalette::Solar,
            Palette::Spectral => CorePalette::Spectral,
            Palette::Cosmic => CorePalette::Cosmic,
        }
    }
}

impl From<NormalizationMode> for CoreMode {
    fn from(m: NormalizationMode) -> Self {
        match m {
            NormalizationMode::Cycled => CoreMode::Cycled,
            NormalizationMode::Histogram => CoreMode::Histogram,
            NormalizationMode::Linear => CoreMode::Linear,
            NormalizationMode::SquareRoot => CoreMode::SquareRoot,
            NormalizationMode::Logarithmic => CoreMode::Logarithmic,
            NormalizationMode::Clamped => CoreMode::Clamped,
        }
    }
}

impl From<Field> for CoreField {
    fn from(f: Field) -> Self {
        match f {
            Field::EscapeTime => CoreField::EscapeTime,
            Field::DistanceEstimate => CoreField::DistanceEstimate,
        }
    }
}

/// JS-visible `Viewport`. Wraps the `fractal_core::Viewport` newtype
/// center so JS can construct one from five flat primitives.
#[wasm_bindgen]
pub struct Viewport {
    inner: CoreViewport,
}

#[wasm_bindgen]
impl Viewport {
    /// Construct a viewport from primitive fields, validating at the
    /// system boundary.
    ///
    /// `fractal_core::Viewport` is deliberately un-validated (CLAUDE.md
    /// convention: validate at boundaries, trust internal callers).
    /// This constructor is that boundary — see the PR #5 review thread
    /// on `viewport.rs:48-63` for the rationale.
    #[wasm_bindgen(constructor)]
    pub fn new(re: f64, im: f64, zoom: f64, width: u32, height: u32) -> Result<Viewport, JsError> {
        if !re.is_finite() {
            return Err(JsError::new("Viewport: center re must be finite"));
        }
        if !im.is_finite() {
            return Err(JsError::new("Viewport: center im must be finite"));
        }
        if !zoom.is_finite() || zoom <= 0.0 {
            return Err(JsError::new("Viewport: zoom must be finite and > 0"));
        }
        if width == 0 {
            return Err(JsError::new("Viewport: width must be > 0"));
        }
        if height == 0 {
            return Err(JsError::new("Viewport: height must be > 0"));
        }
        Ok(Self {
            inner: CoreViewport::new(Complex64::new(re, im), zoom, width, height),
        })
    }

    /// Return a new viewport panned by `(dx_pixels, dy_pixels)` canvas
    /// pixels (sub-pixel deltas allowed). Validates finite inputs at
    /// the JS↔WASM boundary; the math itself lives in `fractal_core`.
    ///
    /// Sign convention is the same as `fractal_core::Viewport::pan_by_pixels`:
    /// positive `dx_pixels` shifts the rendered image right on screen,
    /// positive `dy_pixels` shifts it down.
    #[wasm_bindgen]
    pub fn pan_by_pixels(&self, dx_pixels: f64, dy_pixels: f64) -> Result<Viewport, JsError> {
        if !dx_pixels.is_finite() {
            return Err(JsError::new("pan_by_pixels: dx_pixels must be finite"));
        }
        if !dy_pixels.is_finite() {
            return Err(JsError::new("pan_by_pixels: dy_pixels must be finite"));
        }
        Ok(Self {
            inner: self.inner.pan_by_pixels(dx_pixels, dy_pixels),
        })
    }

    /// Return a new viewport whose zoom is `self.zoom * factor`
    /// (clamped to `[MIN_ZOOM, MAX_ZOOM]` inside `fractal_core`) with
    /// `center` adjusted so the complex-plane point under
    /// `(pixel_x, pixel_y)` is invariant across the step.
    ///
    /// Validates finite inputs and `factor > 0` at the boundary —
    /// `factor <= 0` would invert orientation, which is meaningless
    /// for wheel-zoom UX.
    #[wasm_bindgen]
    pub fn zoom_around(
        &self,
        pixel_x: f64,
        pixel_y: f64,
        factor: f64,
    ) -> Result<Viewport, JsError> {
        if !pixel_x.is_finite() {
            return Err(JsError::new("zoom_around: pixel_x must be finite"));
        }
        if !pixel_y.is_finite() {
            return Err(JsError::new("zoom_around: pixel_y must be finite"));
        }
        if !factor.is_finite() || factor <= 0.0 {
            return Err(JsError::new("zoom_around: factor must be finite and > 0"));
        }
        Ok(Self {
            inner: self.inner.zoom_around(pixel_x, pixel_y, factor),
        })
    }

    /// Return a new viewport at the requested pixel dimensions, with
    /// `center` and `zoom` preserved exactly. Rejects zero in either
    /// dimension at the boundary; the core method itself is
    /// un-validated per the `fractal-core` trust-callers convention.
    #[wasm_bindgen]
    pub fn with_resolution(&self, width: u32, height: u32) -> Result<Viewport, JsError> {
        if width == 0 {
            return Err(JsError::new("with_resolution: width must be > 0"));
        }
        if height == 0 {
            return Err(JsError::new("with_resolution: height must be > 0"));
        }
        Ok(Self {
            inner: self.inner.with_resolution(width, height),
        })
    }

    // Flat-primitive accessors. Slice 6 introduces a coordinating
    // Web Worker that owns its own WASM instance; a `Viewport` class
    // instance cannot survive `postMessage` (structured-clone breaks
    // wasm-bindgen class identity across realms), so the main thread
    // reads these five scalars off its `Viewport` and ships them as
    // primitives. The worker reconstructs a fresh `Viewport` on the
    // far side via the existing constructor.

    #[wasm_bindgen]
    pub fn center_re(&self) -> f64 {
        self.inner.center.re
    }

    #[wasm_bindgen]
    pub fn center_im(&self) -> f64 {
        self.inner.center.im
    }

    #[wasm_bindgen]
    pub fn zoom(&self) -> f64 {
        self.inner.zoom
    }

    #[wasm_bindgen]
    pub fn width(&self) -> u32 {
        self.inner.width
    }

    #[wasm_bindgen]
    pub fn height(&self) -> u32 {
        self.inner.height
    }
}

/// Validate the Julia `c` payload at the WASM↔JS boundary and translate the
/// flat `(kind, c_re, c_im)` triple into a [`CoreFractalKind`]. Used by
/// [`compute_band`]; `context` names the caller so a
/// non-finite `c` surfaces a located message. `c_re` / `c_im` are validated
/// **unconditionally** — the Mandelbrot path ignores them mathematically, but
/// validating regardless forecloses a class of latent JS bugs where a stale
/// `NaN` in a hidden Julia input would surface only at the next mode toggle.
fn core_fractal_kind(
    context: &str,
    kind: FractalKind,
    c_re: f64,
    c_im: f64,
) -> Result<CoreFractalKind, JsError> {
    if !c_re.is_finite() {
        return Err(JsError::new(&format!("{context}: c_re must be finite")));
    }
    if !c_im.is_finite() {
        return Err(JsError::new(&format!("{context}: c_im must be finite")));
    }
    Ok(match kind {
        FractalKind::Mandelbrot => CoreFractalKind::Mandelbrot,
        FractalKind::Julia => CoreFractalKind::Julia {
            c: Complex64::new(c_re, c_im),
        },
    })
}

/// Length (element count, not bytes) of the iteration buffer last
/// accumulated by [`compute_band`].
#[wasm_bindgen]
pub fn compute_len() -> usize {
    ITER_BUFFER.with(|cell| cell.borrow().len())
}

/// Compute one horizontal **band** — pixel rows `[y0, y1)` — of a frame
/// into the shared iteration buffer, and return the buffer pointer.
///
/// This is the cancellable, banded way to fill the iteration buffer (P2,
/// #78). The render worker drives a frame band-by-band: it calls
/// `compute_band` for each row range, yields to its event loop between bands,
/// and abandons the rest the moment a newer viewport supersedes the in-flight
/// one — so a doomed deep render stops within a band instead of blocking the
/// worker for seconds. Concatenated, the bands are bit-identical to a single
/// full-frame compute (`fractal_core::compute_rows` keys every row to its
/// absolute `py`), so the final [`colorize`] over the whole buffer is
/// unchanged.
///
/// ## Buffer protocol
///
/// The **first** band of a frame (`y0 == 0`) clears [`ITER_BUFFER`] and
/// resizes it to the whole frame (`width * height`) up front. That single
/// allocation never moves while the remaining bands fill, so the returned
/// pointer stays valid across the entire band sequence *and* the trailing
/// `colorize` — the caller may read it after the last band, paired with
/// [`compute_len`]. Each band writes directly into its absolute slice
/// `[y0 * width, y1 * width)` (no intermediate buffer, no copy). The caller
/// MUST start a frame at `y0 == 0` and walk a contiguous partition up to
/// `height`; the worker's band planner does exactly this.
///
/// `c_re` / `c_im` are validated for finiteness (via `core_fractal_kind`),
/// and the band range is checked (`y0 <= y1 <= height`) at this WASM↔JS
/// boundary.
#[wasm_bindgen]
#[allow(
    clippy::too_many_arguments,
    reason = "wasm-bindgen exports take flat positional primitives across the JS↔WASM boundary (no struct grouping survives `postMessage`/the bindgen ABI): viewport, max_iter, the (kind, c_re, c_im) family payload, field, and the band range (y0, y1)."
)]
pub fn compute_band(
    viewport: &Viewport,
    max_iter: u32,
    kind: FractalKind,
    c_re: f64,
    c_im: f64,
    field: Field,
    y0: u32,
    y1: u32,
) -> Result<*const f32, JsError> {
    let width = viewport.inner.width;
    let height = viewport.inner.height;
    if y0 > y1 || y1 > height {
        return Err(JsError::new(
            "compute_band: require y0 <= y1 <= viewport.height",
        ));
    }
    let core_kind = core_fractal_kind("compute_band", kind, c_re, c_im)?;
    let w = width as usize;
    Ok(ITER_BUFFER.with(|cell| {
        let mut iters = cell.borrow_mut();
        if y0 == 0 {
            // Fresh frame: size the persistent buffer to the whole frame once.
            // `resize` zero-fills, but that single memset is far cheaper than
            // the per-band intermediate `Vec` + concatenating copy the old
            // `extend_from_slice(&compute_rows(..))` paid every band — and it
            // lets each band fill its slice in place below. The allocation is
            // reused across frames (capacity retained, P4 #80) and never moves
            // while bands fill, so the returned pointer stays valid through the
            // trailing colorize.
            iters.clear();
            iters.resize(w * (height as usize), 0.0);
        }
        // Each band writes straight into its absolute slice `[y0*w, y1*w)` — no
        // intermediate buffer, no copy. The caller's contiguous-partition
        // contract guarantees the slices tile the frame exactly once.
        let band = &mut iters[(y0 as usize) * w..(y1 as usize) * w];
        fractal_core::compute_rows_into(
            &viewport.inner,
            max_iter,
            core_kind,
            field.into(),
            y0,
            y1,
            band,
        );
        iters.as_ptr()
    }))
}

/// Colorize a smooth-iteration buffer with the given palette and
/// normalisation mode, and return a pointer to the RGBA bytes in WASM
/// linear memory. JS pairs this with [`colorize_len`] to build a
/// `Uint8ClampedArray` view.
///
/// `iter_ptr` / `len` must be the pair previously returned by
/// [`compute_band`] + [`compute_len`]. Slice 4's render-layer cache lets
/// this be called repeatedly against the same `(iter_ptr, len)` pair
/// — the fast-path payoff of ADR-0002: a palette or normalisation
/// change repaints in milliseconds because no iteration runs.
#[wasm_bindgen]
#[allow(
    clippy::not_unsafe_ptr_arg_deref,
    reason = "wasm-bindgen exports cannot be marked `unsafe` while remaining callable from JS; the JS-side caller upholds the (ptr, len) pairing invariant described in this function's doc comment. The render-layer cache in `web/src/render.ts` encodes that invariant explicitly."
)]
pub fn colorize(
    iter_ptr: *const f32,
    len: usize,
    palette: Palette,
    mode: NormalizationMode,
    max_iter: u32,
) -> *const u8 {
    // SAFETY: caller guarantees (iter_ptr, len) was previously returned
    // by `compute_band` + `compute_len` and has not been invalidated by an
    // intervening frame's bands. The ITER_BUFFER it points into is owned
    // by this module and outlives the call.
    let iters = unsafe { std::slice::from_raw_parts(iter_ptr, len) };
    RGBA_BUFFER.with(|cell| {
        let mut buf = cell.borrow_mut();
        // Fill the persistent RGBA buffer in place (P4, #80): `colorize_into`
        // clears and reserves, reusing the prior frame's allocation instead of
        // swapping in a fresh `Vec` (which would free the old one and let wasm
        // linear memory ratchet under per-frame churn).
        let coloring =
            fractal_core::colorize_into(iters, palette.into(), mode.into(), max_iter, &mut buf);
        // Stash the colouring so the inspector probe (E2, #95) reuses this frame's
        // global stats / CDF and palette LUT instead of rebuilding them per hover.
        LAST_NORM.with(|c| {
            *c.borrow_mut() = Some(NormCache {
                palette,
                mode,
                max_iter,
                len,
                coloring,
            });
        });
        buf.as_ptr()
    })
}

/// One pixel of the cached Field buffer traced through the colorize pipeline,
/// for the pixel inspector (E2, #95). Read via wasm-bindgen getters on the JS
/// side; see [`probe_pixel`].
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct ProbeResult {
    /// Raw cached Field scalar: smooth `nu`, distance `d`, or `NaN` inside.
    pub raw: f32,
    /// Normalised palette coordinate `t ∈ [0, 1]`; `NaN` when `inside` (ignore).
    pub t: f32,
    /// `true` iff the pixel is the NaN inside-set sentinel.
    pub inside: bool,
    /// Painted colour — matches the on-screen pixel exactly. Black inside.
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Trace one pixel of the cached iteration buffer through the current
/// `(palette, mode)` and return its raw value, normalised `t`, and painted
/// colour — the worker side of the pixel inspector (E2, #95).
///
/// `iter_ptr` / `len` must be the pair last returned by [`compute_band`] +
/// [`compute_len`] (the same cached buffer [`colorize`] reads); `index` is the
/// row-major pixel `y * width + x`, validated against `len` here. No recompute
/// runs: the frame colouring cached by the last [`colorize`] is reused when its
/// `(palette, mode, max_iter, len)` still matches, and only rebuilt on a
/// mismatch (e.g. a probe arriving before the matching repaint).
#[wasm_bindgen]
#[allow(
    clippy::not_unsafe_ptr_arg_deref,
    reason = "wasm-bindgen exports cannot be marked `unsafe` while remaining callable from JS; the caller upholds the (iter_ptr, len) pairing invariant exactly as `colorize` documents — the JS render-layer cache enforces it."
)]
pub fn probe_pixel(
    iter_ptr: *const f32,
    len: usize,
    index: usize,
    palette: Palette,
    mode: NormalizationMode,
    max_iter: u32,
) -> Result<ProbeResult, JsError> {
    if index >= len {
        return Err(JsError::new("probe_pixel: index out of range"));
    }
    // SAFETY: as with `colorize`, the caller guarantees (iter_ptr, len) is the
    // live cached buffer and has not been invalidated by an intervening frame.
    let iters = unsafe { std::slice::from_raw_parts(iter_ptr, len) };
    let sample = LAST_NORM.with(|c| {
        let cache = c.borrow();
        match cache.as_ref() {
            Some(entry) if entry.matches(palette, mode, max_iter, len) => {
                fractal_core::probe_value(iters, index, &entry.coloring)
            }
            _ => {
                // No matching cached colouring (e.g. a probe raced ahead of the
                // repaint): rebuild it for this one read. Still correct, just not
                // O(1) for the global/Histogram modes.
                let coloring = FrameColoring::build(iters, palette.into(), mode.into(), max_iter);
                fractal_core::probe_value(iters, index, &coloring)
            }
        }
    });
    Ok(ProbeResult {
        raw: sample.raw,
        t: sample.t,
        inside: sample.inside,
        r: sample.rgb[0],
        g: sample.rgb[1],
        b: sample.rgb[2],
    })
}

/// Length (in bytes) of the RGBA buffer last produced by [`colorize`].
#[wasm_bindgen]
pub fn colorize_len() -> usize {
    RGBA_BUFFER.with(|cell| cell.borrow().len())
}
