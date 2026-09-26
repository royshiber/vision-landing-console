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

Also reject sibling text boxes that overlap inside the horizon top bar, a data tile, or the controller-status block.

Run it on every tab (הטסה, סטטוס מחשבים, פרמטרים, תחקור) and the settings dialog, at every viewport in `tests/text-fit-matrix.test.mjs`, with live-like long values.

## Do not

- Hide overflow, clip, or ellipsize to make a failing assertion pass.
- Drop the font below 11px.
- Change flight-command send paths, Companion apply, or live vehicle links while fixing layout.
