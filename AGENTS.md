# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
- Single Node.js/Express service: **Vision Landing Console** (Hebrew RTL SPA + JSON API). Entry point is `server.js`; it serves the browser UI from `public/` and mounts the API under `/api/*`.
- Local persistence is SQLite at `data/vision-landing.sqlite`, created automatically on first boot by `lib/db.mjs` (no external database, no Docker, no migration step to run).
- Native dependencies (`better-sqlite3`, `serialport`) install from prebuilt binaries during `npm install`; no manual toolchain step is needed on this VM.

### Running the app
- Dev server: `npm run dev` (runs `node --watch server.js`). Production-style: `npm start`. Default bind is `127.0.0.1:4010`; open `http://localhost:4010`.
- Standard scripts live in `package.json` (`test`, `test:smoke`, `bump`, `vendor:sync`, PM2 helpers). Prefer those over ad-hoc commands.
- `npm install` runs a `postinstall` that (a) installs a git pre-commit hook and (b) runs `vendor:sync`, which copies `three` + `es-module-shims` from `node_modules` into `public/vendor/` (git-ignored). The Sim Lab 3D tab needs `public/vendor/`, so if it is missing after a fresh checkout, run `npm run vendor:sync`.

### Tests / lint
- Unit tests: `npm test` (vitest, config in `vitest.config.mjs`, specs in `tests/`).
- As of this setup, 5 of 182 tests fail on a clean checkout (`advisor-actions`, `flight-engineer-sanitize`, `mavlink-parse-telemetry`). These are pre-existing code/test-assertion drift, not environment problems — do not treat them as caused by your setup.
- There is **no lint tooling** configured (no ESLint/Prettier/Biome config and no `lint` script). Do not invent one unless asked.
- `npm run test:smoke` (spawns the server + Playwright UI walkthrough) additionally requires `npx playwright install chromium` first.

### Non-obvious gotchas
- `GET /api/connections` returns HTTP 500 (`no such table: connections`) on a clean DB. This is a **pre-existing schema/code bug** (the `connections` table is never created in `lib/db.mjs`); the UI polls this endpoint so the browser console shows repeating 500s. It does not indicate a broken environment.
- Gemini AI features are optional: without `GEMINI_API_KEY` in a `.env` file, the advisor / flight-engineer / auto-config features are disabled (some `auto-config` tests log `GEMINI_API_KEY לא מוגדר`), but the core app and API run fine. `.env` is git-ignored; copy `.env.example` to `.env` to configure keys (`GEMINI_API_KEY`, `GITHUB_INGEST_SECRET`, ElevenLabs, etc.).
- The installed pre-commit hook auto-bumps `APP_VERSION` (and re-stages `version.js`, `package.json`, `package-lock.json`, `public/changelog.json`) whenever real source files are committed. Expect version files to change on your commits.
