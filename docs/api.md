# Sweep — API Reference

*Current as of the September 2026 radar build.*

All endpoints are served by the Express server on port **8443 (HTTPS)**, or
**8080 (HTTP, loopback only)** when no certificate can be produced.
Endpoints prefixed with `/api/` are rate limited unless noted otherwise.

**Rate limits** (per connection socket peer — `req.socket.remoteAddress`,
not the header-spoofable `req.ip`):

- General `/api/*` JSON routes: **120 req / min**
- Map tiles (`/api/tiles/*`): **600 req / min**
- `/api/nearby-alerts` additionally caps a remote peer at **3 in-flight
  requests** (HTTP 429, `reason: "nearby-alerts-busy"`)

**Access levels:**

- 🌐 **Public** — any client (localhost, and remote when `ALLOW_REMOTE=true`)
- 🔒 **Localhost only** — the kiosk itself (`127.0.0.1` / `::1`), regardless
  of `ALLOW_REMOTE`

**Security response headers:** every response carries
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and `Content-Security-Policy: frame-ancestors
'none'`; `X-Powered-By` is suppressed. No HSTS (self-signed cert + HTTP
fallback) and no script/style CSP (the SPA uses runtime inline styles). See
`server/securityHeaders.js`.

Radar **tiles are not proxied**: the IEM mosaic and single-site tiles are
keyless and public, and Leaflet fetches them directly. Only JSON goes through
the server, which gives one shared cache, one rate limiter, and the health
panel one place to observe every upstream.

---

## Settings

### `GET /settings`

Returns the current settings.

- **Access:** 🌐 Public
- **Response (localhost):** the full settings object including API key values
- **Response (remote):** projected through the settings allow-list first
  (**default-deny** — any key not on the list is dropped), then API key
  fields are replaced by booleans (`true` if configured)

```json
// localhost
{ "mapApiKey": "pk.…", "reverseGeoApiKey": "pk.…", "startingLat": "39.95", "startingLon": "-75.16", "favorites": [ … ], "advanced": { … } }

// remote
{ "mapApiKey": true, "reverseGeoApiKey": false, "startingLat": "39.95", … }
```

### `POST /settings`

Creates or overwrites `settings.json`.

- **Access:** 🔒 Localhost only
- **Body:** JSON object with any subset of known keys (unknown keys are
  stripped)
- **Allow-listed top-level keys:** `mapApiKey`, `reverseGeoApiKey`,
  `startingLat`, `startingLon`, `favorites`, `advanced`. (The removed
  Tomorrow.io / Anthropic / AirNow / OpenAQ keys and the `indoorTemperature`
  block are still accepted for backward compatibility but nothing reads
  them.)
- **`advanced` sub-object** — opaque, grouped by feature area:
  - `advanced.display.lightModeStyle` (string) — Mapbox basemap style in
    light mode: `light-v10`, `light-v11`, `streets-v12` (default).
  - `advanced.display.darkModeStyle` (string) — `dark-v10` (default) or
    `dark-v11`.
  - `advanced.display.radarOpacityLight` / `radarOpacityDark` (number,
    0.05–1.0) — opacity of the radar layers over each basemap. Defaults 0.7
    / 0.3.
  - `advanced.alerts.radius` (number, km) — nearby-alerts survey radius,
    10–100.
  - `advanced.sleep.enabled` (boolean) — sleep mode / screensaver master
    toggle. Default `false`.
  - `advanced.sleep.stage1Delay` (minutes, default 10) — inactivity before
    the dimmed clock appears.
  - `advanced.sleep.stage1Brightness` (10–100, default 30) — hardware
    brightness during stage 1 where a backlight is exposed.
  - `advanced.sleep.stage2Enabled` (boolean, default `true`) and
    `advanced.sleep.stage2Delay` (minutes, default 20) — the black screen
    with the anti-burn-in dot, after a further delay.
  - `advanced.sleep.nightMode` (boolean, default `true`) — red-on-black
    stage-1 palette in dark mode.

### `PUT /settings`

Replaces `settings.json` entirely. 🔒 Localhost only. Same allow-list.

### `PATCH /setting`

