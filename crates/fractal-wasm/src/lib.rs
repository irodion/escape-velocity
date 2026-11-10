//! `wasm-bindgen` binding layer over `fractal-core`.
//!
//! A deliberately thin pass-through (ADR-0005). All math lives in
//! `fractal-core`; this crate only flattens the `Complex64` newtype for
//! JS, validates inputs at the WASM↔JS boundary, surfaces typed enum
//! mirrors of the core's `Palette` / `NormalizationMode` so JS sees a
//! discriminant-checked enum surface instead of magic numbers, and
//! exposes a pointer + length handle to the RGBA output so the JS side
//! can build a typed-array view without copying.
//!
//! ## Buffer ownership
//!
//! This module owns the frame's iteration buffer and never hands JS a
//! pointer into it. [`compute_band`] fills it band by band and records which
//! frame it holds and how many rows are in; [`colorize`] and [`probe_pixel`]
//! read it in place, and only once every band of that frame has landed. So
//! the ADR-0002 fast path — a palette or normalisation change repaints the
//! cached buffer without iterating again — takes nothing from JS but the new
//! palette and mode, and a frame abandoned partway (superseded by a newer
//! view) leaves the buffer refusing reads until the next frame completes,
//! rather than relying on JS to forget a pointer that may have moved.
//!
//! The one pointer JS does get, [`colorize`]'s into the RGBA output, is valid
//! until the next `colorize`; the worker copies the bytes out immediately.

use std::cell::{Cell, RefCell};

use fractal_core::{
    Complex64, Field as CoreField, FractalKind as CoreFractalKind, FrameColoring,
    NormalizationMode as CoreMode, Palette as CorePalette, Region, Viewport as CoreViewport,
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
/// Nothing else in this binding is thread-aware: the parallelism is internal
/// to the core compute.
pub use wasm_bindgen_rayon::init_thread_pool;

thread_local! {
    /// The frame's per-pixel Field scalars, row-major. Filled by
    /// [`compute_band`]; read by [`colorize`] and [`probe_pixel`] only while
    /// [`FRAME`] says it is complete.
    static ITER_BUFFER: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static RGBA_BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// Which frame [`ITER_BUFFER`] holds and how far its bands have got;
    /// `None` before the first band.
    static FRAME: Cell<Option<Frame>> = const { Cell::new(None) };
    /// The frame colouring the last [`colorize`] painted with, cached so the
    /// pixel-inspector probe (E2, #95) reads one pixel without re-reducing the
    /// whole frame (the global family's `[min, max]`, Histogram's CDF) or
    /// rebuilding the palette LUT. Cleared whenever a new frame starts, so an
    /// entry always describes the buffer's current frame; the key pins it to
    /// the `(palette, mode)` it was built for, so a probe whose settings drift
    /// from the last paint rebuilds rather than reusing a stale colouring.
    static LAST_NORM: RefCell<Option<NormCache>> = const { RefCell::new(None) };
}

/// What a frame in [`ITER_BUFFER`] was computed from: everything a pixel's
/// value depends on. Two bands belong to one frame only if their keys agree,
/// and a new frame can reuse the last one's pixels (#170) only if its key
/// differs by nothing but a whole-pixel pan.
#[derive(Clone, Copy, Debug, PartialEq)]
struct FrameKey {
    viewport: CoreViewport,
    max_iter: u32,
    kind: CoreFractalKind,
    field: CoreField,
}

/// The frame [`ITER_BUFFER`] holds, recorded when its first band starts so
/// the reads need nothing from JS that could disagree with the buffer — not
/// its length, not its size, not the `max_iter` it was computed at.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    key: FrameKey,
    /// The pixels carried over from the previous frame by a pan (#170), which
    /// no band computes; [`Region::EMPTY`] for a frame computed in full.
    carried: Region,
    /// The viewport of the last frame computed in full, which a chain of pans
    /// started from: a pan is reused only while it stays on this frame's pixel
    /// grid, so the per-pan tolerance can't add up across pans (see
    /// `fractal_core::on_pixel_grid`).
    grid: CoreViewport,
    /// Rows `[0, rows_done)` are filled.
    rows_done: u32,
}

impl Frame {
    fn width(self) -> u32 {
        self.key.viewport.width
    }

