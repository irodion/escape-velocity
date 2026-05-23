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
//! `compute` returns a pointer into a `thread_local!` `Vec<f32>`; that
//! pointer is invalidated as soon as the next `compute` runs and the
//! `Vec` is reassigned (which can move the underlying allocation).
//! `colorize` may be called repeatedly against the same `(iter_ptr,
//! len)` pair — that is the load-bearing fast-path payoff of Slice 4:
//! changing palette or normalisation alone reuses the same iteration
//! buffer instead of triggering a recompute. The caller is responsible
//! for not interleaving a fresh `compute` between a cached
//! `(iter_ptr, len)` and its next `colorize`; the JS render layer
//! enforces this with a module-level cache that is invalidated only
//! after a full `render` cycle.

use std::cell::RefCell;

use fractal_core::{
    Complex64, FractalKind as CoreFractalKind, NormalizationMode as CoreMode,
    Palette as CorePalette, Viewport as CoreViewport,
};
use wasm_bindgen::prelude::*;

thread_local! {
    static ITER_BUFFER: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static RGBA_BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
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
}

#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum NormalizationMode {
    Cycled = 0,
    Histogram = 1,
}

/// JS-visible fractal-family discriminant. Mirrors
/// `fractal_core::FractalKind` but carries no payload — the core's
/// `Julia { c }` payload arrives as flat `c_re` / `c_im` scalars
/// alongside the discriminant in [`compute`], matching the calling
/// convention the JS side already uses for the viewport constructor
/// (no wasm-bindgen `Complex` struct). Inlining the
/// (`kind`, `c_re`, `c_im`) → `CoreFractalKind` translation inside
/// `compute` is the natural shape because that's the only place the
/// scalar payload exists.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum FractalKind {
    Mandelbrot = 0,
    Julia = 1,
}

impl From<Palette> for CorePalette {
    fn from(p: Palette) -> Self {
        match p {
            Palette::Grayscale => CorePalette::Grayscale,
            Palette::Viridis => CorePalette::Viridis,
            Palette::Magma => CorePalette::Magma,
            Palette::Inferno => CorePalette::Inferno,
            Palette::Twilight => CorePalette::Twilight,
        }
    }
}

impl From<NormalizationMode> for CoreMode {
    fn from(m: NormalizationMode) -> Self {
        match m {
            NormalizationMode::Cycled => CoreMode::Cycled,
            NormalizationMode::Histogram => CoreMode::Histogram,
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
}

/// Compute the smooth-iteration buffer for `viewport` and return a
/// pointer into WASM linear memory. JS pairs this with [`compute_len`]
/// to build a `Float32Array` view; the values are the continuous
/// escape-time count `nu` (NaN for inside-set pixels).
///
/// `kind` selects the fractal family; `c_re` / `c_im` carry the Julia
/// parameter `c`. Both scalars are validated for `is_finite()`
/// **unconditionally** — the Mandelbrot path ignores them, but
/// validating regardless costs nothing and forecloses a class of
/// latent JS bugs where a stale `NaN` in a hidden Julia input would
/// surface only at the next mode toggle.
///
/// The returned `(ptr, len)` pair is the only handle JS keeps to the
/// iteration buffer; it is valid until the next `compute` rewrites the
/// underlying `Vec`. The render layer's module-level cache (see
/// `web/src/render.ts`) encodes this lifetime explicitly so a
/// palette/normalisation-only change can call [`colorize`] against the
/// cached pair without re-iterating.
#[wasm_bindgen]
pub fn compute(
    viewport: &Viewport,
    max_iter: u32,
    kind: FractalKind,
    c_re: f64,
    c_im: f64,
) -> Result<*const f32, JsError> {
    if !c_re.is_finite() {
        return Err(JsError::new("compute: c_re must be finite"));
    }
    if !c_im.is_finite() {
        return Err(JsError::new("compute: c_im must be finite"));
    }
    let core_kind = match kind {
        FractalKind::Mandelbrot => CoreFractalKind::Mandelbrot,
        FractalKind::Julia => CoreFractalKind::Julia {
            c: Complex64::new(c_re, c_im),
        },
    };
    let buf = fractal_core::compute(&viewport.inner, max_iter, core_kind);
    Ok(ITER_BUFFER.with(|cell| {
        let mut iters = cell.borrow_mut();
        *iters = buf;
        iters.as_ptr()
    }))
}

/// Length (element count, not bytes) of the iteration buffer last
/// produced by [`compute`].
#[wasm_bindgen]
pub fn compute_len() -> usize {
    ITER_BUFFER.with(|cell| cell.borrow().len())
}

/// Colorize a smooth-iteration buffer with the given palette and
/// normalisation mode, and return a pointer to the RGBA bytes in WASM
/// linear memory. JS pairs this with [`colorize_len`] to build a
/// `Uint8ClampedArray` view.
///
/// `iter_ptr` / `len` must be the pair previously returned by
/// [`compute`] + [`compute_len`]. Slice 4's render-layer cache lets
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
    // by `compute` + `compute_len` and has not been invalidated by an
    // intervening `compute`. The ITER_BUFFER it points into is owned
    // by this module and outlives the call.
    let iters = unsafe { std::slice::from_raw_parts(iter_ptr, len) };
    let rgba = fractal_core::colorize(iters, palette.into(), mode.into(), max_iter);
    RGBA_BUFFER.with(|cell| {
        let mut buf = cell.borrow_mut();
        *buf = rgba;
        buf.as_ptr()
    })
}

/// Length (in bytes) of the RGBA buffer last produced by [`colorize`].
#[wasm_bindgen]
pub fn colorize_len() -> usize {
    RGBA_BUFFER.with(|cell| cell.borrow().len())
}
