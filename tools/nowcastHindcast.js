#!/usr/bin/env node
// Hindcast for the point nowcast: how often does "rain at the pin in
// L minutes" come true, and how well calibrated is the probability?
//
// Replays archived scans exactly as the live controller would have seen
// them: at each scan k, the nowcast from scans k−3..k is issued for a
// set of home points (chaining each pin's previous motion like the live
// path), and each lead's call is checked against the scan that actually
// arrived L minutes later. Reported per lead, for the ≥ 50 % call:
// probability of detection (POD), false-alarm ratio (FAR), critical
// success index (CSI), plus the Brier score of the probability itself
// and a reliability table, next to the persistence baseline ("it will be
// doing what it does now"), which any nowcast has to beat.
//
// Several feature configurations run in one process on the same fetched
// scans, so the gain of each piece can be read off directly.
//
// Usage:
//   node tools/nowcastHindcast.js SITE START END LAT LON [spreadDeg] [configs]
//   node tools/nowcastHindcast.js DIX 2026-09-27T14:00Z 2026-09-27T20:00Z 39.95 -75.17 0.3
//   configs: comma-separated names from CONFIGS below (default: all)
//
// The home points are a 3 × 3 grid, ±spreadDeg around LAT/LON, so one
// run yields nine independent-ish pins per scan. Scans are read once
// from the bucket (dual-pol cleaned like the live path); MRMS PrecipRate
// is fetched for each scan time when a file lies within 6 min.

const { listHourKeys } = require("../server/nexradBucket");
const { fetchRadialByKey } = require("../server/radarRadialCtrl");
const { keyNearest, fetchGrid } = require("../server/mrmsHailCtrl");
const { keyForEpoch } = require("../server/radarRadialCtrl");
const { parseCellRows, toGeoCell } = require("../server/stormTracksCtrl");
const parseLevel3 = require("nexrad-level-3-data");
const axios = require("axios");
const nc = require("../server/nowcastCtrl");

const LEADS = [15, 30, 45, 60];
const MATCH_TOLERANCE_MS = 3 * 60 * 1000;
// The 5-min window each lead stands for (see the truth definition below).
const WINDOW_MS = 5 * 60 * 1000;
const NUM_SCANS = 4;
const PROB_BINS = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.01];

// Feature configurations: DISABLED / ENABLED features plus MRMS mode and
// threshold. "default" is what the server ships (MRMS off).
const CONFIGS = {
  baseline: { disable: ["ensemble", "trend", "local", "mrms", "persist", "ptype"] },
  ensemble: { disable: ["trend", "local", "mrms", "persist", "ptype"] },
  "+trend": { disable: ["local", "mrms", "persist", "ptype"] },
  "+local": { disable: ["mrms", "persist", "ptype"] },
  default: { disable: ["ptype"] },
  "blend0.2": { disable: ["ptype"], enable: ["mrms"], mrmsMode: "blend", mrmsWet: 0.2 },
  "blend1.0": { disable: ["ptype"], enable: ["mrms"], mrmsMode: "blend", mrmsWet: 1.0 },
  "veto0.2": { disable: ["ptype"], enable: ["mrms"], mrmsMode: "veto", mrmsWet: 0.2 },
  "veto0.5": { disable: ["ptype"], enable: ["mrms"], mrmsMode: "veto", mrmsWet: 0.5 },
  "veto1.0": { disable: ["ptype"], enable: ["mrms"], mrmsMode: "veto", mrmsWet: 1.0 },
  "no-cells": { disable: ["ptype", "cells"] },
};
const DEFAULT_CONFIGS = ["baseline", "ensemble", "+trend", "+local", "no-cells", "default", "blend0.2", "blend1.0", "veto1.0", "veto0.5", "veto0.2"];
const L3_BASE = "https://unidata-nexrad-level3.s3.amazonaws.com";

/**
 * SCIT cells from the storm-track product nearest a scan time, parsed
 * exactly as stormTracksCtrl does live. Null when none within the window.
 *
 * @param {String} site
 * @param {Number} epoch
 * @returns {Promise<Array<Object>|null>}
 */
async function cellsAtEpoch(site, epoch) {
  const key = await keyForEpoch(site, "NST", epoch);
  if (!key) return null;
  const res = await axios.get(`${L3_BASE}/${key}`, { responseType: "arraybuffer", timeout: 15000 });
  const parsed = parseLevel3(Buffer.from(res.data));
  const pd = parsed && parsed.productDescription;
  if (!pd || !Number.isFinite(pd.latitude)) return null;
  const page = (parsed.tabular && parsed.tabular.pages && parsed.tabular.pages[0]) || [];
  return parseCellRows(page).map((r) => toGeoCell(r, pd.latitude, pd.longitude));
}

