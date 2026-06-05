# Context: Escape Velocity

A glossary of the domain language. Implementation lives in the code; decisions
live in `docs/decisions/`. This file defines *terms* only.

## Terms

### Viewport
A rectangular window onto the complex plane: a `center`, a `zoom`, and pixel
`width`/`height`. Pixels are **square in the complex plane**, so the image is
never distorted; changing the canvas shape changes *how much of the set is
shown*, never the set's proportions.

### Zoom
Pure magnification — the count of complex-plane units per (reference) pixel.
The per-pixel scale is `(3.5 / 800) / zoom`, keyed to a **reference width of
800**, *not* to the actual buffer width. Consequence: a bigger window reveals
*more of the plane* in both axes (more pixels × fixed scale = wider window),
while `zoom` alone controls magnification. At 800 px wide the view is identical
to the project's historical convention. (Superseded the earlier "zoom fixes the
real-axis span at 3.5/zoom regardless of width" rule — see the ADR.)

### Render buffer
The off-screen pixel grid the worker computes and colourises — `width × height`
of iteration data turned into RGBA. Its size is the Viewport's `width`/`height`.

### Display surface
The on-screen size of the `<canvas>` element in CSS pixels. Historically pinned
to 800×600 and **decoupled** from the render buffer (resolution was a quality
knob, not a layout knob). The "fit-to-window" feature couples them: the display
surface becomes the available window area, and the render buffer is sized to
match it (modulo a quality factor).

### Fit-to-window
Sizing the render buffer to the available browser window so the image fills it
with **no distortion** — square pixels are preserved, so a larger or
differently-shaped window reveals *more or less of the complex plane* rather
than stretching the fractal. Contrast with CSS-stretching a fixed buffer, which
warps the image (non-square pixels).