    fn height(self) -> u32 {
        self.key.viewport.height
    }

    /// Whether every row is in — the only state [`colorize`] and
    /// [`probe_pixel`] read.
    fn is_complete(self) -> bool {
        self.rows_done == self.height()
    }
}

/// A whole-pixel pan `(dx, dy)`, as `fractal_core::whole_pixel_shift` returns it.
type PixelShift = (i64, i64);

/// The frame state after writing band `[y0, y1)` of the frame `key` over
/// `current`, or why that band may not be written. Alongside it, for a band
/// that starts a frame by panning the last one, the shift to apply to the
/// buffer first.
///
/// `y0 == 0` starts a new frame. If `current` is a complete frame and `key` is
/// it panned by whole pixels (same zoom, size, `max_iter`, family and Field;
/// see `fractal_core::whole_pixel_shift`), still on the pixel grid of the frame
/// its pans started from, the new frame carries the pixels the pan keeps in
/// view, and the buffer must be shifted by the returned `(dx, dy)`; otherwise
/// it abandons whatever the buffer held and becomes the new grid. Any other band
/// must continue the frame in progress exactly where the last band stopped,
/// with the same key: so the bands tile the buffer in order, a band can never
/// index past it, and a frame counts as complete only once every row has
/// actually been written.
fn next_frame(
    current: Option<Frame>,
    key: FrameKey,
    y0: u32,
    y1: u32,
) -> Result<(Frame, Option<PixelShift>), &'static str> {
    let (width, height) = (key.viewport.width, key.viewport.height);
    if y0 > y1 || y1 > height {
        return Err("compute_band: require y0 <= y1 <= viewport.height");
    }
    if y0 == 0 {
        let pan = current
            .filter(|frame| {
                frame.is_complete()
                    && frame.key.max_iter == key.max_iter
                    && frame.key.kind == key.kind
                    && frame.key.field == key.field
                    && fractal_core::on_pixel_grid(&frame.grid, &key.viewport)
            })
            .and_then(|frame| {
                fractal_core::whole_pixel_shift(&frame.key.viewport, &key.viewport)
                    .map(|shift| (frame.grid, shift))
            });
        let frame = match pan {
            Some((grid, (dx, dy))) => Frame {
                key,
                carried: Region::carried(width, height, dx, dy),
                grid,
                rows_done: y1,
            },
            None => Frame {
                key,
                carried: Region::EMPTY,
                grid: key.viewport,
                rows_done: y1,
            },
        };
        return Ok((frame, pan.map(|(_, shift)| shift)));
    }
    match current {
        Some(frame) if frame.key == key && frame.rows_done == y0 => Ok((
            Frame {
                rows_done: y1,
                ..frame
            },
            None,
        )),
        _ => Err(
            "compute_band: a band must continue the frame in progress (start each frame at y0 == 0)",
        ),
    }
}

/// The buffer's frame, if every one of its bands is in.
fn complete_frame() -> Option<Frame> {
    FRAME.get().filter(|frame| frame.is_complete())
}

/// The cached frame colouring plus the settings it was built for (see
/// [`LAST_NORM`]).
struct NormCache {
    palette: Palette,
    mode: NormalizationMode,
    coloring: FrameColoring,
}

impl NormCache {
    /// Whether this cache entry is valid for a probe against `(palette,
    /// mode)`. Palette matters because `Cycled`'s period is the palette's.
    fn matches(&self, palette: Palette, mode: NormalizationMode) -> bool {
        self.palette == palette && self.mode == mode
    }
}

/// Numeric discriminants are explicit so the JS↔WASM boundary stays
/// stable even if the variant order in `fractal-core` changes.
/// `wasm-bindgen` already rejects out-of-range integers at the binding
/// layer; no further boundary validation is needed inside the
/// `From` impls below.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    Phosphor = 15,
    Amber = 16,
}

