//! Colour palettes and normalisation modes for smooth Mandelbrot output.
//!
//! The smooth-iteration count `nu` from [`crate::escape_time`] is a
//! continuous real number; turning it into a pixel involves two
//! decisions:
//!
//! 1. **Normalisation** — how to map `nu` into the unit interval `[0,
//!    1]` for palette lookup. [`NormalizationMode::Cycled`] divides by
//!    a fixed period and takes the fractional part; the orbit colours
//!    repeat as `nu` advances, which makes the bands surrounding the
//!    set visible. [`NormalizationMode::Histogram`] equalises the
//!    finite-`nu` distribution across the unit interval, which
//!    flattens out the iteration-density variation and reveals
//!    structure at every escape rate at once.
//!
//! 2. **Palette** — which colour gradient to look up against. The
//!    set's traditional "void black" interior is non-negotiable, but
//!    the rings around it are an aesthetic choice; offering several
//!    palettes lets the user pick the mood without changing the maths.
//!
//! ## Provenance
//!
//! [`Palette::Viridis`], [`Palette::Magma`], [`Palette::Inferno`],
//! [`Palette::Plasma`], and [`Palette::Twilight`] are sampled from
//! matplotlib's published colormaps (the upstream `_cm_listed.py`
//! module — BSD/PSF-licensed, GPL-3.0-compatible). [`Palette::Turbo`]
//! is sampled from Google's Turbo colormap (Apache-2.0). Each palette
//! stores six to nine `(t, [R,G,B])` stops chosen at roughly uniform
//! positions across the 256-entry source table; [`Palette::sample`]
//! linearly interpolates between adjacent stops. Eight stops is plenty
//! to capture each palette's flavour at the resolution the eye can
//! resolve on a typical canvas.
//!
//! [`Palette::Cubehelix`] is sampled from Dave Green's cubehelix
//! scheme (brightness rises monotonically while the hue spirals, so it
//! degrades gracefully to greyscale). [`Palette::EarthAndSky`] is the
//! classic "Ultra Fractal" gradient (blue → white → orange → black)
//! made famous by the Wikipedia Mandelbrot imagery, and
//! [`Palette::Rainbow`] (a full HSV hue wheel) and [`Palette::Ocean`]
//! (black → deep blue → cyan → white) are hand-rolled in the fractal-
//! art tradition. Earth-and-sky and rainbow are cyclic (endpoint
//! colours match), so they wrap cleanly under
//! [`NormalizationMode::Cycled`].
//!
//! [`Palette::KaholLavan`] ("blue–white" in Hebrew, the Israeli flag
//! colours) is a hand-rolled cyclic ramp white → flag-blue → white; its
//! matching endpoints make the `Cycled` bands alternate like the flag's
//! stripes.
//!
//! [`Palette::Grayscale`] is a hand-rolled two-stop ramp, included as
//! a reference baseline.

/// Identifies which colour gradient [`crate::pipeline::colorize`] uses
/// to turn smooth-iteration counts into pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Palette {
    Grayscale,
    Viridis,
    Magma,
    Inferno,
    Twilight,
    Plasma,
    Turbo,
    Cubehelix,
    EarthAndSky,
    Rainbow,
    Ocean,
    KaholLavan,
}

/// Identifies how `nu` values are mapped into `[0, 1]` before palette
/// lookup. See the module docs for the trade-off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalizationMode {
    Cycled,
    Histogram,
}

/// One control point on a gradient: `(t, [R, G, B])` with `t ∈ [0, 1]`.
/// Adjacent stops have strictly increasing `t`; consecutive pairs are
/// the inputs to the linear interpolation in [`Palette::sample`].
type Stop = (f32, [u8; 3]);

const GRAYSCALE_STOPS: &[Stop] = &[(0.0, [0, 0, 0]), (1.0, [255, 255, 255])];

const VIRIDIS_STOPS: &[Stop] = &[
    (0.000, [68, 1, 84]),
    (0.143, [70, 50, 126]),
    (0.286, [59, 82, 139]),
    (0.429, [43, 113, 142]),
    (0.571, [37, 137, 142]),
    (0.714, [31, 163, 135]),
    (0.857, [82, 197, 105]),
    (1.000, [253, 231, 37]),
];

const MAGMA_STOPS: &[Stop] = &[
    (0.000, [0, 0, 4]),
    (0.143, [25, 16, 70]),
    (0.286, [63, 18, 105]),
    (0.429, [104, 29, 111]),
    (0.571, [151, 38, 104]),
    (0.714, [203, 60, 88]),
    (0.857, [242, 107, 72]),
    (1.000, [252, 253, 191]),
];

const INFERNO_STOPS: &[Stop] = &[
    (0.000, [0, 0, 4]),
    (0.143, [30, 12, 75]),
    (0.286, [73, 14, 104]),
    (0.429, [115, 27, 100]),
    (0.571, [154, 42, 85]),
    (0.714, [197, 69, 55]),
    (0.857, [234, 123, 29]),
    (1.000, [252, 255, 164]),
];

