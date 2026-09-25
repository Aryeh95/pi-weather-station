# Sweep — a NEXRAD radar kiosk

Sweep is a self-hosted, full-bleed **NEXRAD radar viewer** for an always-on
screen. It runs a small Node/Express server and a React + Leaflet client and
needs one API key (Mapbox, for the basemap). Everything radar-related comes
from free, keyless public sources.

It began as a fork of [thicla01/pi-weather-station](https://github.com/thicla01/pi-weather-station)
(itself a fork of [elewin/pi-weather-station](https://github.com/elewin/pi-weather-station))
and was stripped down in August 2026 from a forecast dashboard to a
radar-only display. Forecasting lives on a separate e-paper device; this
project is about seeing precipitation, storm cells and lightning around home
with the **age of every layer visible**.

It runs on any Linux desktop or a Raspberry Pi (the reference deployment is
a Surface Pro on Ubuntu), and on macOS in window mode. The repository and
the on-disk service names still carry the historical `pi-weather-*`
identifiers so existing installs keep updating; only the product name
changed.

| Platform | Auto-start | Kiosk mode |
|---|---|---|
| Raspberry Pi OS (Bullseye / Bookworm / Trixie) | systemd + labwc / wayfire / LXDE autostart | Chromium-family or Firefox |
| Debian / Ubuntu (incl. GNOME, snap-Firefox) | systemd + XDG `~/.config/autostart` | Chromium-family or Firefox |
| openSUSE Leap 16+ (KDE Plasma) | systemd + XDG `~/.config/autostart` | Chromium-family or Firefox |
| macOS | launchd | — (window mode) |

The kiosk browser is chosen interactively by `install.sh` (Chromium, Chrome,
Brave, Edge, or Firefox) and persisted in `~/.config/pi-weather-station/browser.conf`.

## On your phone

`app/` builds Sweep as an Android app that needs no server and no VPN: it
carries the same client plus the server's controllers and calls the public
radar upstreams directly. See [`docs/android-app.md`](docs/android-app.md).

A GitHub Actions workflow builds a **signed release APK on every push to
`master`** and publishes it to a GitHub Release tagged `app-v<version>`,
once the four signing secrets (`ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`)
are set on the repository. Without them the job logs a warning and builds
nothing; `cd app && npm run apk` still builds a debug APK locally.

## What it shows

**Two radar layers, blended by zoom level**

- **Composite mosaic** (Iowa Environmental Mesonet N0Q) at zoom ≤ 7 for
  wide-area situational awareness. Animated over IEM's fixed 5-minute offsets
  (11 frames, ~50 min), anchored on the composite time IEM publishes.
- **Single-site super-resolution** base reflectivity (N0B, 0.5° × 0.25 km, the
  product RadarScope shows by default) at zoom ≥ 9.
- Zoom 8 crossfades between them so there is no hard cutover.

**Which radar.** The single-site layer uses the **nearest NEXRAD** to the
home pin (ranked by distance from IEM's radar list, with NWS's office
assignment only as a fallback — the office boundary runs through east
Baltimore and used to flip radars for no visible reason). Pan or zoom into
a storm anywhere and the radar **follows the map view**, but only once the
view has left the home radar's reach (200 km), so looking across a bay
never switches sites. A **radar site picker** (dock toggle) draws a
RadarScope-style chip on every WSR-88D: tap one to pin the layer to that
radar, tap it again to go back to automatic. The same pin is editable as
"Radar site" in Settings.

**Raw radial rendering at high zoom.** The latest scan is decoded from the
public Level III archive and painted gate-by-gate on a canvas instead of
using IEM's pre-smoothed tiles. Measured in the running app: 116 distinct
colours vs 10 in the equivalent IEM tile over the same echo. Historical loop
frames are rendered the same way progressively, so the loop sharpens as
frames arrive.

**Four radar products** at high zoom, one dock button each, all through the
same raw-radial renderer and loop:

- **Reflectivity** (N0B) — the default.
- **Base velocity** (N0G): green toward the radar, red away, purple where
  the return is range-folded. Rotation and shear are what you switch to
  this for.
- **Precipitation type** — rain / snow / mix / hail per gate, from the
  radar's own dual-pol classifier (N0H) merged with the reflectivity
  intensity of the same scan; at low zoom the mosaic switches to NOAA's
  MRMS surface precipitation type, with its own history loop.
- **Correlation coefficient** (N0C), with a **tornado debris marker**: gates
  near a detected circulation that combine ≥ 30 dBZ with CC < 0.8 are
  flagged as a debris signature on the storm-track layer.

**Reflectivity palette.** RadarScope-style by default (light rain recedes
into white-grey, colour arrives with real precipitation) or the NWS
classic ramp — Settings → Advanced. The palette is applied to the raw
radial layer, to the IEM tiles (repainted pixel-exact through IEM's
published colour table) and to the legend together.

**Satellite overlay.** A dock button cycles **off → infrared → visible**
GOES-East imagery under the radar: infrared works day and night, visible
is the sharpest cloud picture in daylight. Tiles come from IEM's GOES-East
CONUS layers (5-minute scans, typically 5–8 minutes old on arrival) and the
image time gets its own row in the frame-age chip. A separate **radar
toggle** (eye button) hides every radar layer so the cloud deck, storm
tracks, lightning and alerts can be read on their own.

**Frame age for every layer.** A stack in the top-left spells out, in
minutes, how old the on-screen site scan, the mosaic composite, the storm
track product and the newest lightning flash are, each classed fresh
(< 6 min), aging (6–12 min) or stale (≥ 12 min). The thresholds encode
NEXRAD's irreducible latency: a volume scan takes 4–6 minutes to complete
before any product exists. If a poller stops refreshing, its row flags the
last good data rather than freezing silently.

**Loop / timeline.** 30-scan loop (~2–2.5 h, RadarScope's default length) at
high zoom; the mosaic's 11-frame grid at low zoom. Scrubber, play/pause and
speed control in the timeline bar.

**Clear-air noise filter**, three states from one dock button:

- **off** — every echo the radar reported;
- **dBZ floor** — hides returns below 15 dBZ on both the radial layer and
  the IEM tiles (filtered pixel-by-pixel against IEM's published colour
  table), removing the blue/green speckle of bugs, birds and dust;
- **dual-pol clean** (default) — additionally drops the gates the scan's
  own dual-pol classifier calls non-meteorological, applied server-side so
  the payload stays the same size. This is what handles the full-disc
  insect bloom that sits *above* 15 dBZ on warm nights, and it keeps
  classified light rain that a plain floor would have thrown away. Measured
  on the reported scan: 95.8 % of the speckle removed, 7 of 368 gates
  ≥ 40 dBZ lost (5 of them ground clutter).

**Storm tracks** (NEXRAD Level III STI, product 58): SCIT cell positions with
15/30/45/60-minute forecast tracks, plus **mesocyclone / TVS markers** from
the NMD product (141). Every cell carries its id, each forecast tick its
clock time, and cells whose forecast motion carries them within ~20 km of
home get an **arrival lead** ("≈ 2 h 27 min"). Tapping a cell opens a card
with heading, speed, arrival and **hail size from NOAA's MRMS MESH**
product, sampled at the cell; severe hail (≥ 1 in) also shows in the
always-on label. Off by default, dock toggle.

**Lightning** (GOES-19 GLM total lightning): age-faded flash markers over a
rolling 5-minute window, with a count in the legend. In-cloud flashes are
included, so storms show electrification before the first ground strike. Off
by default, dock toggle.

**Dock hints.** The kiosk dock is icons only; rest the mouse on a button, or
hold a finger on it, to see its description without triggering it.

**NWS severe-weather alerts.** Active alerts at the home point as a banner
(tornado / severe thunderstorm / flood tiers), plus an optional
**nearby-alerts overlay** that paints every warning polygon within a
configurable radius (10–100 km). Alert polygons are outline-only, matching
RadarScope. ECCC (Canada) alerts are also polled for locations in Canada.

**Kiosk comforts**

- Light / dark map styles with auto-switching on sunrise/sunset, plus a
  melatonin-friendly **night-red palette**.
- Opt-in two-stage **sleep mode / screensaver** (dimmed clock, then black with
  an anti-burn-in dot). **Every poller pauses** while the screensaver is up
  or the window is hidden, and resumes instantly on wake.
- Hardware **brightness control** (sysfs backlight or DDC/CI where available)
  and a **display-scale override** for panels whose EDID misreports size.
- **Favorite places** (up to 6) to jump the map around, and a **Recenter**
  button back to home.
- Localhost-only **debug panel** (uptime, heap, per-endpoint timings, service
  status, quota counters, security events, server log tail).
- **In-app updater** (`git pull` + `npm ci` + service restart) with pre-flight
  checks and a health dot that reports upstream service state.
- English, French and Spanish UI.

## Data sources

| Source | Used for | Key |
|---|---|---|
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) | N0Q mosaic tiles + composite time, N0B single-site tiles, frame-list JSON API, radar list for nearest-site resolution, N0Q colour table | none |
| `unidata-nexrad-level3` (public S3 bucket) | Raw N0B reflectivity, N0G velocity, N0H hydrometeor class and N0C correlation-coefficient radials; STI storm tracks; NMD mesocyclones | none |
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) GOES layers | GOES-East infrared and visible satellite tiles + per-channel valid time | none |
| `noaa-goes19` (public S3 bucket) | GLM lightning flashes | none |
| `noaa-mrms-pds` (public S3 bucket) | MRMS MESH hail size at each storm cell; MRMS precipitation type + rate for the low-zoom mosaic | none |
| [api.weather.gov](https://www.weather.gov/documentation/services-web-api) | Active alerts, zone geometry, radar-site fallback, the WSR-88D station list the site picker ships | none (User-Agent required) |
| [Environment Canada](https://api.weather.gc.ca/) | Alerts for Canadian locations | none |
| [Mapbox](https://www.mapbox.com/) | Basemap raster tiles | **required** |
| [LocationIQ](https://locationiq.com/) | Reverse geocoding for the place name | optional |
| [ipapi.co](https://ipapi.co/) | Default location when none is configured | none |

Radar tiles are fetched directly by the browser (they are public and keyless).
Everything else goes through the server for a shared cache, rate limiting and
the health panel. The Mapbox key never leaves the server.

> Mapbox meters raster tiles against a monthly free tier. A single always-on
> kiosk stays well inside it thanks to the server-side tile cache, but watch
> the `mapbox → tiles` counter in the debug panel if you run several screens.

## Setup

> **Node.js:** 22 is what CI and `install.sh` use; 18+ works.

Manual test run:

```bash
cp settings.example.json settings.json   # add your Mapbox key (and LocationIQ, optional)
npm install
cd client && npm install && npm run prod && cd ..
npm start
```

Then open `https://localhost:8443` and go full screen (`F11` in Chromium).

`settings.json` keys:

| Key | Required | Description |
|---|---|---|
| `mapApiKey` | yes | Mapbox access token |
| `reverseGeoApiKey` | no | LocationIQ token for the place name in the header |
| `startingLat` / `startingLon` | no | Home coordinates. Falls back to IP geolocation when absent |
| `radarSite` | no | Pin the single-site layer to one NEXRAD (`LWX` or `KLWX`). Empty = nearest radar. Also set by tapping a chip in the map's site picker |
| `favorites` | no | Managed from the UI (Places button) |
| `advanced` | no | Managed from the Settings panel (map styles, radar opacity, radar palette, sleep mode, nearby-alerts radius) |

The **Settings** panel is reachable from the gear button in the bottom dock.
On a fresh install with no Mapbox key the panel opens automatically.

> The server uses a self-signed certificate generated on first launch. Accept
> the browser warning once for `localhost`. To use your own certificate see
> [docs/ssl-custom-cert_en.md](docs/ssl-custom-cert_en.md); to trust the
> generated one on phones and laptops see
> [docs/pwa-trust-cert_en.md](docs/pwa-trust-cert_en.md).

## Running on startup

Three options live in `deploy/`. **Option 1 is recommended.**

> **Which display server am I using?**
> ```bash
> ps aux | grep -E 'labwc|wayfire|Xorg' | grep -v grep
> ```
> `labwc` → Wayland/labwc (Trixie) · `wayfire` → Wayland/wayfire (Bookworm) ·
> `Xorg` → X11 (Bullseye). GNOME / KDE desktops use the XDG autostart path.

### Option 1 — Automated installation (recommended)

```bash
git clone https://github.com/aryeh95/pi-weather-station.git
cd pi-weather-station
bash deploy/install.sh
```

The script:

- Checks for Node.js and offers to install Node 22 (nvm on Bullseye 32-bit,
  NodeSource elsewhere)
- Optionally writes `settings.json` from your keys
- Optionally enables remote access (see below) and the debug panel
- Runs `npm ci`. The client bundle ships pre-built in `client/dist/`, so the
  client only rebuilds with `--rebuild-client` or when `bundle.min.js` is missing
- Installs the systemd user service with logs at
  `~/.local/state/pi-weather-station/server.log` and a logrotate rule
- Optionally configures kiosk autostart for your display server, and offers
  to reboot

Each prompt shows its default in uppercase; Enter accepts it.

> `install.sh` still asks about a Tomorrow.io key and a Sense HAT in its
> optional phases. Both features were removed in August 2026. Leave those
> prompts empty / answer no. Cleaning up the script is tracked in
> [ROADMAP.md](ROADMAP.md).

### Option 2 — systemd (manual)

```bash
git clone https://github.com/aryeh95/pi-weather-station.git
cd pi-weather-station
cp deploy/pi-weather-server.service ~/.config/systemd/user/
npm install
cd client && npm install && npm run prod && cd ..
mkdir -p ~/.config/systemd/user/pi-weather-server.service.d
mkdir -p ~/.local/state/pi-weather-station
cat > ~/.config/systemd/user/pi-weather-server.service.d/override.conf << EOF
[Service]
StandardOutput=append:$HOME/.local/state/pi-weather-station/server.log
StandardError=append:$HOME/.local/state/pi-weather-station/server.log
EOF
# deploy/logrotate-weather-server is a template — substitute the placeholders:
sed -e '/^[[:space:]]*#/d' -e '/^$/d' \
    -e "s|__LOG_FILE__|$HOME/.local/state/pi-weather-station/server.log|" \
    -e "s|__USER__|$USER|" -e "s|__GROUP__|$(id -gn)|" \
    deploy/logrotate-weather-server | sudo tee /etc/logrotate.d/weather-server >/dev/null
systemctl --user daemon-reload
systemctl --user enable pi-weather-server
systemctl --user start pi-weather-server
loginctl enable-linger $USER
mkdir -p ~/.local/bin
cp deploy/start-server ~/.local/bin/start-server
chmod +x ~/.local/bin/start-server
```

> **Bullseye 32-bit with nvm:** systemd does not load the shell profile where
> nvm lives. Add a drop-in that sources it (replace `~/.config/nvm` with
> `~/.nvm` if that is where nvm is):
> ```bash
> cat > ~/.config/systemd/user/pi-weather-server.service.d/nvm.conf << 'EOF'
> [Service]
> ExecStart=
> ExecStart=/bin/bash -c '. $HOME/.config/nvm/nvm.sh && exec npm start'
> EOF
> systemctl --user daemon-reload
> ```

Then have your display server launch `start-server`. It waits for the server,
detects whether it came up on 8443 (HTTPS) or 8080 (HTTP), and launches the
configured browser in kiosk mode.

- **labwc** (Trixie): `cp deploy/autostart ~/.config/labwc/autostart`
- **wayfire** (Bookworm): add `start-server = start-server` under
  `[autostart]` in `~/.config/wayfire.ini`
- **X11/LXDE** (Bullseye):
  ```bash
  [ ! -f ~/.config/lxsession/LXDE-pi/autostart ] && \
    cp /etc/xdg/lxsession/LXDE-pi/autostart ~/.config/lxsession/LXDE-pi/autostart
  echo "@start-server" >> ~/.config/lxsession/LXDE-pi/autostart
  ```

Logs: `tail -f ~/.local/state/pi-weather-station/server.log`. Then `sudo reboot`.

### Option 3 — autostart script (without systemd)

```bash
mkdir -p ~/.local/bin
cp deploy/start-weather ~/.local/bin/start-weather
chmod +x ~/.local/bin/start-weather
# Generate the logrotate config from the template (see Option 2)
```

`start-weather` starts the server itself, waits for it, then launches the
browser. Call it from your compositor's autostart exactly as `start-server`
above (`start-weather &` for labwc, `weather = start-weather` for wayfire,
`@start-weather` for LXDE).

## Updating

The in-app updater handles `git pull`, `npm ci` and the service restart:

1. When new commits land on the default branch, the update icon in the bottom
   dock shows a red badge.
2. Tapping it opens a modal listing the new feat/fix commits with an
   **Update** button.
3. Update runs the upgrade and restarts the service; the kiosk reloads.

The check compares the checkout against its tracked remote branch with
local git (`git fetch`, then the commit range), so private forks work with
the credentials the checkout already has. It is cached 5 minutes on the
server and polled every 6 hours by the client; the debug panel's **Check
for update** button forces a fresh check. If the button never appears,
open `https://localhost:8443/api/update-check`: `updateAvailable: false`
with equal `localSha` / `latestSha` means there is nothing to pull on that
branch; `error: true` with an `errorMessage` means the fetch itself failed
(also logged in the server log).

## Uninstall

```bash
bash deploy/uninstall.sh
```

Removes the systemd service, `~/.local/bin/start-server`,
`~/.local/bin/start-weather` and the autostart entry, then asks whether to
also remove `settings.json` (kept by default), the TLS certificates (kept),
`node_modules` (removed) and the project directory (kept).

## Access from another machine

By default the server only accepts connections from `localhost`. With
`ALLOW_REMOTE=true`:

- All keyed upstream calls stay proxied through the server. Remote clients get
  masked booleans from `GET /settings`, never key values.
- Display preferences work from any device.
- Settings writes, brightness, display scale and the debug endpoint are
  **always localhost-only**. To change settings remotely, tunnel:
  ```bash
  ssh -L 8443:localhost:8443 user@<kiosk-ip>
  # then open https://localhost:8443
  ```

`install.sh` can enable remote access during setup, and
`deploy/toggle-remote.sh` flips it later (regenerating the certificate with
your LAN IP in the SAN). Manually, add a systemd drop-in:

```bash
mkdir -p ~/.config/systemd/user/pi-weather-server.service.d
cat > ~/.config/systemd/user/pi-weather-server.service.d/local.conf << 'EOF'
[Service]
Environment=ALLOW_REMOTE=true
EOF
systemctl --user daemon-reload
systemctl --user restart pi-weather-server
```

Or `ALLOW_REMOTE=true npm start`.

> **Certificate:** the server generates a self-signed root CA plus a leaf
> whose SAN covers `localhost`, `127.0.0.1`, every active LAN IPv4 and the
> hostname (and its `.local` variant). If the IP changes, the leaf is re-signed
> at the next restart with the same root, so devices that trust the CA stay
> trusted. `GET /api/cert.pem` serves the certificate for installing on phones.

## Debug panel

Available on the kiosk itself when `DEBUG=true` is set server-side. Shows:

- **Header** — version, git commit and branch, hardware model, OS, network
  URLs, connectivity and latency
- **Server KPIs** — uptime, heap / RSS, cache hit rate, per-endpoint response
  times (count, avg, min, max), CPU temperature and fan speed where exposed
- **Client KPIs** — page load time, live FPS, JS heap, per-endpoint summary of
  `/api/*` calls since page load
- **Services** — last HTTP status and last success for each upstream (IEM,
  NEXRAD Level III bucket, GOES GLM, NWS, ECCC, Mapbox, LocationIQ,
  ipapi.co, GitHub). `GET /api/health` summarises these
  into the green / yellow / red dot in the dock
- **Quotas** — hourly / daily / monthly request counters per service
- **Logs** — last 100 lines of the server log (see [docs/logs.md](docs/logs.md))
- **Security events** — blocked write attempts from remote clients
- **Vulnerability scan** — link to the repo's Dependabot PR list

The bug icon appears in the dock only with `DEBUG=true` and only from the
kiosk itself. `/api/debug` is localhost-only regardless of the flag.
`deploy/toggle-debug.sh` flips the flag without re-running the installer.

## Environment variables

Set in the systemd drop-in
(`~/.config/systemd/user/pi-weather-server.service.d/override.conf`) or
exported before `npm start`.

| Variable | Default | Description |
|---|:---:|---|
| `ALLOW_REMOTE` | `false` | Accept connections from other devices on the LAN |
| `DEBUG` | `false` | Enable the debug panel and `/api/debug` (both stay localhost-only) |
| `SKIP_CERT_AUTOGEN` | `false` | Use `server/cert.pem` / `server/key.pem` as-is and never regenerate them (see [docs/ssl-custom-cert_en.md](docs/ssl-custom-cert_en.md)) |

API keys and preferences live in `settings.json`, not in the environment.

## Documentation

- [`docs/api.md`](docs/api.md) — every HTTP endpoint the server exposes
- [`architecture.md`](architecture.md) — system view, server modules, radar
  data flow, deployment layout, decision records
- [`CLAUDE.md`](CLAUDE.md) — engineering notes from the radar rework:
  measurements, traps, and decisions (the MOVEMENT-is-a-FROM-direction
  finding, the tile-size measurements, the frame-discovery API)
- [`ROADMAP.md`](ROADMAP.md) — what is still open
- [`CHANGELOG.md`](CHANGELOG.md) — release notes (the pre-August-2026 entries
  describe the forecast dashboard this fork was cut from)
- [`docs/`](docs/) — index in [`docs/README.md`](docs/README.md):
  operational guides (logs, TLS, kiosk hardening, touchscreen
  troubleshooting) and design records for shipped features. Pre-rework
  documents are kept under [`docs/archive/`](docs/archive/).

## Contributors

- [@elewin](https://github.com/elewin) — original author of the Pi Weather Station this descends from
- [@thicla01](https://github.com/thicla01) — the forecast-dashboard fork
  (v2.x–v3.1) this radar viewer was cut from; the kiosk plumbing (installer,
  updater, TLS, brightness, display scale, sleep mode, alerts) is theirs
- [@aevans1987](https://github.com/aevans1987), [@dagent23](https://github.com/dagent23), [@klamer](https://github.com/klamer)
- [Claude Code](https://claude.ai/code) (Anthropic) — AI pair programmer

## License

The MIT License (MIT)

Copyright (c) 2020 Eric Lewin

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
