# QA and test quiet flags

Automated checks must not call out. Two explicit flags do that. Neither flag sends a flight command, and neither flag turns Companion real on by itself. Real still needs both `COMPANION_MODE=real` and `JETSON_COMPANION_BASE_URL`.

## `VLC_QA`

Set to `1`, `true`, or `yes`.

- The server writes `<meta name="vlc-qa" content="1">`. The browser treats that meta like the test flag: no ElevenLabs speech, and no automatic work-link post while the page is loading.
- `window.__vlcAllowExternal = true` turns that quiet path off for the open page.
- `window.__vlcTestQuiet = true` forces quiet even when the metas are off.
- Fixture tracks in `VLC_VISION_MOCK_TRACKS` reach the mock. Vitest allows the same fixture. A normal run ignores it.
- Ask skips the model chain. A mock companion skips it too.
- `snapshotCompanionEnv` copies `VLC_QA`, `VLC_VISION_MOCK_TRACKS`, and `VLC_MOCK_CAM3_STREAM` into the companion service, so a spawned server sees the same values as the parent.

## `VLC_TEST`

Set to `1`, `true`, or `yes`. Vitest sets the same meta because `VITEST` is set.

- The server writes `<meta name="vlc-test" content="1">`.
- The browser uses the same quiet path as `VLC_QA`: no ElevenLabs speech, and no automatic work-link post on load.
- This flag does not enable fixture tracks and does not skip the model. Use `VLC_QA` for those.

## What stays loud

A page with both metas at `0`, and without `window.__vlcTestQuiet`, uses ElevenLabs when that path is configured and posts the saved work link on load.
