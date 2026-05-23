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
//! - [`escape_time`] — smooth (continuous) single-point Mandelbrot
//!   iteration; returns `f32::NAN` for inside-set points.
//! - [`compute`] — viewport → per-pixel smooth-iteration buffer.
//! - [`colorize`] — smooth-iteration buffer → RGBA8 pixels via a
//!   [`Palette`] and a [`NormalizationMode`].

mod complex;
mod escape_time;
mod palette;
mod pipeline;
mod viewport;

pub use complex::Complex64;
pub use escape_time::escape_time;
pub use palette::{NormalizationMode, Palette};
pub use pipeline::{colorize, compute};
pub use viewport::{MAX_ZOOM, MIN_ZOOM, Viewport};
