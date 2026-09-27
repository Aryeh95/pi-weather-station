// Point nowcast: motion estimation, advection and the summary sentences,
// on synthetic fields where the answer is known.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const nc = require("../server/nowcastCtrl");

const {
  GRID_N, GRID_CELL_KM, RAIN_DBZ, LEAD_STEP_MIN, HORIZON_MIN,
} = nc;
const C = (GRID_N - 1) / 2;

/**
 * A dBZ grid with one rectangular rain blob.
 *
 * @param {Number} xKm blob centre east of home
 * @param {Number} yKm blob centre north of home
 * @param {Number} halfKm half-size
 * @param {Number} dbz intensity (a gentle gradient is added so NCC has texture)
 * @returns {Float32Array}
 */
function blob(xKm, yKm, halfKm, dbz) {
  const g = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  for (let i = 0; i < GRID_N; i += 1) {
    for (let j = 0; j < GRID_N; j += 1) {
      const x = (j - C) * GRID_CELL_KM;
      const y = (C - i) * GRID_CELL_KM;
      if (Math.abs(x - xKm) <= halfKm && Math.abs(y - yKm) <= halfKm) {
        g[i * GRID_N + j] = dbz + ((x - xKm) + 2 * (y - yKm)) / halfKm * 5;
      }
    }
  }
  return g;
}

test("categoryFor follows the dBZ tiers and rateForDbz is Marshall–Palmer", () => {
  assert.equal(nc.categoryFor(-Infinity), "none");
  assert.equal(nc.categoryFor(10), "none");
  assert.equal(nc.categoryFor(RAIN_DBZ), "light");
  assert.equal(nc.categoryFor(30), "moderate");
  assert.equal(nc.categoryFor(45), "heavy");
  assert.equal(nc.categoryFor(55), "intense");
  assert.equal(nc.rateForDbz(23), 1); // 23 dBZ ≡ 1 mm/h
  assert.equal(nc.rateForDbz(39), 10);
  assert.equal(nc.rateForDbz(NaN), 0);
});

test("estimateMotion recovers a known eastward drift from three baselines", () => {
  // 30 km east in 15 min = 2 km/min = 120 km/h... too fast for the cap;
  // use 12 km in 15 min = 0.8 km/min = 48 km/h, toward 090.
  const t0 = Date.UTC(2026, 8, 27, 12, 0, 0);
  const frames = [0, 5, 10, 15].map((m) => ({
    grid: blob(-40 + 0.8 * m, 10, 20, 30),
    epoch: t0 + m * 60000,
  }));
  const motion = nc.estimateMotion(frames);
  assert.ok(motion, "motion found");
  assert.ok(Math.abs(motion.speedKmh - 48) < 6, `speed ${motion.speedKmh}`);
  assert.ok(Math.abs(motion.towardDeg - 90) < 8, `toward ${motion.towardDeg}`);
  assert.ok(motion.ncc > 0.9, `ncc ${motion.ncc}`);
  assert.equal(motion.baselineMin, 15, "the longest baseline refines the answer");
});

test("estimateMotion is null with no echo and refuses a window-edge peak", () => {
  const t0 = Date.UTC(2026, 8, 27, 12, 0, 0);
  const empty = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  assert.equal(nc.estimateMotion([{ grid: empty, epoch: t0 }, { grid: empty, epoch: t0 + 300000 }]), null);
  // A blob that jumps 50 km in 5 min (600 km/h) is beyond MAX_SPEED: the
  // search window's best is on its edge and must not be trusted.
  const jump = [{ grid: blob(-30, 0, 15, 30), epoch: t0 }, { grid: blob(20, 0, 15, 30), epoch: t0 + 300000 }];
  const m = nc.estimateMotion(jump);
  assert.ok(!m || m.speedKmh < 200, `implausible motion accepted: ${m && m.speedKmh}`);
});

test("advectSeries + summarize: a blob 24 km upwind arrives in 30 min and ends when it has passed", () => {
  const motion = { vx: 0.8, vy: 0 }; // 48 km/h eastward
  // Blob from −36 to −20 km east: its leading edge is 20 km upstream →
  // reaches home at 25 min, trailing edge at 45 min.
  const grid = blob(-28, 0, 8, 35);
  const series = nc.advectSeries(grid, motion);
  assert.equal(series.length, HORIZON_MIN / LEAD_STEP_MIN + 1);
  const s = nc.summarize(series);
  assert.equal(s.now.raining, false);
  assert.ok(s.arrival && s.arrival.leadMin >= 20 && s.arrival.leadMin <= 30, `arrival ${JSON.stringify(s.arrival)}`);
  // The synthetic blob's gradient puts its leading edge at ~40 dBZ.
  assert.ok(["moderate", "heavy"].includes(s.arrival.category), s.arrival.category);
  assert.ok(s.end && s.end.leadMin >= 45 && s.end.leadMin <= 55, `end ${JSON.stringify(s.end)}`);
  assert.ok(s.peak && s.peak.dbz >= 30);
});

