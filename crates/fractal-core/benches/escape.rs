//! Whole-frame `compute` timing for the per-pixel kernels (P7, #83).
//!
//! The Brent periodicity check added in #83 returns the *same* NaN inside-set
//! sentinel as the full `max_iter` loop, just sooner — so it is invisible to the
//! bit-identical output tests in `pipeline.rs`. This bench is where the win
//! shows up. Two cases, both at a high `max_iter` (where the saved-loop matters):
//!
//! - **interior-heavy Julia** (the Douady rabbit, origin-centred): most pixels
//!   are inside the connected filled set and the cardioid/bulb cull does *not*
//!   apply to Julia, so before #83 every interior pixel burned the full loop.
//!   This is the case Brent helps most — expect a clear drop.
//! - **exterior-heavy Mandelbrot** (a deep seahorse-valley view): mostly
//!   escaping pixels that now pay one extra compare + occasional store per
//!   iteration for no early exit. This is the regression guard — it should be
//!   flat, confirming the periodicity bookkeeping is negligible on the hot
//!   exterior path.

use criterion::{Criterion, criterion_group, criterion_main};
use fractal_core::{Complex64, Field, FractalKind, Viewport, compute};
use std::hint::black_box;

// Modest resolution so the bench is quick but still exercises the parallel
// fan-out; high `max_iter` so interior pixels would otherwise dominate.
const WIDTH: u32 = 400;
const HEIGHT: u32 = 300;
const MAX_ITER: u32 = 4096;

fn bench_kernels(c: &mut Criterion) {
    // Interior-heavy: the Douady-rabbit Julia set, origin-centred so the
    // connected filled interior fills the frame.
    let rabbit = FractalKind::Julia {
        c: Complex64::new(-0.123, 0.745),
    };
    let julia_vp = Viewport::new(Complex64::new(0.0, 0.0), 1.0, WIDTH, HEIGHT);

    c.bench_function("julia_interior_escape_time", |b| {
        b.iter(|| {
            compute(
                black_box(&julia_vp),
                black_box(MAX_ITER),
                black_box(rabbit),
                black_box(Field::EscapeTime),
            )
        })
    });

    c.bench_function("julia_interior_distance_estimate", |b| {
        b.iter(|| {
            compute(
                black_box(&julia_vp),
                black_box(MAX_ITER),
                black_box(rabbit),
                black_box(Field::DistanceEstimate),
            )
        })
    });

    // Exterior-heavy regression guard: a deep zoom into the seahorse valley,
    // mostly escaping pixels with thin filaments of interior.
    let seahorse_vp = Viewport::new(Complex64::new(-0.743_5, 0.131_4), 2000.0, WIDTH, HEIGHT);

    c.bench_function("mandelbrot_exterior_escape_time", |b| {
        b.iter(|| {
            compute(
                black_box(&seahorse_vp),
                black_box(MAX_ITER),
                black_box(FractalKind::Mandelbrot),
                black_box(Field::EscapeTime),
            )
        })
    });
}

criterion_group!(benches, bench_kernels);
criterion_main!(benches);
