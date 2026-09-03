# Contributing to Sweep

This is a personal hobbyist project, but pull requests and issue reports are
welcome.

---

## Getting started

```bash
git clone https://github.com/aryeh95/pi-weather-station.git
cd pi-weather-station
npm install
cd client && npm install && cd ..
cp settings.example.json settings.json
# edit settings.json: add your Mapbox key (LocationIQ optional)
npm start
```

The app is at `https://localhost:8443`. Accept the self-signed certificate
warning once.

To rebuild the client after frontend changes:

```bash
cd client && npm run prod
```

The compiled `client/dist/` is committed so kiosks update with a plain
`git pull` and never need a build toolchain. Rebuild and stage it in the
same commit as any `client/src` change; CI fails when the committed file
set does not match a fresh build.

---

## Project structure

- [`architecture.md`](architecture.md) — system view, server modules, radar
  data flow, deployment layout, decision records
- [`docs/api.md`](docs/api.md) — every HTTP endpoint
- [`CLAUDE.md`](CLAUDE.md) — engineering notes from the radar rework:
  measurements, upstream quirks, traps (read this before touching the radar
  pipeline)

---

## Tests

```bash
npm test                      # server suite, node --test
node --test test/foo.test.js  # one file
```

Server modules are tested directly. Pure client modules are covered through
**verbatim copies** inside test files, delimited by
`// ---------- start of verbatim copy from <path> ----------` markers;
`test/verbatimSync.test.js` compares each copy to its source and fails on
drift. When you change a copied client function, update the copy and, if
you add or remove declarations, the `EXPECTED_CHECK_COUNT` in that file.

Binary fixtures under `test/fixtures/` (a live N0B scan, an N0G scan, an
NMD product, a GLM file) keep the decode paths testable offline.

On Windows, `npm test`'s glob does not expand under PowerShell; pass the
files explicitly. Two `settingsCtrl` tests need POSIX `0600` and fail on
NTFS.

---

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/) prefixes are
welcome (`feat:`, `fix:`, `perf:`, `style:`, `docs:`, `chore:`,
`refactor:`) — the in-app updater uses them to badge the "What's new" list —
but plain-sentence subjects are fine and still count as updates. Explain
the *why* in the body.

---

## Code style

- **CSS**: CSS Modules, kebab-case class names in `.css`, camelCase in JSX
- **JSDoc**: every React component and exported helper has a JSDoc block
  with `@param` and `@returns`
- **PropTypes**: declared on every component that takes props (React 19 no
  longer validates them at runtime; they are documentation and a lint
  contract). No `defaultProps` — use destructuring defaults; a test guards
  this.
- **ESLint** runs inside the client build: `cd client && npm run prod` must
  finish with 0 errors. Warnings are tolerated but do not add new ones.

Key rules: `prefer-destructuring`, `react-hooks/exhaustive-deps` (justify
every disable inline), `no-empty-function`.

---

## Server conventions

- Every outbound `axios` call carries a `timeout`
- New endpoints are documented in [`docs/api.md`](docs/api.md) and recorded
  in the service journal (`recordServiceCall`) so the health dot sees them
- Security-relevant changes are reflected in [`SECURITY.md`](SECURITY.md)
- Public S3 bucket access goes through `server/nexradBucket.js`

---

## Pull requests

1. Branch from `master`.
2. Make the change; rebuild the client if `client/src` changed.
3. `npm test` and `cd client && npm run prod` both clean.
4. Open a pull request against `master` describing what changed and why.

---

## Reporting issues

Please include:

- OS and version (`cat /etc/os-release`), Node.js version
- Browser / Chromium version
- Relevant lines from `~/.local/state/pi-weather-station/server.log`
- The output of `https://localhost:8443/api/health` and, for update
  problems, `/api/update-check`
- Steps to reproduce
