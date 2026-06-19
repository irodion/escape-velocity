//! Mandelbrot/Julia escape-time iteration and coloring.
//!
//! Pure Rust, no `wasm-bindgen` dependency. See ADR-0005 in
//! `docs/decisions/` for the crate-split rationale.
//!
//! The public surface is intentionally tiny:
//!
//! - [`Complex64`] — newtype complex number for the inner loop.
//! - [`Viewport`] — rectangular window onto the complex plane.
//! - [`MIN_ZOOM`] / [`MAX_ZOOM`] — zoom clamping range used by
//!   [`Viewport::zoom_around`].
//! - [`FractalKind`] — selects which family (`Mandelbrot` or
//!   `Julia { c }`) `compute` dispatches.
//! - [`Field`] — selects *what scalar* `compute` emits per pixel
//!   (`EscapeTime` or `DistanceEstimate`); see ADR-0013.
//! - [`escape_time`] — smooth (continuous) single-point iteration of
//!   `z_{n+1} = z_n² + c` for an arbitrary `(z_0, c)`; returns
//!   `f32::NAN` for inside-set points.
//! - [`escape_distance`] — boundary distance estimate for a single
//!   point, tracking the orbit derivative; `f32::NAN` inside the set.
//!   The Distance Estimate Field's kernel (ADR-0013).
//! - [`compute`] — viewport → per-pixel smooth-iteration buffer.
//! - [`colorize`] — smooth-iteration buffer → RGBA8 pixels via a
//!   [`Palette`] and a [`NormalizationMode`].

mod complex;
mod escape_distance;
mod escape_time;
mod field;
mod fractal_kind;
mod palette;
mod pipeline;
mod viewport;

/// Squared escape ("bailout") radius shared by both per-pixel kernels:
/// `|z|² > 65_536` ⇔ `|z| > 256`.
///
/// Hoisted here (not duplicated per kernel) because the Escape Time and
/// Distance Estimate Fields MUST agree bit-for-bit on which pixels are
/// interior — switching Field never reclassifies a pixel (ADR-0013). A
/// single definition makes that agreement structural, not a hand-sync
/// invariant. The large radius also (a) shrinks smooth-iteration banding
/// below the perceptible level and (b) tightens the `|z|·ln|z|/|z'|`
/// distance estimate; both improve as `|z|` grows, and `256²+ε` squared
/// (`≈ 4.3·10⁹`) stays well inside `f64` range.
pub(crate) const BAILOUT_SQR: f64 = 65_536.0;

pub use complex::Complex64;
pub use escape_distance::escape_distance;
pub use escape_time::escape_time;
pub use field::Field;
pub use fractal_kind::FractalKind;
pub use palette::{NormalizationMode, Palette};
pub use pipeline::{
    FrameColoring, ProbeSample, colorize, colorize_into, compute, compute_rows, compute_rows_into,
    probe_value,
};
pub use viewport::{MAX_ZOOM, MIN_ZOOM, Viewport};
