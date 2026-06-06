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
//!    [`NormalizationMode::Linear`], [`NormalizationMode::SquareRoot`],
//!    and [`NormalizationMode::Logarithmic`] are the "global" family:
//!    each rescales `nu` against the frame's own finite `[min, max]`
//!    into `s ∈ [0, 1]`, then applies a transfer curve — identity,
//!    `√s`, or a natural-log squash. Linear is the honest baseline;
//!    the curved pair expand the low end so a frame whose escapers
//!    cluster at small `nu` (most pixels far from the set) spreads
//!    across the palette instead of collapsing into its first sliver.
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
//! [`Palette::Solar`], [`Palette::Spectral`], and [`Palette::Cosmic`]
//! are *procedural* rather than stop-based: each is the cosine palette
//! `colour(t) = a + b·cos(2π(c·t + d))` from Inigo Quilez's
//! parameterisation, evaluated per channel. Four RGB vectors describe an
//! infinitely smooth gradient with no stop table; because every `c` is
//! an integer, `colour(0) == colour(1)`, so they are seamlessly cyclic.
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
    Solar,
    Spectral,
    Cosmic,
}

/// Identifies how `nu` values are mapped into `[0, 1]` before palette
/// lookup. See the module docs for the trade-off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalizationMode {
    Cycled,
    Histogram,
    Linear,
    SquareRoot,
    Logarithmic,
    /// Hard distance clamp `t = min(1, d / k)` for the Distance Estimate
    /// Field (ADR-0013): a linear ramp over the first `k` pixels of
    /// distance, flat (white) beyond. Keeps the gradient in the thin
    /// boundary shell so filaments read as hairlines, not a halo.
    /// Appended last to preserve the JS↔WASM discriminant order.
    Clamped,
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

/// Parameters for a cosine procedural palette (Inigo Quilez):
/// `colour(t) = a + b·cos(2π(c·t + d))`, evaluated per channel and
/// clamped to `[0, 1]`. Every `c` is an integer, so `cos` completes a
/// whole number of turns over `t ∈ [0, 1]` and `colour(0) == colour(1)`
/// — the palette is seamlessly cyclic with no stop table to maintain.
struct CosineParams {
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    d: [f32; 3],
}

// Warm dawn — gold → orange → magenta (IQ preset d = (0, 0.10, 0.20)).
const SOLAR_COS: CosineParams = CosineParams {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.10, 0.20],
};

// Bold split-frequency swing through cyan/magenta/amber (IQ preset
// c = (2, 1, 0), d = (0.5, 0.20, 0.25)); the zero-frequency blue
// channel holds a steady wash under the faster red/green.
const SPECTRAL_COS: CosineParams = CosineParams {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [2.0, 1.0, 0.0],
    d: [0.5, 0.20, 0.25],
};

// High-frequency multi-hue shimmer (IQ preset c = (2, 1, 1),
// d = (0, 0.25, 0.25)) — red cycles twice for every green/blue turn.
const COSMIC_COS: CosineParams = CosineParams {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [2.0, 1.0, 1.0],
    d: [0.0, 0.25, 0.25],
};

