# Documentation index

Live documents for the radar kiosk. Anything describing the pre-August-2026
forecast dashboard lives in [`archive/`](archive/).

## Reference

- [`api.md`](api.md) — every HTTP endpoint, with sources, caches and errors
- [`../architecture.md`](../architecture.md) — system view, modules, data
  flows, decision records
- [`../CLAUDE.md`](../CLAUDE.md) — engineering notes from the radar rework
  (measurements, upstream quirks, traps)
- [`localization-glossary.md`](localization-glossary.md) — generated from the
  three locale files (`node tools/gen-localization-glossary.js`)

## Operating the kiosk

- [`logs.md`](logs.md) — where logs live on each platform
- [`pwa-trust-cert_en.md`](pwa-trust-cert_en.md) ([fr](pwa-trust-cert_fr.md),
  [es](pwa-trust-cert_es.md)) — trusting the kiosk's certificate on phones
  and laptops
- [`ssl-custom-cert_en.md`](ssl-custom-cert_en.md) ([fr](ssl-custom-cert_fr.md))
  — bringing your own certificate
- [`security-hardening.md`](security-hardening.md) — locking down a kiosk in
  a semi-public place
- [`troubleshooting-touchscreen.md`](troubleshooting-touchscreen.md) — the
  official Pi 7" panel

## Design records for shipped features

- [`favorite-locations-design.md`](favorite-locations-design.md) — the
  Places list (note: its weather-cache rationale predates the rework)
- [`display-scale-override-design.md`](display-scale-override-design.md) —
  the kiosk display-scale setting

## Research and plans B

- [`research-nws-hydro-and-gis-sources.md`](research-nws-hydro-and-gis-sources.md)
  — NWPS river gauges and US GIS sources (candidate feature)
- [`maptiler-cloud-plan-b.md`](maptiler-cloud-plan-b.md) — a basemap
  alternative if Mapbox raster pricing changes

## Working with Claude

- [`claude-request-template_en.md`](claude-request-template_en.md)
  ([fr](claude-request-template_fr.md), [es](claude-request-template_es.md))