// Twilight is matplotlib's cyclic palette — endpoint colours match so
// that wrapping around `t = 1.0 → 0.0` is continuous. The nine stops
// span the full cycle.
const TWILIGHT_STOPS: &[Stop] = &[
    (0.000, [226, 217, 222]),
    (0.125, [142, 149, 189]),
    (0.250, [56, 97, 159]),
    (0.375, [35, 53, 89]),
    (0.500, [47, 37, 46]),
    (0.625, [103, 39, 39]),
    (0.750, [171, 63, 56]),
    (0.875, [217, 132, 122]),
    (1.000, [226, 217, 222]),
];

const PLASMA_STOPS: &[Stop] = &[
    (0.000, [13, 8, 135]),
    (0.143, [84, 2, 163]),
    (0.286, [139, 10, 165]),
    (0.429, [185, 50, 137]),
    (0.571, [219, 92, 104]),
    (0.714, [244, 136, 73]),
    (0.857, [254, 188, 43]),
    (1.000, [240, 249, 33]),
];

// Google's Turbo — a vivid rainbow tuned to avoid the perceptual
// false-edges of the legacy "jet" map. Not perceptually uniform, but
// its wide hue swing exposes fine filament structure better than the
// sequential maps, especially under histogram normalisation.
const TURBO_STOPS: &[Stop] = &[
    (0.000, [48, 18, 59]),
    (0.143, [62, 91, 197]),
    (0.286, [39, 150, 235]),
    (0.429, [24, 199, 173]),
    (0.571, [122, 224, 79]),
    (0.714, [211, 202, 57]),
    (0.857, [250, 138, 50]),
    (1.000, [122, 4, 3]),
];

// Dave Green's cubehelix — brightness climbs monotonically from black
// to white while the hue spirals through purple/green/tan, so it reads
// correctly even in greyscale. Sequential, like viridis & friends.
const CUBEHELIX_STOPS: &[Stop] = &[
    (0.000, [0, 0, 0]),
    (0.125, [21, 12, 38]),
    (0.250, [21, 39, 78]),
    (0.375, [16, 78, 84]),
    (0.500, [40, 114, 67]),
    (0.625, [110, 130, 49]),
    (0.750, [183, 138, 89]),
    (0.875, [206, 172, 184]),
    (1.000, [255, 255, 255]),
];

// "Earth and Sky" — the classic Ultra Fractal default (the gradient on
// Wikipedia's Mandelbrot article): deep blue → bright blue → white →
// orange → near-black, wrapping back to deep blue. The closing stop at
// t = 1.0 matches t = 0.0 so the cycle is seamless.
const EARTH_AND_SKY_STOPS: &[Stop] = &[
    (0.0000, [0, 7, 100]),
    (0.1600, [32, 107, 203]),
    (0.4200, [237, 255, 255]),
    (0.6425, [255, 170, 0]),
    (0.8575, [0, 2, 0]),
    (1.0000, [0, 7, 100]),
];

// Full-saturation HSV hue wheel — the traditional fractal "rainbow".
// Endpoints match (red → red) so it cycles seamlessly.
const RAINBOW_STOPS: &[Stop] = &[
    (0.0000, [255, 0, 0]),
    (0.1667, [255, 255, 0]),
    (0.3333, [0, 255, 0]),
    (0.5000, [0, 255, 255]),
    (0.6667, [0, 0, 255]),
    (0.8333, [255, 0, 255]),
    (1.0000, [255, 0, 0]),
];

// Hand-rolled "ocean" ramp: black → deep blue → azure → cyan → white.
const OCEAN_STOPS: &[Stop] = &[
    (0.000, [0, 0, 0]),
    (0.250, [0, 27, 64]),
    (0.500, [0, 76, 153]),
    (0.750, [0, 160, 200]),
    (0.900, [120, 220, 230]),
    (1.000, [224, 255, 255]),
];

// "Kahol–Lavan" (כחול–לבן, "blue–white") — the Israeli flag colours.
// White → flag-blue (#0038B8) → white; the matching endpoints make the
// cycle seamless, so `Cycled` bands alternate like the flag's stripes.
const KAHOL_LAVAN_STOPS: &[Stop] = &[
    (0.00, [255, 255, 255]),
    (0.25, [120, 170, 235]),
    (0.50, [0, 56, 184]),
    (0.75, [120, 170, 235]),
    (1.00, [255, 255, 255]),
];