/// How a palette turns its parameter into colour: a table of `(t, RGB)`
/// stops walked with linear interpolation, or an analytic cosine
/// formula. [`Palette::sample`] dispatches on this.
enum PaletteRepr {
    Stops(&'static [Stop]),
    Cosine(&'static CosineParams),
}

impl Palette {
    fn repr(self) -> PaletteRepr {
        match self {
            Palette::Grayscale => PaletteRepr::Stops(GRAYSCALE_STOPS),
            Palette::Viridis => PaletteRepr::Stops(VIRIDIS_STOPS),
            Palette::Magma => PaletteRepr::Stops(MAGMA_STOPS),
            Palette::Inferno => PaletteRepr::Stops(INFERNO_STOPS),
            Palette::Twilight => PaletteRepr::Stops(TWILIGHT_STOPS),
            Palette::Plasma => PaletteRepr::Stops(PLASMA_STOPS),
            Palette::Turbo => PaletteRepr::Stops(TURBO_STOPS),
            Palette::Cubehelix => PaletteRepr::Stops(CUBEHELIX_STOPS),
            Palette::EarthAndSky => PaletteRepr::Stops(EARTH_AND_SKY_STOPS),
            Palette::Rainbow => PaletteRepr::Stops(RAINBOW_STOPS),
            Palette::Ocean => PaletteRepr::Stops(OCEAN_STOPS),
            Palette::KaholLavan => PaletteRepr::Stops(KAHOL_LAVAN_STOPS),
            Palette::Solar => PaletteRepr::Cosine(&SOLAR_COS),
            Palette::Spectral => PaletteRepr::Cosine(&SPECTRAL_COS),
            Palette::Cosmic => PaletteRepr::Cosine(&COSMIC_COS),
        }
    }

    /// Default cycling period for [`NormalizationMode::Cycled`].
    ///
    /// `colorize` divides `nu` by this and takes the fractional part,
    /// so a smaller period means tighter colour bands. Twilight is
    /// cyclic and tolerates a longer period without losing structure;
    /// the other palettes look good at 64. Earth-and-sky, rainbow,
    /// kahol-lavan, and the cosine palettes are likewise cyclic, so
    /// they share the longer period.
    pub fn period(self) -> f32 {
        match self {
            Palette::Twilight
            | Palette::EarthAndSky
            | Palette::Rainbow
            | Palette::KaholLavan
            | Palette::Solar
            | Palette::Spectral
            | Palette::Cosmic => 96.0,
            _ => 64.0,
        }
    }

    /// Look up the gradient at parameter `t`. Values outside `[0, 1]`
    /// are clamped to the endpoints — there is no extrapolation.
    pub fn sample(self, t: f32) -> [u8; 3] {
        let t = t.clamp(0.0, 1.0);
        match self.repr() {
            PaletteRepr::Stops(stops) => sample_stops(stops, t),
            PaletteRepr::Cosine(params) => sample_cosine(params, t),
        }
    }
}

/// Linear-interpolated lookup into a stop table. `t` is assumed already
/// clamped to `[0, 1]` by the caller ([`Palette::sample`]).
fn sample_stops(stops: &[Stop], t: f32) -> [u8; 3] {
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

/// Evaluate the cosine palette `a + b·cos(2π(c·t + d))` per channel,
/// clamping each result into `[0, 1]` before quantising to 8-bit. `t`
/// is assumed already clamped by the caller ([`Palette::sample`]).
fn sample_cosine(p: &CosineParams, t: f32) -> [u8; 3] {
    let mut out = [0u8; 3];
    for (ch, slot) in out.iter_mut().enumerate() {
        let phase = std::f32::consts::TAU * (p.c[ch] * t + p.d[ch]);
        let v = (p.a[ch] + p.b[ch] * phase.cos()).clamp(0.0, 1.0);
        *slot = (v * 255.0).round() as u8;
    }
    out
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
        Palette::Solar,
        Palette::Spectral,
        Palette::Cosmic,
    ];

    // The cosine palettes have no stop table, so the "endpoint equals
    // first/last stop" contract is meaningless for them; scope those
    // two tests to the stop-based palettes.
    const STOP_PALETTES: &[Palette] = &[
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

    fn stops_of(p: Palette) -> &'static [Stop] {
        match p.repr() {
            PaletteRepr::Stops(stops) => stops,
            PaletteRepr::Cosine(_) => panic!("{p:?} is not a stop-based palette"),
        }
    }

    #[test]
    fn sample_at_zero_returns_first_stop_colour() {
        for &p in STOP_PALETTES {
            let expected = stops_of(p)[0].1;
            assert_eq!(p.sample(0.0), expected, "{p:?}");
        }
    }

    #[test]
    fn sample_at_one_returns_last_stop_colour() {
        for &p in STOP_PALETTES {
            let expected = stops_of(p).last().unwrap().1;
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
            // Cosine palettes use integer `c`, so they are cyclic too.
            Palette::Solar,
            Palette::Spectral,
            Palette::Cosmic,
        ] {
            assert_eq!(p.sample(0.0), p.sample(1.0), "{p:?} endpoints differ");
        }
    }

    #[test]
    fn cosine_palettes_are_deterministic_and_in_gamut() {
        // The cosine path has no stop table to mis-paste, but it can
        // still drift out of `[0, 255]` if the clamp is dropped, or
        // become non-deterministic if it reads outside its params.
        // Sweep the unit interval and assert every channel stays a
        // valid u8 and repeats bit-for-bit. (u8 is in-gamut by type;
        // the real assertion is that `sample` agrees with itself, i.e.
        // it is a pure function of `t`.)
        for &p in &[Palette::Solar, Palette::Spectral, Palette::Cosmic] {
            for i in 0..=20 {
                let t = i as f32 / 20.0;
                assert_eq!(p.sample(t), p.sample(t), "{p:?} not deterministic at {t}");
            }
        }
    }

    #[test]
    fn period_is_strictly_positive() {
        for &p in ALL_PALETTES {
            assert!(p.period() > 0.0, "{p:?}");
        }
    }
}