Updates a single key.

- **Access:** 🔒 Localhost only
- **Body:** `{ "key": "<name>", "value": <value> }`
- **Errors:** HTTP 400 if the key is not allow-listed

#### `favorites`

Up to six places the kiosk can jump back to. Unlike `advanced`, this key
is **shape-validated** on both the write and the read path:

| Field | Rule |
|---|---|
| `id` | string, ≤ 64 chars; synthesised when missing |
| `label` | string, trimmed, 1..40 chars; an entry without one is dropped |
| `lat` / `lon` | −90..90 / −180..180, stored rounded to 4 decimals |
| `zoom` | optional integer 1..18 |

Malformed entries are dropped individually, the list is truncated to six,
`[]` clears it. Remote clients receive `favorites` unmasked, like
`startingLat` / `startingLon`.

### `DELETE /setting?key=<name>`

Removes one key. 🔒 Localhost only. HTTP 400 without `key`, 404 when absent.

---

## Geolocation

### `GET /geolocation`

Approximate location from the server's public IP (ipapi.co), used as the
default map centre when no coordinates are configured. Cached on disk
(`server/geolocation-cache.json`, 30-day TTL) with retry-with-backoff at
cold boot; a stale cache is served rather than a 500.

- **Access:** 🌐 Public
- **Response:** `{ "latitude": 39.95, "longitude": -75.16 }`

---

## Map tiles

### `GET /api/tiles/:style/:z/:x/:y`

Proxies Mapbox raster tiles so the key never reaches the browser.

- **Access:** 🌐 Public — 600 req/min
- **`style`:** `dark-v10`, `dark-v11`, `light-v10`, `light-v11`,
  `streets-v12`, `navigation-day-v1`, or a configured custom style
- **Errors:** HTTP 400 for an unknown style

---

## NEXRAD radar

### `GET /api/radar/site?lat=&lon=`

Resolves the NEXRAD site covering a coordinate.

- **Access:** 🌐 Public — rate limited
- **Source:** `api.weather.gov/points/{lat},{lon}` → `radarStation`
  (`KDIX`), normalised to IEM's 3-letter form (`DIX`). Falls back to IEM's
  `operation=available` (NEXRAD entries only, nearest first) when NWS is
  unreachable.
- **Cached:** 24 h per coordinate (rounded to ~1 km)

```json
{ "available": true, "site": "DIX", "name": null, "source": "nws" }
```

A location with no NEXRAD coverage returns HTTP 200 with
`{"available": false}` — the client stays on the mosaic layer.

### `GET /api/radar/frames`

The frame-list poller. Returns the actual volume-scan timestamps that build
`ridge::<site>-<product>-<stamp>` tile URLs, plus the composite mosaic's
current time.

Volume-scan times **cannot be computed**: a scan completes every 4–6 min
depending on the VCP, which changes with the weather, and a fabricated
timestamp returns HTTP 503 from IEM rather than a blank tile.

- **Access:** 🌐 Public — rate limited
- **Query params:**

| Parameter | Default | Description |
|---|---|---|
| `site` | — | 3- or 4-letter NEXRAD id. Omit to use `lat`/`lon` |
| `lat`, `lon` | — | Resolve the site first (one request on startup) |
| `product` | `N0B` | IEM product id. `N0B` = super-res base reflectivity |
| `count` | `30` | Most recent N frames (max 30) |

- **Sources:** `mesonet.agron.iastate.edu/json/radar.py?operation=list`
  (frames, cached 45 s per site+product) and
  `mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json`
  (mosaic time, cached 60 s)

```json
{
  "available": true,
  "site": "DIX",
  "product": "N0B",
  "frames": [
    { "stamp": "202609030251", "ts": "2026-09-03T02:51Z", "epoch": 1788403860000 }
  ],
  "generatedAt": "2026-09-03T02:58:00.000Z",
  "mosaic": { "valid": "2026-09-03T02:55:00Z", "epoch": 1788404100000, "radarQuorum": "142/147" }
}
```