impl Palette {
    fn stops(self) -> &'static [Stop] {
        match self {
            Palette::Grayscale => GRAYSCALE_STOPS,
            Palette::Viridis => VIRIDIS_STOPS,
            Palette::Magma => MAGMA_STOPS,
            Palette::Inferno => INFERNO_STOPS,
            Palette::Twilight => TWILIGHT_STOPS,
            Palette::Plasma => PLASMA_STOPS,
            Palette::Turbo => TURBO_STOPS,
            Palette::Cubehelix => CUBEHELIX_STOPS,
            Palette::EarthAndSky => EARTH_AND_SKY_STOPS,
            Palette::Rainbow => RAINBOW_STOPS,
            Palette::Ocean => OCEAN_STOPS,
            Palette::KaholLavan => KAHOL_LAVAN_STOPS,
        }
    }

    /// Default cycling period for [`NormalizationMode::Cycled`].
    ///
    /// `colorize` divides `nu` by this and takes the fractional part,
    /// so a smaller period means tighter colour bands. Twilight is
    /// cyclic and tolerates a longer period without losing structure;
    /// the other palettes look good at 64. Earth-and-sky and rainbow
    /// are likewise cyclic, so they share the longer period.
    pub fn period(self) -> f32 {
        match self {
            Palette::Twilight | Palette::EarthAndSky | Palette::Rainbow | Palette::KaholLavan => {
                96.0
            }
            _ => 64.0,
        }
    }

    /// Look up the gradient at parameter `t`. Values outside `[0, 1]`
    /// are clamped to the endpoints — there is no extrapolation.
    pub fn sample(self, t: f32) -> [u8; 3] {
        let stops = self.stops();
        let t = t.clamp(0.0, 1.0);
        // Linear scan — `stops.len()` is single-digit; binary search
        // would only add branches without measurable benefit.
        for window in stops.windows(2) {
            let (t0, c0) = window[0];
            let (t1, c1) = window[1];
            if t <= t1 {
                let frac = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
                return [
                    lerp_u8(c0[0], c1[0], frac),
                    lerp_u8(c0[1], c1[1], frac),
                    lerp_u8(c0[2], c1[2], frac),
                ];
            }
        }
        // Unreachable: the last stop has `t = 1.0` and `t` is clamped
        // to `[0, 1]`, so the loop always returns. Falling through
        // would mean the const table is malformed.
        stops.last().expect("palette stops table is non-empty").1
    }
}

fn lerp_u8(a: u8, b: u8, t: f32) -> u8 {
    let a = f32::from(a);
    let b = f32::from(b);
    (a + (b - a) * t).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

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
    ];

    #[test]
    fn sample_at_zero_returns_first_stop_colour() {
        for &p in ALL_PALETTES {
            let expected = p.stops()[0].1;
            assert_eq!(p.sample(0.0), expected, "{p:?}");
        }
    }

    #[test]
    fn sample_at_one_returns_last_stop_colour() {
        for &p in ALL_PALETTES {
            let expected = p.stops().last().unwrap().1;
            assert_eq!(p.sample(1.0), expected, "{p:?}");
        }
    }

    #[test]
    fn sample_clamps_below_zero_to_first_stop() {
        for &p in ALL_PALETTES {
            assert_eq!(p.sample(-0.1), p.sample(0.0), "{p:?}");
            assert_eq!(p.sample(-1.0), p.sample(0.0), "{p:?}");
        }
    }

    #[test]
    fn sample_clamps_above_one_to_last_stop() {
        for &p in ALL_PALETTES {
            assert_eq!(p.sample(1.1), p.sample(1.0), "{p:?}");
            assert_eq!(p.sample(10.0), p.sample(1.0), "{p:?}");
        }
    }

    #[test]
    fn viridis_green_channel_is_non_decreasing() {
        // The Viridis identity: perceived brightness rises monotonically
        // from the deep-purple end to the yellow end. Green is the
        // dominant luminance channel, so verifying it never decreases
        // catches almost every accidental palette-table mis-paste.
        let samples: Vec<u8> = (0..=5)
            .map(|i| Palette::Viridis.sample(i as f32 * 0.2)[1])
            .collect();
        for w in samples.windows(2) {
            assert!(w[0] <= w[1], "green channel dropped: {} → {}", w[0], w[1]);
        }
    }

    #[test]
    fn cyclic_palettes_have_matching_endpoints() {
        // The cyclic palettes are used under `Cycled` normalisation,
        // where `t` wraps 1.0 → 0.0 every period. If their first and
        // last stop colours disagree, that wrap shows a hard seam — so
        // the endpoint match is a load-bearing contract, not cosmetics.
        for &p in &[
            Palette::Twilight,
            Palette::EarthAndSky,
            Palette::Rainbow,
            Palette::KaholLavan,
        ] {
            assert_eq!(p.sample(0.0), p.sample(1.0), "{p:?} endpoints differ");
        }
    }

    #[test]
    fn period_is_strictly_positive() {
        for &p in ALL_PALETTES {
            assert!(p.period() > 0.0, "{p:?}");
        }
    }
}
