# UI layout contract — text fits its box

Visible text always stays inside its own box. This is an app-wide rule, not a home-screen exception.

## Rule

- No clipping. No ellipsis used to hide a value that does not fit.
- No text painting past the border of its box or its parent tile.
- Fit the text by layout: wrap (two lines where the tile allows; more only when two lines still overflow), a shorter Hebrew label, and a sensible min width.
- `font-size` uses `clamp(11px, …, …)`. The floor is 11px. Do not shrink text that is already at or above that floor.
- Do not set `overflow: hidden` on a text box to fake a fit.

## Assertion

Reuse `collectTextFitFailures` from `tests/text-fit-audit.mjs`.

For every visible element that owns a direct text node:

- `scrollWidth <= clientWidth` (1px slack for subpixel rounding)
- `scrollHeight <= clientHeight` (same slack)
- the border box lies inside the parent tile

The parent tile is `parentElement`. Fixed boxes are their own tile. Absolutely positioned boxes are checked against `offsetParent`. A scrollport may contain text in its scroll size; that text still has to fit its own box. Inline runs with no client box must keep their line boxes inside the parent tile.

Also reject sibling text boxes that overlap inside the horizon top bar, a data tile, the controller-status block, or the flight arm row.

## Flight horizon

The approved flight screen puts a near-square horizon in the right column. At rest the horizon instrument keeps `aspect-ratio: 1 / 1` and uses the column width, capped so the data tiles and the messages keep their minimum heights. Dragging the handle under the horizon sets an explicit height: dragging down grows the horizon (never under 112px) and releases the square lock, trading space with the tiles and then the messages. Dragging the handle under the tiles only trades tiles against messages and does not move the horizon. Neither region may extend past the column. It is not capped near 28 percent of the workspace. Speed, altitude, and heading stay on the instrument. Other horizon actions stay in the right-click menu. אפסו פריסה in the column menu restores the square.

Run it on every tab (הטסה, סטטוס מחשבים, פרמטרים, אופטיקה, תחקור) and the settings dialog, at every viewport in `tests/text-fit-matrix.test.mjs`, with live-like long values.

Camera picture containers keep a stable `data-camera-stage` of `cam0`, `cam1`, `cam3`, or `horizon`. The optics grid is three equal tiles; choosing a camera only highlights one. Camera and gimbal controls open from a right-click on that tile. Link path, RF port, baud, home, and RC live in the flight-screen chip menus. The header chip is status only.

## Do not

- Hide overflow, clip, or ellipsize to make a failing assertion pass.
- Drop the font below 11px.
- Change flight-command send paths, Companion apply, or live vehicle links while fixing layout.
