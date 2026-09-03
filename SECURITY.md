# Security Policy

## Overview

Sweep runs on a trusted local network as an always-on kiosk. This document
describes the security model, the protections in place, and the boundaries
of the threat model.

---

## API key protection

The only keyed upstreams are **Mapbox** (basemap tiles) and **LocationIQ**
(reverse geocoding). Both are called by the Express server; the keys live in
`settings.json` on the host and never appear in client-side URLs.
Everything radar-related (IEM, the NEXRAD Level III and GOES buckets,
api.weather.gov, ECCC, sunrise-sunset.org, ipapi.co) is keyless.

Remote clients receive booleans (`true` / `false`) for key fields from
`GET /settings`; key values are returned only to `localhost`.

---

## Access control

| Endpoint | Localhost | Remote (`ALLOW_REMOTE=true`) |
|---|:---:|:---:|
| `GET /` — app UI | ✅ | ✅ |
| `GET /api/*` — radar, alerts, tiles, geocoding, health | ✅ | ✅ |
| `GET /settings` — keys masked to booleans | ✅ | ✅ (masked) |
| `POST / PUT / PATCH / DELETE /settings` | ✅ | ❌ always blocked |
| `POST /api/brightness`, `/api/display-scale`, `/api/relaunch-kiosk` | ✅ | ❌ always blocked |
| `POST /api/update`, `/api/update-check/force` | ✅ | ❌ always blocked |
| `GET /api/debug*` | ✅ | ❌ always blocked |

Localhost is decided from the **socket peer address**, never from `X-
Forwarded-For` or `req.ip`. There is no option to enable remote writes; use
an SSH tunnel:

```bash
ssh -L 8443:localhost:8443 user@<kiosk-ip>
# then open https://localhost:8443
```

---

## Remote access

Disabled by default. With `ALLOW_REMOTE=true`:

- keyed upstreams stay proxied; no key exposure
- writes, hardware controls, the updater and debug stay localhost-only
- rate limiting applies per socket peer: 120 req/min on JSON routes, 600
  req/min on map tiles, plus a 3-in-flight cap per remote peer on
  `/api/nearby-alerts` (which fans out to several NWS calls)
- `/api/health` redacts internal host:port strings for remote callers
- `showTest=1` on the alert endpoints is honoured for localhost only

---

## Transport security

HTTPS with a self-signed root CA and a leaf certificate generated on first
launch (`server/cert.pem`, `server/key.pem`, mode 0600). The leaf's SAN
covers `localhost`, `127.0.0.1`, every LAN IPv4 and the hostname; an IP
change re-signs the leaf under the same CA. `GET /api/cert.pem` serves the
certificate for trusting on other devices. `SKIP_CERT_AUTOGEN=true` uses
operator-supplied files. If no certificate can be produced the server falls
back to HTTP on the loopback interface only.

Security headers on every response: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Content-Security-Policy: frame-ancestors 'none'`; `X-Powered-By` removed.

---

## Settings file

`settings.json` is written atomically (temp file, fsync, rename), owned by
the service user with mode 0600, and validated against a default-deny
allow-list: `mapApiKey`, `reverseGeoApiKey`, `startingLat`, `startingLon`,
`favorites` (shape-validated), `advanced`. Legacy keys from the removed
forecast features are still accepted but unused. Unknown keys are stripped
(PUT/POST) or rejected with HTTP 400 (PATCH).

---

## Update flow

`POST /api/update` refuses to run on a detached HEAD, a branch other than
`master`, or a dirty working tree, runs `git pull --ff-only`, and rejects
concurrent invocations. `git fetch` uses whatever credentials the checkout
already has; no tokens are stored by the application.

---

## Security events

Blocked write attempts from remote clients are logged and listed in the
debug panel (localhost only, `DEBUG=true`).

---

## Threat model and boundaries

Designed for a **trusted home LAN**. Not hardened for the public internet:

- self-signed certificate (browser warning on first visit)
- no authentication for remote read access
- `settings.json` stores keys in plain text on the host

For a kiosk in a semi-public place see
[`docs/security-hardening.md`](docs/security-hardening.md) (USB lockdown,
virtual-terminal masking, outbound firewall, SSH hardening). If you expose
the server beyond your LAN, put an authenticating reverse proxy in front of
it.

---

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/aryeh95/pi-weather-station/issues)
with the label `security`, or contact the maintainer directly via GitHub
for sensitive disclosures.