/**
 * Every N0B key for a site between two times, oldest first.
 *
 * @param {String} site
 * @param {Number} startMs
 * @param {Number} endMs
 * @returns {Promise<Array<String>>}
 */
async function keysBetween(site, startMs, endMs) {
  const keys = [];
  for (let t = startMs - 3600 * 1000; t <= endMs; t += 3600 * 1000) {
    // eslint-disable-next-line no-await-in-loop -- sequential hour listing
    keys.push(...(await listHourKeys(site, "N0B", new Date(t))));
  }
  return [...new Set(keys)].sort();
}

/**
 * Was it raining at the home in a scan? Same rule as the nowcast's own
 * series (a majority of the sampling footprint ≥ RAIN_DBZ).
 *
 * @param {Float32Array} grid projected scan
 * @returns {Boolean}
 */
function rainingAtHome(grid) {
  const s = nc.sampleGrid(grid, 0, 0);
  return Boolean(s && s.raining);
}

/**
 * Contingency-table scores.
 *
 * @param {{hit: Number, miss: Number, fa: Number, cn: Number}} c
 * @returns {{pod: Number|null, far: Number|null, csi: Number|null, n: Number}}
 */
function scores(c) {
  const pod = c.hit + c.miss ? c.hit / (c.hit + c.miss) : null;
  const far = c.hit + c.fa ? c.fa / (c.hit + c.fa) : null;
  const csi = c.hit + c.miss + c.fa ? c.hit / (c.hit + c.miss + c.fa) : null;
  return {
    pod, far, csi, n: c.hit + c.miss + c.fa + c.cn,
  };
}

/**
 * Fresh accumulator per lead.
 *
 * @returns {Object}
 */
function newTable() {
  const t = {};
  for (const L of LEADS) {
    t[L] = {
      hit: 0, miss: 0, fa: 0, cn: 0, brier: 0, n: 0, absErr: 0, both: 0,
      bins: PROB_BINS.slice(0, -1).map(() => ({ n: 0, obs: 0, sum: 0 })),
    };
  }
  return t;
}

