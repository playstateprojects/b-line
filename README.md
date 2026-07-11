# B-Line

A fluid, redraw-based digital inking experiment.

> Never erase. Always create.

B-Line treats a repeated stroke as a correction rather than a duplicate. Draw near an existing line and the older line yields strongly toward the new gesture, while the new gesture remains mostly under the pen.

## Prototype interactions

- Draw with a mouse, Wacom-style pen, or Apple Pencil in a supported browser.
- Pressure controls line width for pen input.
- Draw over a compatible line to correct it.
- Hold `Alt` or a pen barrel button to create an independent line.
- Scroll or pinch to zoom. Attraction distance stays constant in screen pixels.
- Pan with one finger, a middle mouse button, or `Space` while dragging.
- `Cmd/Ctrl + Z` undoes. `Cmd/Ctrl + Shift + Z` redoes.
- The current drawing and tuning values persist locally.

## Development

```bash
npm install
npm run dev
```

Before committing:

```bash
npm run check
npm run build
```

The static build is emitted to `build/` and can be deployed to Cloudflare Pages.

## Current limits

This is an interaction prototype, not a production drawing engine. Candidate matching and curve correspondence are intentionally simple and optimized for isolated contours. Intersections, dense hatching, line splitting, SVG export, and native iPad packaging are later experiments.