#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
/// Both Fields are wired through the core and selectable in the UI:
/// [`Field::EscapeTime`] (the default) and [`Field::DistanceEstimate`]
/// (Mandelbrot #61, Julia #62).
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
            Palette::Phosphor => CorePalette::Phosphor,
            Palette::Amber => CorePalette::Amber,
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

    // Flat-primitive accessors. The main thread once read these five
    // scalars off its `Viewport` to post a render request (a wasm-bindgen
    // instance can't survive `postMessage`), and the worker rebuilt one
    // with the constructor. The main thread now keeps a TypeScript port
    // instead (ADR-0015), so the worker's constructor call is the app's
    // only use of this class. The methods and accessors stay as the
    // reference that port is tested against (`viewport-parity.test.ts`).

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

    /// The complex point the kernel samples for pixel `(px, py)`, as
    /// `[re, im]`: `fractal_core::Viewport::pixel_to_complex`, the exact
    /// projection `compute_band` uses. Not called by the app; it pins the
    /// TypeScript port's `pixelToComplex`, which the cursor picks project
    /// through, to the kernel (`viewport-parity.test.ts`).
    #[wasm_bindgen]
    pub fn pixel_to_complex(&self, px: u32, py: u32) -> Vec<f64> {
        let c = self.inner.pixel_to_complex(px, py);
        vec![c.re, c.im]
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

/// Compute one horizontal **band** — pixel rows `[y0, y1)` — of a frame
/// into the module's iteration buffer.
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
/// The **first** band of a frame (`y0 == 0`) starts a new frame: it clears
/// the buffer, resizes it to the whole frame (`width * height`) up front, and
/// drops the previous frame's cached colouring. Each band then writes directly
/// into its absolute slice `[y0 * width, y1 * width)` (no intermediate buffer,
/// no copy), and the frame is complete — readable by [`colorize`] and
/// [`probe_pixel`] — once the band ending at `height` lands. The caller MUST
/// start a frame at `y0 == 0` and walk a contiguous partition up to `height`
/// with one set of compute parameters; the worker's band planner does exactly
/// this, and a band that doesn't continue the frame in progress is rejected
/// (see `next_frame`).
///
/// ## Panned frames (#170)
///
/// When the new frame is the complete frame the buffer holds, panned by whole
/// pixels with nothing else changed, the first band shifts the buffer in place
/// instead of clearing it, and every band computes only the pixels the pan
/// exposed: whole rows at the top or bottom, a column strip at the side. The
/// bands, their order and the abort points are the same as for a fresh frame;
/// a frame abandoned partway is refused by every read as before, and the next
/// frame is computed in full. Carried pixels keep the value sampled at the old
/// frame's coordinates. A chain of pans stays anchored to the grid of the frame
/// it started from, so a carried pixel is within twice
/// `fractal_core::SHIFT_TOLERANCE_PX` (2% of a pixel) of a fresh compute's
/// sample, however many pans it survives (see `fractal_core`'s `frame_shift`
/// module).
///
/// `c_re` / `c_im` (for finiteness, via `core_fractal_kind`) and the band
/// range are validated at this WASM↔JS boundary. A rejected band changes
/// nothing: the buffer keeps whatever frame it held.
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
) -> Result<(), JsError> {
    let key = FrameKey {
        viewport: viewport.inner,
        max_iter,
        kind: core_fractal_kind("compute_band", kind, c_re, c_im)?,
        field: field.into(),
    };
    let (frame, shift) = next_frame(FRAME.get(), key, y0, y1).map_err(JsError::new)?;
    let (width, height) = (frame.width(), frame.height());
    let w = width as usize;
    // Record the band's rows as unfilled before touching the buffer, so a trap
    // partway through (an allocation failure in `resize` aborts) leaves the
    // frame incomplete — refused by every read — rather than still claiming
    // the frame the buffer held before.
    FRAME.set(Some(Frame {
        rows_done: y0,
        ..frame
    }));
    ITER_BUFFER.with(|cell| {
        let mut iters = cell.borrow_mut();
        if y0 == 0 {
            if let Some((dx, dy)) = shift {
                // A pan of the complete frame the buffer holds (#170): move its
                // pixels to where the new frame shows them. The bands below
                // compute only what the pan exposed.
                fractal_core::shift_in_place(&mut iters, width, height, dx, dy);
            } else {
                // Fresh frame: size the persistent buffer to the whole frame
                // once. `resize` zero-fills, but that single memset is far
                // cheaper than the per-band intermediate `Vec` + concatenating
                // copy the old `extend_from_slice(&compute_rows(..))` paid every
                // band — and it lets each band fill its slice in place below.
                // The allocation is reused across frames (capacity retained, P4
                // #80).
                iters.clear();
                iters.resize(w * (height as usize), 0.0);
            }
            // A new frame's values differ, so its colouring will too. A
            // re-render of the very same view (a zero shift) keeps them all.
            if shift != Some((0, 0)) {
                LAST_NORM.set(None);
            }
        }
        // Each band writes straight into its absolute slice `[y0*w, y1*w)` — no
        // intermediate buffer, no copy. `next_frame` has checked that the
        // slices tile the frame in order, so this never indexes past it. Only
        // the pixels the frame didn't carry over are computed: all of them for
        // a fresh frame.
        let band = &mut iters[(y0 as usize) * w..(y1 as usize) * w];
        for (ry0, ry1, x0, x1) in frame.carried.exposed(width, y0, y1) {
            let rows = &mut band[((ry0 - y0) as usize) * w..((ry1 - y0) as usize) * w];
            fractal_core::compute_region_into(
                &key.viewport,
                max_iter,
                key.kind,
                key.field,
                ry0,
                ry1,
                x0,
                x1,
                rows,
            );
        }
    });
    FRAME.set(Some(frame));
    Ok(())
}