async function main() {
  const [site, startIso, endIso, latStr, lonStr, spreadStr, configStr] = process.argv.slice(2);
  if (!site || !startIso || !endIso || !latStr || !lonStr) {
    console.error("usage: nowcastHindcast.js SITE START END LAT LON [spreadDeg] [configs]");
    process.exit(2);
  }
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const lat0 = parseFloat(latStr);
  const lon0 = parseFloat(lonStr);
  const spread = spreadStr ? parseFloat(spreadStr) : 0.3;
  const configNames = configStr ? configStr.split(",") : DEFAULT_CONFIGS;
  const homes = [];
  for (const di of [-1, 0, 1]) for (const dj of [-1, 0, 1]) homes.push({ lat: lat0 + di * spread, lon: lon0 + dj * spread });

  const keys = await keysBetween(site, startMs, endMs);
  console.error(`${keys.length} scans listed for ${site}`);
  const scans = [];
  for (const k of keys) {
    // eslint-disable-next-line no-await-in-loop -- one download at a time is kind to the bucket
    const p = await fetchRadialByKey(site, "N0B", k, true);
    if (p && p.available) scans.push(p);
    process.stderr.write(`\rfetched ${scans.length}/${keys.length}`);
  }
  process.stderr.write("\n");
  const epochs = scans.map((p) => Date.parse(p.scanTime));

  // MRMS rate per scan, projected per home right away so no CONUS field
  // stays resident. Missing files leave the entry null (radar-only).
  const rateGrids = scans.map(() => null);
  let mrmsFound = 0;
  for (let k = 0; k < scans.length; k += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential, one CONUS field at a time
      const key = await keyNearest(nc.MRMS_RATE_PRODUCT, epochs[k], nc.MRMS_MAX_SKEW_MS);
      if (!key) continue;
      // eslint-disable-next-line no-await-in-loop
      const rate = await fetchGrid(key, "hindcast-rate");
      rateGrids[k] = homes.map((home) => nc.projectMrmsGrid(rate, home));
      mrmsFound += 1;
    } catch (err) {
      process.stderr.write(`\nMRMS ${k}: ${err.message}\n`);
    }
    process.stderr.write(`\rMRMS ${mrmsFound}/${k + 1}`);
  }
  process.stderr.write("\n");

  // Contemporaneous calibration: how does "MRMS ≥ thr at the pin" line up
  // with "radar ≥ 15 dBZ at the pin" in the SAME scan? Decides the
  // surface threshold and whether the ground may raise a call.
  const thresholds = [0.2, 0.5, 1, 2, 4];
  const cal = thresholds.map(() => ({ both: 0, mrmsOnly: 0, radarOnly: 0, neither: 0 }));
  for (let h = 0; h < homes.length; h += 1) {
    for (let k = 0; k < scans.length; k += 1) {
      if (!rateGrids[k]) continue;
      const radarWet = rainingAtHome(nc.projectToGrid(scans[k], homes[h]));
      thresholds.forEach((thr, t) => {
        const r = nc.sampleRate(rateGrids[k][h], 0, 0, thr);
        const mrmsWet = Boolean(r && r.wet);
        if (radarWet && mrmsWet) cal[t].both += 1;
        else if (mrmsWet) cal[t].mrmsOnly += 1;
        else if (radarWet) cal[t].radarOnly += 1;
        else cal[t].neither += 1;
      });
    }
  }
  console.log("\nMRMS vs radar at the pin, same scan (P(radar wet | MRMS wet) / P(MRMS wet | radar wet)):");
  thresholds.forEach((thr, t) => {
    const c = cal[t];
    const pRadarGivenMrms = c.both + c.mrmsOnly ? c.both / (c.both + c.mrmsOnly) : null;
    const pMrmsGivenRadar = c.both + c.radarOnly ? c.both / (c.both + c.radarOnly) : null;
    console.log(`  ≥ ${thr} mm/h: ${pRadarGivenMrms == null ? "—" : `${(pRadarGivenMrms * 100).toFixed(0)} %`} / ${pMrmsGivenRadar == null ? "—" : `${(pMrmsGivenRadar * 100).toFixed(0)} %`}  (both ${c.both}, MRMS only ${c.mrmsOnly}, radar only ${c.radarOnly}, neither ${c.neither})`);
  });

  // Storm cells per scan (the nowcast folds on-track cells into its
  // ensemble); a scan with no product keeps null.
  const cellsByScan = [];
  let cellScans = 0;
  for (let k = 0; k < scans.length; k += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential small files
      const c = await cellsAtEpoch(site, epochs[k]);
      cellsByScan.push(c);
      if (c) cellScans += 1;
    } catch (err) {
      cellsByScan.push(null);
      process.stderr.write(`\nSTI ${k}: ${err.message}\n`);
    }
    process.stderr.write(`\rSTI ${cellScans}/${k + 1}`);
  }
  process.stderr.write("\n");

  const results = {};
  const t0 = Date.now();
  for (const name of configNames) {
    const cfg = CONFIGS[name];
    if (!cfg) {
      console.error(`unknown config ${name}`);
      continue;
    }
    const { disable } = cfg;
    const table = newTable();
    const persist = newTable();
    let issued = 0;
    let motionKnown = 0;
    let flips = 0;
    let flipPairs = 0;
    for (let h = 0; h < homes.length; h += 1) {
      const home = homes[h];
      const grids = scans.map((p) => nc.projectToGrid(p, home));
      let previous = null;
      let lastArrival = null;
      for (let k = NUM_SCANS - 1; k < scans.length; k += 1) {
        if (epochs[k] < startMs) continue;
        const window = scans.slice(k - NUM_SCANS + 1, k + 1);
        const fc = nc.nowcastFromScans(window, home, {
          disable, enable: cfg.enable, previous, rateGrid: rateGrids[k] ? rateGrids[k][h] : null, mrmsMode: cfg.mrmsMode, mrmsWet: cfg.mrmsWet, cells: cellsByScan[k],
        });
        issued += 1;
        if (fc.motion) {
          motionKnown += 1;
          previous = { vx: fc.motion.vx, vy: fc.motion.vy, epoch: epochs[k] };
        }
        // Headline stability: consecutive arrival calls (in absolute time)
        // that disagree by more than 15 min, or flip between rain / dry.
        const arrivalAbs = fc.arrival ? epochs[k] + fc.arrival.leadMin * 60000 : (fc.now.raining ? epochs[k] : null);
        if (lastArrival !== undefined && lastArrival !== null || arrivalAbs !== null) {
          if (lastArrival !== undefined) {
            flipPairs += 1;
            const both = lastArrival !== null && arrivalAbs !== null;
            if ((both && Math.abs(lastArrival - arrivalAbs) > 15 * 60000) || (!both && lastArrival !== arrivalAbs)) flips += 1;
          }
        }
        lastArrival = arrivalAbs;
        const nowRain = rainingAtHome(grids[k]);
        for (const L of LEADS) {
          // A step stands for the 5 minutes ending at L, so the truth is
          // "did rain cross the pin in any scan of that window" — the same
          // semantics the forecast has since the per-minute sampling.
          const target = epochs[k] + L * 60000;
          let best = -1;
          let actual = false;
          for (let m = k + 1; m < scans.length; m += 1) {
            const dt = epochs[m] - target;
            if (dt > -WINDOW_MS && dt <= MATCH_TOLERANCE_MS) {
              if (best < 0 || Math.abs(dt) < Math.abs(epochs[best] - target)) best = m;
              if (rainingAtHome(grids[m])) actual = true;
            }
          }
          if (best < 0) continue;
          const step = fc.series.find((s) => s.leadMin === L);
          const prob = step ? step.prob : 0;
          const predicted = prob >= nc.P_RAIN;
          const cell = table[L];
          if (predicted && actual) {
            cell.hit += 1;
            const s = nc.sampleGrid(grids[best], 0, 0);
            if (s && Number.isFinite(s.rainMean) && step.dbz != null) {
              cell.absErr += Math.abs(s.rainMean - step.dbz);
              cell.both += 1;
            }
          } else if (predicted) cell.fa += 1;
          else if (actual) cell.miss += 1;
          else cell.cn += 1;
          cell.brier += (prob - (actual ? 1 : 0)) ** 2;
          cell.n += 1;
          const bin = PROB_BINS.findIndex((lo, idx) => prob >= lo && prob < PROB_BINS[idx + 1]);
          if (bin >= 0) {
            cell.bins[bin].n += 1;
            cell.bins[bin].sum += prob;
            if (actual) cell.bins[bin].obs += 1;
          }
          const pc = persist[L];
          if (nowRain && actual) pc.hit += 1;
          else if (nowRain) pc.fa += 1;
          else if (actual) pc.miss += 1;
          else pc.cn += 1;
          pc.brier += ((nowRain ? 1 : 0) - (actual ? 1 : 0)) ** 2;
          pc.n += 1;
        }
      }
    }
    results[name] = {
      table, persist, issued, motionKnown, flipRate: flipPairs ? flips / flipPairs : null,
    };
  }

  const fmt = (v) => (v == null ? "  —  " : `${(v * 100).toFixed(0).padStart(3)} %`);
  const fmtB = (v) => (v == null ? "  —  " : v.toFixed(3));
  console.log(`\n${site} ${startIso} → ${endIso}, ${homes.length} homes, ${scans.length} scans, MRMS for ${mrmsFound}, STI for ${cellScans}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const first = results[configNames[0]];
  if (first) {
    console.log("\npersistence baseline (\"same as now\"):");
    console.log("lead   POD    FAR    CSI   Brier    n");
    for (const L of LEADS) {
      const p = scores(first.persist[L]);
      console.log(`${String(L).padStart(3)}   ${fmt(p.pod)}  ${fmt(p.far)}  ${fmt(p.csi)}  ${fmtB(first.persist[L].n ? first.persist[L].brier / first.persist[L].n : null)}  ${String(p.n).padStart(4)}`);
    }
  }
  for (const name of configNames) {
    const r = results[name];
    if (!r) continue;
    console.log(`\n== ${name} == (${r.issued} nowcasts, motion known ${r.motionKnown}, headline flip rate ${r.flipRate == null ? "—" : `${(r.flipRate * 100).toFixed(0)} %`})`);
    console.log("lead   POD    FAR    CSI   Brier    n   |dBZ err|");
    for (const L of LEADS) {
      const s = scores(r.table[L]);
      const c = r.table[L];
      const err = c.both ? c.absErr / c.both : null;
      console.log(`${String(L).padStart(3)}   ${fmt(s.pod)}  ${fmt(s.far)}  ${fmt(s.csi)}  ${fmtB(c.n ? c.brier / c.n : null)}  ${String(s.n).padStart(4)}   ${err == null ? "—" : `${err.toFixed(1)} dBZ`}`);
    }
  }
  const full = results.default || results[configNames[configNames.length - 1]];
  if (full) {
    console.log("\nreliability of the default configuration (forecast prob bin → observed frequency):");
    for (const L of [15, 30, 60]) {
      const row = full.table[L].bins.map((b, i) => `${PROB_BINS[i].toFixed(1)}-${Math.min(1, PROB_BINS[i + 1]).toFixed(1)}: ${b.n ? `${((b.obs / b.n) * 100).toFixed(0)}% (n=${b.n})` : "—"}`);
      console.log(`${String(L).padStart(3)} min  ${row.join("  ")}`);
    }
    const out = {
      measuredOn: new Date().toISOString().slice(0, 10), site, start: startIso, end: endIso, homes: homes.length, issued: full.issued, leads: {},
    };
    for (const L of LEADS) {
      const s = scores(full.table[L]);
      const p = scores(full.persist[L]);
      out.leads[L] = {
        leadMin: L,
        pod: s.pod,
        far: s.far,
        csi: s.csi,
        brier: full.table[L].n ? full.table[L].brier / full.table[L].n : null,
        n: s.n,
        persistence: { pod: p.pod, far: p.far, csi: p.csi },
      };
    }
    console.log(`\nHINDCAST block for server/nowcastCtrl.js:\n${JSON.stringify(out, null, 2)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
