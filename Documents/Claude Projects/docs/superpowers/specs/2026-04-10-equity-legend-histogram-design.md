# Equity legend histogram + nonlinear contrast (design)

Date: 2026-04-10  
Project: `Urban-Service-Equity` static dashboard (`docs/`)

## Goal

Improve the bottom-right **Equity score legend** by:

- Adding a compact **distribution (histogram)** of equity scores so viewers can see the “big picture” at a glance.
- Making the map’s equity coloring **more visually separable in the 40–60 range**, where many scores cluster.

This must work on **GitHub Pages** (static hosting) with no client-side heavy computation beyond what’s already done in the browser.

## Non-goals

- No server-side rendering.
- No new build tooling / bundlers.
- No change to the pipeline outputs format (we reuse existing `docs/outputs/grid_points.geojson`).

## Current context

- Map points are loaded from `docs/outputs/grid_points.geojson`.
- Each feature has `properties.equity_score` (expected 0–100).
- The legend is rendered in `docs/assets/app.js` in `renderLegend()`.
- Equity colors are computed in `docs/assets/utils.js` via `equityColor(t)` where \(t \in [0,1]\).

## Chosen UX (approved)

- **Layout**: “Compact, stacks vertically” histogram **under** the equity ramp (fits the current bottom-right panel).
- **Color scaling**: **Nonlinear contrast** (S-curve) applied to normalized equity score so 40–60 spreads into more distinct colors while keeping 0–100 semantics.

## Design details

### A) Histogram in legend (stacked under ramp)

**Placement**

- In equity legend mode (not cluster mode), below the ramp and its 0/50/100 labels, show:
  - Label: “Equity distribution”
  - A small bar chart (inline histogram)
  - Optional tiny note: “n = …” (count of scored grid cells)

**Data source**

- Use the loaded GeoJSON (`geo`) and extract values:
  - `Number(f.properties?.equity_score)`
  - Keep only finite numbers
  - Clamp into [0, 100] for binning

**Binning**

- Fixed bins for consistency across sessions: **20 bins** spanning [0, 100]
  - Bin width = 5 points
  - Bin index: `Math.min(19, Math.floor(score / 5))`

**Rendering**

- Render as lightweight HTML (no Chart.js dependency) inside `els.legend`:
  - A flex row of bars, each bar height proportional to count in that bin
  - Bars neutral (e.g., muted gray) to avoid confusing “histogram color == map color”
  - Optional hover tooltip on each bar: “45–50: 123 cells” (simple `title` attribute)

**Update timing**

- Histogram renders after GeoJSON is loaded (in `init()` after `geo` is available).
- Legend re-renders on color mode changes and whenever new data is loaded (initial load only today).

**Edge cases**

- If there are 0 valid equity values: show “No equity scores found” instead of bars.
- If a bin is empty: bar height = 0.

### B) Nonlinear contrast for equity color mapping

**Problem**

- Linear mapping compresses the mid-range visually when the distribution is dense around 40–60.

**Approach**

- Convert score \(s \in [0,100]\) to \(x \in [0,1]\): \(x = s/100\).
- Apply a smooth S-curve to increase slope around the midpoint:

\[
f(x) = \frac{1}{1 + e^{-k(x - 0.5)}}
\]

- Normalize to keep endpoints pinned (so 0 stays 0 and 100 stays 1):

\[
g(x) = \frac{f(x) - f(0)}{f(1) - f(0)}
\]

- Use \(g(x)\) as the input to `equityColor(...)`.

**Parameter**

- Start with **k = 4** (moderate enhancement without making extremes too flat).
- Keep as a constant in `utils.js` so it’s easy to tweak later.

**Legend ramp consistency**

- The ramp is a visual hint; it should continue to match the mapping.
- Implementation option:
  - Use a CSS linear gradient with 6–9 stops computed from the palette at `t = g(x)` for evenly spaced `x` (0, 0.125, …, 1).
  - This avoids needing a canvas.

**Behavior**

- Only affects equity mode.
- Cluster mode unchanged.

## Implementation outline (high-level)

- `docs/assets/utils.js`
  - Add `contrastCurve(t)` and apply it inside `equityColor(...)` (or in the call site before `equityColor`).
  - Optionally add a helper for building legend gradient stops.
- `docs/assets/app.js`
  - Extend `renderLegend()` (equity mode) to include histogram container under ramp.
  - After loading `geo`, compute histogram bins and render them.
  - Re-render legend when `colorMode` changes (already happens) and ensure histogram stays visible in equity mode.

## Acceptance criteria

- On the dashboard, equity legend shows:
  - Ramp (0–100)
  - Histogram under it (20 bins)
- Map coloring shows **more visible differentiation** around 40–60 compared to the previous linear mapping.
- Works on local server and GitHub Pages without requiring visitors to run Python.