test("advectSeries shortens the horizon when the upstream point leaves the grid", () => {
  const grid = blob(0, 0, 5, 20);
  const fast = nc.advectSeries(grid, { vx: 1.9, vy: 0 }); // 114 km/h: off the 120 km grid after ~60 min
  assert.ok(fast.length < HORIZON_MIN / LEAD_STEP_MIN + 1);
  assert.equal(fast[fast.length - 1].leadMin, (fast.length - 1) * LEAD_STEP_MIN);
});

test("summarize: raining now with no end in sight reports no end", () => {
  const wide = blob(0, 0, 110, 25);
  const series = nc.advectSeries(wide, { vx: 0.3, vy: 0 });
  const s = nc.summarize(series);
  assert.equal(s.now.raining, true);
  assert.equal(s.arrival, null);
  assert.equal(s.end, null);
});

test("sampleGrid needs a majority of the footprint wet", () => {
  const g = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  g[C * GRID_N + C] = 40; // one hot cell
  const one = nc.sampleGrid(g, 0, 0);
  assert.equal(one.raining, false);
  assert.equal(one.max, 40);
  assert.equal(nc.sampleGrid(g, 500, 0), null, "outside the grid");
});

test("getNowcast validates its query", async () => {
  const res = () => {
    const r = { code: null, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  };
  let r = res();
  await nc.getNowcast({ query: { lat: "abc", lon: "-75" } }, r);
  assert.equal(r.code, 400);
  r = res();
  await nc.getNowcast({ query: { lat: "39.9", lon: "-75.1", site: "12" } }, r);
  assert.equal(r.code, 400);
});

test("HINDCAST carries measured skill for the leads the card quotes", () => {
  assert.ok(nc.HINDCAST.measuredOn);
  for (const lead of [15, 30, 45, 60]) {
    const row = nc.HINDCAST.leads[lead];
    assert.ok(row && row.pod > row.persistence.pod, `lead ${lead} must beat persistence`);
    assert.ok(row.csi > row.persistence.csi);
    assert.ok(row.far < 1 && row.far >= 0);
    assert.ok(row.brier < 0.25, "better than a coin toss");
  }
});

// ---- Ensemble, local field, trend, type, verification -----------------

test("ensembleMembers: weights sum to one, spread grows as the correlation weakens, previous vector joins", () => {
  const features = nc.featureSet();
  const sharp = nc.ensembleMembers({ vx: 0.8, vy: 0, ncc: 0.9 }, null, features, 1000);
  const loose = nc.ensembleMembers({ vx: 0.8, vy: 0, ncc: 0.5 }, null, features, 1000);
  const sum = (ms) => ms.reduce((a, m) => a + m.weight, 0);
  assert.ok(Math.abs(sum(sharp) - 1) < 1e-9);
  assert.equal(sharp.length, 25);
  const maxSpeed = (ms) => Math.max(...ms.map((m) => Math.abs(m.speedFactor - 1)));
  assert.ok(maxSpeed(loose) > maxSpeed(sharp));
  const withPrev = nc.ensembleMembers({ vx: 0.8, vy: 0, ncc: 0.9 }, { vx: 0.6, vy: 0.1, epoch: 1000 - 5 * 60000 }, features, 1000);
  assert.ok(withPrev.some((m) => m.previous));
  assert.ok(Math.abs(sum(withPrev) - 1) < 1e-9);
  const stale = nc.ensembleMembers({ vx: 0.8, vy: 0, ncc: 0.9 }, { vx: 0.6, vy: 0.1, epoch: 1000 - 40 * 60000 }, features, 1000);
  assert.ok(!stale.some((m) => m.previous), "a 40-min-old vector is not carried");
});

test("advectSeries with an ensemble yields fractional probabilities at a blob's edge", () => {
  const motion = { vx: 0.8, vy: 0, ncc: 0.6 };
  const grid = blob(-28, 0, 8, 35);
  const members = nc.ensembleMembers(motion, null, nc.featureSet(), 0);
  const series = nc.advectSeries(grid, motion, { members, features: nc.featureSet() });
  const probs = series.map((s) => s.prob);
  assert.ok(probs.some((p) => p > 0 && p < 1), `expected a fractional probability, got ${probs}`);
  assert.ok(probs.some((p) => p >= 0.5), "the blob still arrives");
  const s = nc.summarize(series);
  assert.ok(s.arrival && s.arrival.earliestMin <= s.arrival.leadMin);
  assert.ok(s.arrival.latestMin === null || s.arrival.latestMin >= s.arrival.leadMin);
});

test("estimateTrend reads growth and decay along the motion", () => {
  const t0 = Date.UTC(2026, 8, 27, 12, 0, 0);
  const grow = [0, 5, 10, 15].map((m) => ({ grid: blob(-40 + 0.8 * m, 10, 20, 25 + m * 0.6), epoch: t0 + m * 60000 }));
  const mg = nc.estimateMotion(grow);
  const tg = nc.estimateTrend(grow, mg);
  assert.ok(tg && tg.dbPerHour > 3, `growing: ${JSON.stringify(tg)}`);
  assert.equal(tg.label, "growing");
  const decay = [0, 5, 10, 15].map((m) => ({ grid: blob(-40 + 0.8 * m, 10, 20, 40 - m * 0.8), epoch: t0 + m * 60000 }));
  const md = nc.estimateMotion(decay);
  const td = nc.estimateTrend(decay, md);
  assert.ok(td && td.dbPerHour < -3, `decaying: ${JSON.stringify(td)}`);
  // A decaying echo is downgraded on arrival: the series' dBZ falls with lead.
  const members = nc.ensembleMembers(md, null, nc.featureSet(), t0);
  const withTrend = nc.advectSeries(decay[3].grid, md, { members, trend: td, features: nc.featureSet() });
  const without = nc.advectSeries(decay[3].grid, md, { members, trend: null, features: nc.featureSet() });
  const wet = withTrend.findIndex((s) => s.prob >= 0.5);
  assert.ok(wet >= 0);
  assert.ok(withTrend[wet].dbz < without[wet].dbz, "trend lowers the arriving intensity");
});

test("estimateLocalField returns nine vectors and falls back to the global one where there is no echo", () => {
  const t0 = Date.UTC(2026, 8, 27, 12, 0, 0);
  const frames = [0, 5, 10, 15].map((m) => ({ grid: blob(-40 + 0.8 * m, 10, 20, 30), epoch: t0 + m * 60000 }));
  const motion = nc.estimateMotion(frames);
  const field = nc.estimateLocalField(frames, motion);
  assert.equal(field.vectors.length, 9);
  assert.ok(field.vectors.some((v) => v.local), "the block holding the blob correlates");
  const fallback = field.vectors.find((v) => !v.local);
  assert.ok(fallback && fallback.vx === motion.vx && fallback.vy === motion.vy);
  const p = nc.upstreamPoint({ speedFactor: 1, dirOffsetDeg: 0, weight: 1, base: motion }, field, 30);
  assert.ok(p.x < -20 && Math.abs(p.y) < 5, `upstream ${JSON.stringify(p)}`);
});

test("projectClassGrid maps N0H codes to precipitation groups and advectSeries reports the type", () => {
  // A synthetic N0H: every gate "dry snow" (code 40).
  const numBuckets = 720;
  const numBins = 1200;
  const bins = Buffer.alloc(numBuckets * numBins, 40);
  const cls = {
    bins: bins.toString("base64"),
    radar: { lat: 39.95, lon: -75.17 },
    numBuckets,
    numBins,
    bucketDeg: 0.5,
    firstBinKm: 0,
    binKm: 0.25,
  };
  const home = { lat: 39.95, lon: -75.17 };
  const g = nc.projectClassGrid(cls, home);
  assert.equal(g[(GRID_N * GRID_N - 1) / 2], 2, "group 2 = snow at the centre");
  const wide = blob(0, 0, 110, 25);
  const series = nc.advectSeries(wide, { vx: 0.3, vy: 0 }, { classGrid: g, features: nc.featureSet() });
  assert.equal(series[0].ptype, "snow");
});

test("projectMrmsGrid samples the 0.01° field at the home grid and MRMS halves the probability when it disagrees", () => {
  // A tiny MRMS grid: 4° × 4° around the home, all wet (5 mm/h) — 16-bit
  // packing ref −30, dec 1: sample = rate*10 + 30.
  const ni = 400;
  const nj = 400;
  const samples = new Uint16Array(ni * nj).fill(5 * 10 + 30);
  const rate = {
    g: {
      ni, nj, lat0: 42, lon0: 360 - 77, dLat: 0.01, dLon: 0.01, ref: -30, binScale: 0, decScale: 1,
    },
    samples,
  };
  const home = { lat: 40, lon: -75 };
  const rg = nc.projectMrmsGrid(rate, home);
  assert.ok(Math.abs(rg[(GRID_N * GRID_N - 1) / 2] - 5) < 1e-3);
  // Radar dry everywhere but MRMS wet: in the default VETO mode the ground
  // can only lower a call, never raise one; "blend" averages the two.
  const dry = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  const mrmsOn = nc.featureSet([], ["mrms"]);
  assert.equal(nc.featureSet().mrms, false, "MRMS is off by default");
  const series = nc.advectSeries(dry, { vx: 0.3, vy: 0 }, { rateGrid: rg, features: mrmsOn });
  assert.equal(series[0].probRadar, 0);
  assert.equal(series[0].probMrms, 1);
  assert.equal(series[0].prob, 0);
  const blend = nc.advectSeries(dry, { vx: 0.3, vy: 0 }, { rateGrid: rg, features: mrmsOn, mrmsMode: "blend" });
  assert.equal(blend[0].prob, 0.5);
  // Radar wet but the ground dry: the veto halves the probability.
  const wet = blob(0, 0, 110, 25);
  const dryGround = new Float32Array(GRID_N * GRID_N);
  const vetoed = nc.advectSeries(wet, { vx: 0.3, vy: 0 }, { rateGrid: dryGround, features: mrmsOn });
  assert.equal(vetoed[0].probRadar, 1);
  assert.equal(vetoed[0].prob, 0.5);
  const off = nc.advectSeries(wet, { vx: 0.3, vy: 0 }, { rateGrid: dryGround, features: nc.featureSet() });
  assert.equal(off[0].prob, 1);
});

test("verifyAndRecord scores a pending forecast when its verifying scan arrives", () => {
  const key = `test:${Math.random()}`;
  const wet = blob(0, 0, 110, 25);
  const dry = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  const series = (p) => [15, 30, 60].map((L) => ({ leadMin: L, prob: p }));
  const t0 = Date.UTC(2026, 8, 27, 12, 0, 0);
  let skill = nc.verifyAndRecord(key, t0, dry, series(0.8));
  assert.equal(skill.leads[15].n, 0);
  skill = nc.verifyAndRecord(key, t0 + 15 * 60000 + 30000, wet, series(0.1));
  assert.equal(skill.leads[15].n, 1);
  assert.equal(skill.leads[15].hit, 1);
  assert.equal(skill.leads[30].n, 0);
  skill = nc.verifyAndRecord(key, t0 + 30 * 60000, dry, series(0.1));
  assert.equal(skill.leads[30].falseAlarm, 1, "the 0.8 call at 30 min verified dry");
  assert.equal(skill.leads[15].n, 2, "the 15-min lead of the second forecast (0.1) verified as a correct negative");
  assert.equal(skill.leads[15].correctNegative, 1);
  assert.ok(skill.leads[30].brier > 0.6);
});

test("a small fast shower that crosses the pin between two 5-min steps still counts for its step", () => {
  // 2 km blob centred 2.5 km upstream, moving at 1 km/min: over the pin
  // at t ≈ 1–4 min, gone before the +5 mark.
  const grid = blob(-2.5, 0, 1, 25);
  const motion = { vx: 1, vy: 0 };
  const series = nc.advectSeries(grid, motion, { features: nc.featureSet() });
  assert.equal(series[0].prob, 0, "not over the pin at scan time");
  assert.equal(series[1].prob, 1, "crosses the pin inside the first 5-min window");
  assert.equal(series[2].prob, 0, "gone by +10");
  assert.equal(nc.summarize(series).arrival.leadMin, 5);
  // Sampled only AT the 5-min marks it was invisible: at t = 5 the parcel
  // sits 5 km upstream, past the blob's far edge.
  assert.equal(nc.sampleGrid(grid, -5, 0).raining, false);
  assert.equal(nc.sampleGrid(grid, 0, 0).raining, false);
});

test("nearestEcho reports the strongest echo beside the pin, or null on a clean field", () => {
  const dry = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  assert.equal(nc.nearestEcho(dry), null);
  // A 2 × 2 km patch of 12 dBZ, 3 km east: below the rain floor but real echo.
  const g = new Float32Array(GRID_N * GRID_N).fill(-Infinity);
  for (const di of [0, 1]) for (const dj of [3, 4]) g[(C - di) * GRID_N + (C + dj)] = 12;
  const e = nc.nearestEcho(g);
  assert.ok(e && e.maxDbz >= 10 && e.maxDbz < 15, JSON.stringify(e));
  assert.ok(e.distanceKm >= 1 && e.distanceKm <= 4);
  assert.ok(e.bearingDeg > 45 && e.bearingDeg < 135, "to the east");
});