/// Width in pixels of the complete frame in the iteration buffer — the size
/// of the image [`colorize`] paints — or `0` while there is none.
#[wasm_bindgen]
pub fn frame_width() -> u32 {
    complete_frame().map_or(0, Frame::width)
}

/// Height in pixels of the complete frame in the iteration buffer, or `0`
/// while there is none; see [`frame_width`].
#[wasm_bindgen]
pub fn frame_height() -> u32 {
    complete_frame().map_or(0, Frame::height)
}

/// Colorize the cached iteration buffer with the given palette and
/// normalisation mode, and return a pointer to the RGBA bytes in WASM
/// linear memory. JS pairs this with [`colorize_len`] to build a
/// `Uint8ClampedArray` view.
///
/// Callable any number of times per frame — the fast-path payoff of
/// ADR-0002: a palette or normalisation change repaints in milliseconds
/// because no iteration runs. Normalises against the `max_iter` the frame was
/// computed at. Errors while the buffer holds no complete frame (before the
/// first render, or after one was abandoned partway), so a partial frame can
/// never be painted.
#[wasm_bindgen]
pub fn colorize(palette: Palette, mode: NormalizationMode) -> Result<*const u8, JsError> {
    let frame = complete_frame()
        .ok_or_else(|| JsError::new("colorize: no complete frame to colour; render one first"))?;
    Ok(ITER_BUFFER.with(|iters| {
        let iters = iters.borrow();
        RGBA_BUFFER.with(|cell| {
            let mut buf = cell.borrow_mut();
            // Fill the persistent RGBA buffer in place (P4, #80): `colorize_into`
            // resizes it without clearing (every byte is overwritten), reusing the
            // prior frame's allocation instead of swapping in a fresh `Vec` (which
            // would free the old one and let wasm linear memory ratchet under
            // per-frame churn).
            let coloring = fractal_core::colorize_into(
                &iters,
                palette.into(),
                mode.into(),
                frame.key.max_iter,
                &mut buf,
            );
            // Stash the colouring so the inspector probe (E2, #95) reuses this
            // frame's global stats / CDF and palette LUT instead of rebuilding
            // them per hover.
            LAST_NORM.set(Some(NormCache {
                palette,
                mode,
                coloring,
            }));
            buf.as_ptr()
        })
    }))
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
/// `(x, y)` is a render-buffer pixel, clamped into the frame so an edge or
/// slightly stale coordinate (a hover from just before a resize) reads the
/// nearest pixel rather than failing. Returns `None` (`undefined` in JS)
/// while the buffer holds no complete frame — hover probes fire constantly,
/// so "nothing to read yet" is an answer, not an error. No recompute runs: the
/// frame colouring cached by the last [`colorize`] is reused when its
/// `(palette, mode)` still matches, and only rebuilt on a mismatch (e.g. a
/// probe arriving before the matching repaint).
#[wasm_bindgen]
pub fn probe_pixel(
    x: i32,
    y: i32,
    palette: Palette,
    mode: NormalizationMode,
) -> Option<ProbeResult> {
    let frame = complete_frame()?;
    let x = u32::try_from(x).unwrap_or(0).min(frame.width() - 1) as usize;
    let y = u32::try_from(y).unwrap_or(0).min(frame.height() - 1) as usize;
    let index = y * frame.width() as usize + x;
    let sample = ITER_BUFFER.with(|iters| {
        let iters = iters.borrow();
        LAST_NORM.with(|c| match c.borrow().as_ref() {
            Some(entry) if entry.matches(palette, mode) => {
                fractal_core::probe_value(&iters, index, &entry.coloring)
            }
            _ => {
                // No matching cached colouring (e.g. a probe raced ahead of the
                // repaint): rebuild it for this one read. Still correct, just not
                // O(1) for the global/Histogram modes.
                let coloring =
                    FrameColoring::build(&iters, palette.into(), mode.into(), frame.key.max_iter);
                fractal_core::probe_value(&iters, index, &coloring)
            }
        })
    });
    Some(ProbeResult {
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

// Native tests of the buffer-ownership rules. Only success paths cross the
// exports here: on a non-wasm target, building a `JsError` calls into JS and
// panics, so the refusals are asserted through `next_frame` / `complete_frame`
// and `probe_pixel`'s `None` instead. Each test starts from empty buffers
// because libtest runs every test on its own thread, and the buffers are
// thread-locals.
#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 4;
    const H: u32 = 3;
    const MAX_ITER: u32 = 64;

    fn key_at(re: f64, im: f64) -> FrameKey {
        FrameKey {
            viewport: CoreViewport::new(Complex64::new(re, im), 1.0, W, H),
            max_iter: MAX_ITER,
            kind: CoreFractalKind::Mandelbrot,
            field: CoreField::EscapeTime,
        }
    }

    fn key() -> FrameKey {
        key_at(-0.5, 0.0)
    }

    fn frame(rows_done: u32) -> Frame {
        Frame {
            key: key(),
            carried: Region::EMPTY,
            grid: key().viewport,
            rows_done,
        }
    }

    /// A band of the frame at `key()` panned by `(dx, dy)` pixels.
    fn panned_band(dx: f64, dy: f64, y0: u32, y1: u32) {
        let at = key().viewport.pan_by_pixels(dx, dy);
        let viewport =
            Viewport::new(at.center.re, at.center.im, at.zoom, W, H).expect("valid viewport");
        compute_band(
            &viewport,
            MAX_ITER,
            FractalKind::Mandelbrot,
            0.0,
            0.0,
            Field::EscapeTime,
            y0,
            y1,
        )
        .expect("band continues the frame");
    }

    fn band(y0: u32, y1: u32) {
        panned_band(0.0, 0.0, y0, y1);
    }

    /// The comparable parts of a probe (`raw` by bits: it is `NaN` inside).
    fn key_of(probe: ProbeResult) -> (u32, bool, [u8; 3]) {
        (
            probe.raw.to_bits(),
            probe.inside,
            [probe.r, probe.g, probe.b],
        )
    }

    fn probe(x: i32, y: i32) -> Option<ProbeResult> {
        probe_pixel(x, y, Palette::Viridis, NormalizationMode::Histogram)
    }

    #[test]
    fn a_frame_starts_at_row_zero_and_completes_at_its_height() {
        assert_eq!(next_frame(None, key(), 0, 1), Ok((frame(1), None)));
        assert!(!frame(1).is_complete());
        assert_eq!(
            next_frame(Some(frame(1)), key(), 1, H),
            Ok((frame(H), None))
        );
        assert!(frame(H).is_complete());
        // Row zero starts over, whatever the buffer held.
        assert_eq!(
            next_frame(Some(frame(2)), key(), 0, 1),
            Ok((frame(1), None))
        );
        let other = FrameKey {
            viewport: CoreViewport::new(Complex64::new(0.0, 0.0), 1.0, 8, 8),
            max_iter: 16,
            ..key()
        };
        assert_eq!(
            next_frame(Some(frame(H)), other, 0, 8),
            Ok((
                Frame {
                    key: other,
                    carried: Region::EMPTY,
                    grid: other.viewport,
                    rows_done: 8,
                },
                None
            )),
        );
    }

    #[test]
    fn a_band_that_does_not_continue_the_frame_is_rejected() {
        // No frame to continue.
        assert!(next_frame(None, key(), 1, 2).is_err());
        // A gap, and a repeat.
        assert!(next_frame(Some(frame(1)), key(), 2, H).is_err());
        assert!(next_frame(Some(frame(2)), key(), 1, 2).is_err());
        // Any other compute parameter mid-frame: size, `max_iter`, centre,
        // zoom, family or Field.
        let changed = [
            FrameKey {
                viewport: CoreViewport::new(Complex64::new(-0.5, 0.0), 1.0, W + 1, H),
                ..key()
            },
            FrameKey {
                max_iter: MAX_ITER + 1,
                ..key()
            },
            key_at(-0.4, 0.0),
            FrameKey {
                viewport: CoreViewport::new(Complex64::new(-0.5, 0.0), 2.0, W, H),
                ..key()
            },
            FrameKey {
                kind: CoreFractalKind::Julia {
                    c: Complex64::new(0.0, 0.0),
                },
                ..key()
            },
            FrameKey {
                field: CoreField::DistanceEstimate,
                ..key()
            },
        ];
        for other in changed {
            assert!(
                next_frame(Some(frame(1)), other, 1, 2).is_err(),
                "{other:?}"
            );
        }
        // A band outside the frame.
        assert!(next_frame(None, key(), 0, H + 1).is_err());
        assert!(next_frame(Some(frame(1)), key(), 2, 1).is_err());
    }

    #[test]
    fn a_whole_pixel_pan_of_a_complete_frame_carries_it_over() {
        let panned = |dx: f64, dy: f64| FrameKey {
            viewport: key().viewport.pan_by_pixels(dx, dy),
            ..key()
        };
        let (frame, shift) = next_frame(Some(frame(H)), panned(1.0, -1.0), 0, 1).expect("starts");
        assert_eq!(shift, Some((1, -1)));
        assert_eq!(frame.carried, Region::carried(W, H, 1, -1));
        // The continuing bands keep the carried region.
        // It stays anchored to the grid the first frame was computed on.
        assert_eq!(frame.grid, key().viewport);
        let (next, shift) = next_frame(Some(frame), panned(1.0, -1.0), 1, H).expect("continues");
        assert_eq!(
            (next.carried, next.grid, shift),
            (frame.carried, frame.grid, None)
        );
    }

    #[test]
    fn pans_that_drift_off_the_first_frame_s_grid_are_computed_in_full() {
        // Each step is within the per-pan tolerance of whole pixels; two are not.
        let step = 1.0 + 0.6 * fractal_core::SHIFT_TOLERANCE_PX;
        let once = FrameKey {
            viewport: key().viewport.pan_by_pixels(step, 0.0),
            ..key()
        };
        let twice = FrameKey {
            viewport: once.viewport.pan_by_pixels(step, 0.0),
            ..key()
        };
        let (first, shift) = next_frame(Some(frame(H)), once, 0, H).expect("starts");
        assert_eq!(shift, Some((1, 0)));
        let (second, shift) = next_frame(Some(first), twice, 0, H).expect("starts");
        assert_eq!(
            (second.carried, second.grid, shift),
            (Region::EMPTY, twice.viewport, None)
        );
    }

    #[test]
    fn re_rendering_the_same_view_keeps_its_colouring() {
        band(0, H);
        colorize(Palette::Viridis, NormalizationMode::Histogram).expect("frame is complete");
        band(0, H);
        assert!(LAST_NORM.with(|c| c.borrow().is_some()));
        // Any real pan drops it.
        panned_band(1.0, 0.0, 0, H);
        assert!(LAST_NORM.with(|c| c.borrow().is_none()));
    }

    #[test]
    fn a_pan_is_computed_in_full_unless_it_pans_a_complete_frame_and_nothing_else() {
        let pan = key().viewport.pan_by_pixels(1.0, 0.0);
        let full = |current: Frame, next: FrameKey| {
            let (frame, shift) = next_frame(Some(current), next, 0, 1).expect("starts");
            (frame.carried, shift) == (Region::EMPTY, None)
        };
        // An incomplete frame.
        assert!(full(
            frame(2),
            FrameKey {
                viewport: pan,
                ..key()
            }
        ));
        // A sub-pixel pan.
        let sub_pixel = key().viewport.pan_by_pixels(0.5, 0.0);
        assert!(full(
            frame(H),
            FrameKey {
                viewport: sub_pixel,
                ..key()
            }
        ));
        // A pan that also changes `max_iter`, the family or the Field.
        let changed = [
            FrameKey {
                viewport: pan,
                max_iter: MAX_ITER * 2,
                ..key()
            },
            FrameKey {
                viewport: pan,
                kind: CoreFractalKind::Julia {
                    c: Complex64::new(0.0, 0.0),
                },
                ..key()
            },
            FrameKey {
                viewport: pan,
                field: CoreField::DistanceEstimate,
                ..key()
            },
        ];
        for next in changed {
            assert!(full(frame(H), next), "{next:?}");
        }
    }

    #[test]
    fn a_panned_frame_carries_the_old_pixels_and_computes_the_exposed_ones() {
        band(0, H);
        let old = ITER_BUFFER.with(|cell| cell.borrow().clone());
        // Panned right by 1 and up by 1, in two bands.
        panned_band(1.0, -1.0, 0, 1);
        panned_band(1.0, -1.0, 1, H);
        assert!(complete_frame().is_some());
        let got = ITER_BUFFER.with(|cell| cell.borrow().clone());
        let at = key().viewport.pan_by_pixels(1.0, -1.0);
        let fresh = fractal_core::compute(
            &at,
            MAX_ITER,
            CoreFractalKind::Mandelbrot,
            CoreField::EscapeTime,
        );
        let carried = Region::carried(W, H, 1, -1);
        for y in 0..H {
            for x in 0..W {
                let i = (y * W + x) as usize;
                let expected = if (carried.x0..carried.x1).contains(&x)
                    && (carried.y0..carried.y1).contains(&y)
                {
                    old[((y + 1) * W + x - 1) as usize]
                } else {
                    fresh[i]
                };
                assert_eq!(got[i].to_bits(), expected.to_bits(), "({x}, {y})");
            }
        }
    }

    #[test]
    fn reads_wait_for_the_last_band() {
        assert!(probe(0, 0).is_none());
        assert_eq!((frame_width(), frame_height()), (0, 0));

        band(0, 1);
        assert!(complete_frame().is_none());
        assert!(probe(0, 0).is_none());
        assert_eq!((frame_width(), frame_height()), (0, 0));

        band(1, H);
        assert_eq!(complete_frame(), Some(frame(H)));
        assert_eq!((frame_width(), frame_height()), (W, H));
        colorize(Palette::Viridis, NormalizationMode::Histogram).expect("frame is complete");
        assert_eq!(colorize_len(), (W * H * 4) as usize);
        assert!(probe(0, 0).is_some());
    }

    #[test]
    fn an_abandoned_frame_refuses_reads_until_the_next_one_completes() {
        band(0, H);
        colorize(Palette::Viridis, NormalizationMode::Histogram).expect("frame is complete");

        // A newer view supersedes the next frame after its first band.
        panned_band(0.5, 0.0, 0, 1);
        assert!(complete_frame().is_none());
        assert!(probe(0, 0).is_none());
        assert!(LAST_NORM.with(|c| c.borrow().is_none()));

        panned_band(0.5, 0.0, 1, H);
        assert!(probe(0, 0).is_some());
    }

    #[test]
    fn a_probe_reads_the_pixel_colorize_painted_clamped_into_the_frame() {
        band(0, H);
        colorize(Palette::Viridis, NormalizationMode::Histogram).expect("frame is complete");
        let painted = RGBA_BUFFER.with(|cell| cell.borrow().clone());
        for y in 0..H {
            for x in 0..W {
                let i = ((y * W + x) * 4) as usize;
                let p = probe(x as i32, y as i32).expect("frame is complete");
                assert_eq!([p.r, p.g, p.b], painted[i..i + 3], "pixel ({x}, {y})");
            }
        }
        let corner = |x, y| key_of(probe(x, y).expect("frame is complete"));
        assert_eq!(corner(-5, -5), corner(0, 0));
        assert_eq!(corner(99, 99), corner(W as i32 - 1, H as i32 - 1));
    }
}
