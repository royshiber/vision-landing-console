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

The flight column uses one fixed layout per screen size. The horizon fills the space above the data tiles. From 1180px the tiles stay one instrument row. Below that they use an even grid so each label stays inside its tile. The Actions and Messages band has a fixed height for that screen, and the message list scrolls inside it. There is no drag handle and no saved proportion. Speed and altitude stay on the instrument. ARM and DISARM are small buttons on the horizon and never cover those tapes. The horizon right-click menu holds the camera source, the video display toggles, and the runway-awareness level group. Flight modes stay in the Actions tab. The runway tiles sit on the video and stay hidden while awareness is off, so the data row and the other tabs do not move.

Run it on every tab (הטסה, סטטוס מחשבים, פרמטרים, אופטיקה, תחקור) and the settings dialog, at every viewport in `tests/text-fit-matrix.test.mjs`, with live-like long values.

Camera picture containers keep a stable `data-camera-stage` of `cam0`, `cam1`, `cam3`, or `horizon`. The gimbal UI id is `cam3`; a saved `a8` is rewritten to `cam3` on read. Ask camera status includes that gimbal stream. The optics grid is three equal tiles that fill the panel; choosing a camera only highlights one. Camera and gimbal controls open from a page-level right-click menu on that tile. The flight column does not store a dragged height. The actions pane scrolls inside its fixed band. Link path, RF port, baud, home, and RC live in the flight-screen chip menus. The header chip is status only. The map follows the aircraft until a pan or the right-click follow toggle. The GPS chip tooltip shows only fields the flight controller sent.

## Do not

- Hide overflow, clip, or ellipsize to make a failing assertion pass.
- Drop the font below 11px.
- Change flight-command send paths, Companion apply, or live vehicle links while fixing layout.