`stamp` is the tile-URL segment; `epoch` drives the frame-age display.
Frames are oldest-first. `mosaic` is the nominal time of the current N0Q
composite; the client steps the `-m05m … -m50m` mosaic frames back from it
in exact 5-minute multiples, so the mosaic's age is measured rather than
assumed. It is `null` when the metadata fetch fails (the client falls back
to schedule-derived times marked approximate).

- **Errors:** HTTP 400 without `site` or valid `lat`/`lon`; HTTP 503 when IEM
  is unreachable — the client keeps its last good list flagged stale.

### `GET /api/radar/radial`

Raw super-res radial data behind the client-side canvas renderer — the
gate-level picture, not IEM's pre-smoothed raster of it.

- **Access:** 🌐 Public — rate limited
- **Query params:**

| Parameter | Default | Description |
|---|---|---|
| `site` | — | 3-letter NEXRAD id (required) |
| `product` | `N0B` | `N0B` super-res base reflectivity (product 153) or `N0G` super-res base velocity (product 154) |
| `stamp` | — | `YYYYMMDDHHMM` UTC frame stamp: the historical scan matching that IEM frame instead of the newest (sharp loop playback) |

- **Source:** `SSS_N0B_*` / `SSS_N0G_*` keys in the public
  `unidata-nexrad-level3` bucket, decoded through product-153 / 154 shims
  over `nexrad-level-3-data` (both share product 94's layout). Velocity
  files carry the same volume-scan timestamps as reflectivity, so the N0B
  frame stamps resolve N0G scans too.
- **Cached:** 60 s per site+product for the newest scan; historical scans
  30 min (immutable) / 2 min for a miss. Payload ~1.7 MB (N0B) / ~1.1 MB
  (N0G): base64 of 720 azimuth buckets × N range bins of raw byte levels.

```json
{
  "available": true,
  "site": "DIX",
  "product": "N0G",
  "kind": "velocity",
  "units": "m/s",
  "key": "DIX_N0G_2026_09_03_02_55_41",
  "scanTime": "2026-09-03T02:55:41.000Z",
  "radar": { "lat": 39.947, "lon": -74.411 },
  "elevationAngle": 0.5,
  "reservedLevels": 2,
  "scaling": { "min": -63.5, "increment": 0.5, "levels": 254 },
  "numBuckets": 720, "bucketDeg": 0.5,
  "numBins": 1200, "firstBinKm": 0, "binKm": 0.25,
  "bins": "<base64>"
}
```

Decode contract: level L ≥ 2 is `scaling.min + L × scaling.increment` in
`units`. Level 0 is below threshold. Level 1 is missing for reflectivity and
**range folded** for velocity (the renderer paints it purple). `binKm` is
0.25 by product spec — the packet's `rangeScale` is a display factor, not
the bin size. Reflectivity: 1840 bins = 460 km. Velocity: 1200 bins = 300 km.

- **Errors:** HTTP 400 on a bad `site`, `product` or `stamp`; HTTP 503 on
  upstream failure; `{"available": false}` (200) when no matching product
  exists — the client falls back to IEM tiles (reflectivity) or shows no
  site layer for that frame (velocity).

### `GET /api/storm-tracks?site=DIX`

NEXRAD Level III storm tracks (STI, product 58) and mesocyclone features
(NMD, product 141) for one radar.

- **Access:** 🌐 Public — rate limited
- **Source:** the public `unidata-nexrad-level3` bucket, listed over plain
  HTTPS. One product per volume scan.
- **Cached:** 60 s per site

```json
{
  "available": true,
  "site": "DIX",
  "scanTime": "2026-08-12T00:29:37.000Z",
  "radar": { "lat": 39.947, "lon": -74.411 },
  "cells": [
    {
      "id": "T3", "lat": 41.159, "lon": -72.603,
      "speedKt": 22, "movementFromDeg": 308, "isNew": false,
      "forecast": [ { "minutes": 15, "lat": 41.095, "lon": -72.504 } ],
      "track": [ { "lat": 41.159, "lon": -72.603 }, { "lat": 41.095, "lon": -72.504 } ]
    }
  ],
  "mesos": [ { "id": "M1", "stormId": "T3", "strengthRank": 5, "tvs": false, "lat": 41.1, "lon": -72.6 } ]
}
```

`track` is the ready-to-draw polyline (current position + forecasts).
**`movementFromDeg` is the direction the storm comes FROM** — never derive
a heading from it. A `NEW` cell has no motion: `track` is a single point.
The client's arrival estimate (StormTracks overlay) projects the home point
onto the track direction; the server does no arrival math.

- **Errors:** HTTP 400 on a bad `site`; HTTP 503 when the bucket is
  unreachable — the client keeps its last cells flagged stale.

### `GET /api/lightning?lat=&lon=&radiusKm=`

GOES-19 GLM total-lightning flashes in a rolling 5-minute window.

- **Access:** 🌐 Public — rate limited
- **Query params:** `lat`, `lon` (required); `radiusKm` (default 300, max 800)
- **Source:** `noaa-goes19` bucket (GOES-East), one ~320 KB HDF5 file per
  20 s, decoded in-process via `h5wasm`. A rolling per-file cache means each
  poll fetches only new files.
- **Cached:** 20 s per (lat, lon, radius)

```json
{ "available": true, "windowMinutes": 5, "count": 1679, "flashes": [[35.925, -84.239, 897]], "generatedAt": "2026-08-12T01:41:00.000Z" }
```

Each flash is `[lat, lon, ageSeconds]`, quality-filtered
(`flash_quality_flag === 0`). GLM resolution is ~8–14 km.

---

## Geocoding and solar

### `GET /api/reverse-geocode?lat=&lon=`

LocationIQ reverse geocoding for the place name in the header.

- **Access:** 🌐 Public — rate limited
- **Response:** LocationIQ JSON; **204** when the point has no address
  (ocean), which the client renders as bare coordinates.

### `GET /api/sunrise-sunset?lat=&lon=[&date=YYYY-MM-DD]`

sunrise-sunset.org times, used by auto dark-mode. The client passes its
local date so the returned times belong to the user's day. Strict regex on
`date`.

- **Access:** 🌐 Public — rate limited

---

## Severe weather alerts

### `GET /api/weather-alerts?lat=&lon=`

Active government alerts at a point, merged from every source whose
bounding box covers it: **NWS** (`api.weather.gov/alerts/active?point=`,
zone-only alerts enriched with real geometry from `affectedZones`, cached
24 h) and **ECCC** for Canada (`api.weather.gc.ca`, bbox-filtered). Both
sources cached 5 min; always returns 200 with an `alerts` array.

- **Access:** 🌐 Public — rate limited; `Cache-Control: public, max-age=300`
- **`showTest=1`** includes Test/Exercise alerts (`isTest`), honoured for
  **localhost only**

Each alert: `source`, `id`, `severity` (minor/moderate/severe/extreme,
watches capped at moderate), `tier` (yellow/orange/red), `eventType`,
`title_en`/`title_fr`, `description_en`/`description_fr`, `expiresAt`,
`areaDesc`, and `geometry` when the source provides one. Sorted by
descending severity, then descending expiry.

### `GET /api/nearby-alerts?lat=&lon=&radiusKm=`

Display-only radius survey: every active alert polygon within `radiusKm`
(default 50, clamped 10–100) of the point, for the map overlay. US alerts
are fetched by the state(s) the circle spans (`?area=XX`, point→state
cached 24 h) and culled to the circle with a hand-rolled
circle-intersects-polygon test; Canadian alerts reuse the ECCC feed.
Alerts with no resolvable polygon are counted in `residualCount`.

- **Access:** 🌐 Public — rate limited, plus the 3-in-flight per-peer cap
- **Response:** `{ "alerts": [ …with geometry ], "residualCount": 0, "radiusKm": 100 }`

---

## Update

### `GET /api/update-check`

Compares the checkout against its tracked remote branch (normally
`origin/master`) with local git — `git fetch` then `git log HEAD..origin/x`
— so private forks work with whatever credentials the checkout has. Cached
5 min server-side; the client polls every 6 h.

- **Access:** 🌐 Public — rate limited
- **Response:**

```json
{
  "updateAvailable": true,
  "latestVersion": "3.1.0",
  "latestSha": "34fc363",
  "localSha": "94b35e4",
  "upstream": "origin/master",
  "checkedAt": "2026-09-03T03:15:00.000Z",
  "commits": [ { "type": "feat", "message": "velocity mode" }, { "type": "update", "message": "plain-sentence subject" } ],
  "changedDeployFiles": [],
  "needsManualUpgrade": false,
  "platform": "linux",
  "isSystemd": true
}
```

`updateAvailable` is true when the SHAs differ **and** the range contains
at least one non-merge commit (any subject counts; conventional prefixes
only pick the badge type). When the check fails the payload carries
`error: true` and `errorMessage` (and the failure is logged) — a fetch
that cannot authenticate under systemd otherwise looks exactly like an
up-to-date kiosk.

### `GET|POST /api/update-check/force`

Same response, cache cleared first. 🔒 Localhost only.

### `POST /api/update`

Pulls the latest code, installs dependencies, restarts the service.

- **Access:** 🔒 Localhost only
- **Pre-flight (HTTP 409 with `reason`):** `detached-head`, `wrong-branch`
  (not on `master`), `local-changes`, `git-status-failed`,
  `update-in-progress`
- **Flow:** `git pull --ff-only` → `npm install --omit=dev --no-audit
  --no-fund` → scheduled restart. HTTP 500 with `reason: "pull-failed" |
  "npm-install-failed"` on error.
- **Success:** `{ "ok": true, "isSystemd": true }`

---

## Diagnostics and kiosk hardware

### `GET /api/is-local`

`{ "isLocal": true, "securityEnabled": true, "debugEnabled": false }` —
the client decides which controls to show from this. 🌐 Public.

### `GET /api/debug`, `/api/debug/cpu-temp`, `/api/debug/fan-speed`

Debug panel payloads: system info, KPIs, service call journal, quota
counters, security events, recent log lines; the two small routes are
polled every 5 s while the panel is open. 🔒 Localhost only (the button
additionally needs `DEBUG=true`).

### `GET /api/brightness` · `POST /api/brightness`

Screen brightness via sysfs backlight or `ed-ddc-server`. GET is 🌐 Public
(rate limited — a DDC read forks a ~150 ms process); POST is 🔒 Localhost
only. `{ "percent": 0-100, "allowOff"?: boolean }`; floors at `minPercent`
(10) unless `allowOff` (sleep mode stage 2). Errors: 400 invalid, 403
`no-write-permission` (udev rule missing), 503 `no-device`.

### `GET /api/display-scale` · `POST /api/display-scale`

Kiosk display-scale override (`DISPLAY_SCALE=` in
`~/.config/pi-weather-station/browser.conf`), applied on the next browser
relaunch. GET 🌐 Public; POST 🔒 Localhost only with
`{ "scale": "auto" | "off" | "1.25" | "1.5" | "1.75" | "2" }`.

### `POST /api/relaunch-kiosk`

Relaunches the kiosk browser (detached `deploy/relaunch-kiosk.sh`) so a new
display scale takes effect. Not a server restart. 🔒 Localhost only.

---

## Health

### `GET /api/health`

Aggregates the in-memory service journal into the dock's green / yellow /
red dot.

- **Access:** 🌐 Public — rate limited. Remote callers get internal
  host:port strings in comments redacted.
- **Response:** `{ "status": "green"|"yellow"|"red", "issues": [ { "service", "status", "comment", "critical" } ], "providerStatus": { "github": … }, "lastChecked" }`

**Critical** services (red when down): Mapbox, IEM (radar), NEXRAD L3
(radial), LocationIQ. Everything else (NWS / ECCC alerts, GLM lightning,
sunrise-sunset.org, ipapi.co, GitHub) is yellow. A failure counts only after
two consecutive failed calls with no success in the last 35 min; NWS and
ECCC suppress each other (only one covers any given point).

---

## Certificate

### `GET /api/cert.pem`

The server's self-signed certificate as `application/x-x509-ca-cert`
(download name `sweep-cert.pem`) for trusting the kiosk on phones and
laptops. 🌐 Public, not rate limited. See
[`pwa-trust-cert_en.md`](pwa-trust-cert_en.md).
