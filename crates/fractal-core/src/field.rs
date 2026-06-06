//! The rendered-scalar selector — the **Field** axis (ADR-0013).
//!
//! ADR-0002 fixed the pipeline seam as `compute → one f32 per pixel →
//! colorize`. ADR-0013 generalises that single scalar from "always the
//! smooth escape-time count `nu`" to "a **Field**": the per-pixel scalar
//! quantity `compute` emits, chosen *before* any normalisation or palette
//! applies.
//!
//! - **Escape Time**: the smooth continuous count `nu` — the existing
//!   default, and the only Field `compute` actually produces today.
//! - **Distance Estimate**: an estimate of each pixel's distance to the
//!   set boundary. Its maths (a separate `escape_distance` kernel that
//!   tracks the orbit derivative) lands in Slice 2 (#61); this slice
//!   wires the axis end-to-end with Escape Time alone, so `compute` does
//!   not yet produce a Distance Estimate buffer.
//!
//! Like [`crate::FractalKind`], the Field is matched once per render in
//! `compute` and is otherwise invisible downstream: `colorize` only ever
//! sees a scalar buffer and cannot tell which Field produced it — ADR-0013
//! keeps `colorize` Field-blind.
//!
//! `Copy` is deliberate and trivially satisfiable (the enum is a bare
//! discriminant), matching the cheap pass-by-value dispatch `FractalKind`
//! relies on. `Default` is `EscapeTime` — the historical behaviour.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Field {
    /// Smooth (continuous) escape-time count `nu`. The default.
    #[default]
    EscapeTime,
    /// Distance-to-boundary estimate `d`. Wired here, computed in #61.
    DistanceEstimate,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compile-time guard: the enum stays `Copy`. The dispatch in
    // `compute` matches on it by value every frame; a future change that
    // added a non-Copy payload would fail to compile here and force the
    // author to reconsider, exactly as the `FractalKind` guard does.
    #[test]
    fn field_is_copy() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<Field>();
    }

    // Compile-time guard: every variant is reachable from an exhaustive
    // `match`. Adding a third Field without updating the pipeline dispatch
    // (or any other match site) fails to compile, surfacing the omission
    // at build time rather than as a silent runtime fallback.
    #[test]
    fn exhaustive_match_covers_every_variant() {
        fn name(field: Field) -> &'static str {
            match field {
                Field::EscapeTime => "escape-time",
                Field::DistanceEstimate => "distance-estimate",
            }
        }
        assert_eq!(name(Field::EscapeTime), "escape-time");
        assert_eq!(name(Field::DistanceEstimate), "distance-estimate");
    }

    // The default Field is Escape Time — the behaviour every caller had
    // before the axis existed.
    #[test]
    fn default_is_escape_time() {
        assert_eq!(Field::default(), Field::EscapeTime);
    }
}
