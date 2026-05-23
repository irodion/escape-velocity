//! `wasm-bindgen` binding layer over `fractal-core`.
//!
//! A deliberately thin pass-through (ADR-0005). All math lives in
//! `fractal-core`; this crate only flattens the `Complex64` newtype for
//! JS, validates inputs at the WASM↔JS boundary, and exposes pointer +
//! length handles into WASM linear memory so the JS side can build
//! `Uint32Array` / `Uint8ClampedArray` views without copying.
//!
//! ## Buffer lifetime (Slice 1)
//!
//! Slice 1 issues exactly one `compute` and one `colorize` call per page
//! load. Buffer ownership is therefore trivial: two `thread_local`
//! `Vec`s, each rewritten on every call. The general invalidation
//! protocol (generation counters, lifetime tokens, who releases what)
//! is out of scope for Slice 1 and will land in a small ADR before
//! Slice 2 introduces pan/zoom.

use std::cell::RefCell;

use fractal_core::{Complex64, Viewport as CoreViewport};
use wasm_bindgen::prelude::*;

thread_local! {
    static ITER_BUFFER: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static RGBA_BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
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
}

/// Compute the iteration buffer for `viewport` and return a pointer
/// into WASM linear memory. JS pairs this with [`compute_len`] to
/// build a `Uint32Array` view.
#[wasm_bindgen]
pub fn compute(viewport: &Viewport, max_iter: u32) -> *const u32 {
    let buf = fractal_core::compute(&viewport.inner, max_iter);
    ITER_BUFFER.with(|cell| {
        let mut iters = cell.borrow_mut();
        *iters = buf;
        iters.as_ptr()
    })
}

/// Length (element count, not bytes) of the iteration buffer last
/// produced by [`compute`].
#[wasm_bindgen]
pub fn compute_len() -> usize {
    ITER_BUFFER.with(|cell| cell.borrow().len())
}

/// Colorize an iteration buffer and return a pointer to the RGBA bytes
/// in WASM linear memory. JS pairs this with [`colorize_len`] to build
/// a `Uint8ClampedArray` view.
///
/// `iter_ptr` / `len` must be the pair previously returned by
/// [`compute`] + [`compute_len`]. Slice 1's call-once-per-load
/// discipline makes this invariant trivially upheld; the pre-Slice-2
/// buffer-lifetime ADR encodes it more rigorously.
#[wasm_bindgen]
#[allow(
    clippy::not_unsafe_ptr_arg_deref,
    reason = "wasm-bindgen exports cannot be marked `unsafe` while remaining callable from JS; the JS-side caller upholds the (ptr, len) pairing invariant described in this function's doc comment. The pre-Slice-2 buffer-lifetime ADR will encode the invariant more rigorously."
)]
pub fn colorize(iter_ptr: *const u32, len: usize, max_iter: u32) -> *const u8 {
    // SAFETY: caller guarantees (iter_ptr, len) was previously returned
    // by `compute` + `compute_len`. The ITER_BUFFER it points into is
    // owned by this module and outlives the call.
    let iters = unsafe { std::slice::from_raw_parts(iter_ptr, len) };
    let rgba = fractal_core::colorize(iters, max_iter);
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
