//! Mandelbrot/Julia escape-time iteration and coloring.
//!
//! Pure Rust, no `wasm-bindgen` dependency. See ADR-0005 in
//! `docs/decisions/` for the crate-split rationale.
//!
//! The public surface is intentionally tiny:
//!
//! - [`Complex64`] — newtype complex number for the inner loop.
//! - [`Viewport`] — rectangular window onto the complex plane.
//! - [`escape_time`] — single-point Mandelbrot iteration.
//! - [`compute`] — viewport → per-pixel iteration buffer.
//! - [`colorize`] — iteration buffer → RGBA8 pixels (Slice 1 greyscale).

mod complex;
mod escape_time;
mod pipeline;
mod viewport;

pub use complex::Complex64;
pub use escape_time::escape_time;
pub use pipeline::{colorize, compute};
pub use viewport::Viewport;
