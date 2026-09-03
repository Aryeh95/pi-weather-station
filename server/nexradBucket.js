// Shared access to the public `unidata-nexrad-level3` S3 bucket.
//
// Three controllers read the same bucket — storm tracks (NST / NMD), the
// raw-radial renderer (N0B / N0G) — and until 2026-09 each hand-rolled
// its own `?list-type=2&prefix=` listing with its own axios options and
// no continuation handling. This module is the single copy.
//
// Key shape (verified live, unchanged since the bucket opened):
//
//   SSS_PPP_YYYY_MM_DD_hh_mm_ss      e.g. DIX_N0B_2026_09_03_02_55_41
//
// with SSS the 3-letter site, PPP the product token. Lexicographic
// order is chronological for this naming, and one hour's prefix holds a
// dozen keys per product, which is why every lookup here is hour-scoped
// instead of listing a whole day.
//
// The listing is plain HTTPS — no AWS SDK. The bucket is public and
// keyless.

const axios = require("axios");
const { BoundedMap } = require("./boundedCache");

const BUCKET_BASE = "https://unidata-nexrad-level3.s3.amazonaws.com";
const API_TIMEOUT_MS = 15_000;

// Hour-listing cache. The current UTC hour keeps changing, so it gets a
// short TTL; a closed hour is immutable and can sit for an hour. Keyed
// by the full prefix, so every (site, product, hour) is its own entry.
const HOUR_KEYS_TTL_MS = 60 * 1000;
const PAST_HOUR_KEYS_TTL_MS = 60 * 60 * 1000;
const hourKeysCache = new BoundedMap(64);

/**
 * Build the hour-scoped key prefix for a site + product.
 *
 * @param {String} site 3-letter radar id
 * @param {String} product product token as it appears in the key (e.g. "N0B", "NST")
 * @param {Date} t any instant inside the wanted UTC hour
 * @returns {String} e.g. "DIX_N0B_2026_09_03_02"
 */
function hourPrefix(site, product, t) {
  return `${site}_${product}_${t.getUTCFullYear()}_`
    + `${String(t.getUTCMonth() + 1).padStart(2, "0")}_`
    + `${String(t.getUTCDate()).padStart(2, "0")}_`
    + `${String(t.getUTCHours()).padStart(2, "0")}`;
}

/**
 * List every key under a prefix, following continuation tokens.
 *
 * An hour of one product is ~12 keys, far below S3's 1000-key page, so
 * the continuation loop is insurance rather than a hot path — but the
 * previous per-controller copies silently truncated at the first page,
 * and a helper that claims to list a prefix should list all of it.
 *
 * @param {String} prefix key prefix
 * @returns {Promise<Array<String>>} keys, lexicographic (= chronological)
 */
async function listKeys(prefix) {
  const keys = [];
  let token = null;
  do {
    const params = { "list-type": 2, prefix, "max-keys": 1000 };
    if (token) params["continuation-token"] = token;
    // eslint-disable-next-line no-await-in-loop -- pages are sequential by construction
    const res = await axios.get(BUCKET_BASE, {
      params,
      timeout: API_TIMEOUT_MS,
      responseType: "text",
    });
    const xml = String(res.data);
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? next[1] : null;
  } while (token);
  return keys;
}

/**
 * List one UTC hour of keys for a site + product, cached.
 *
 * @param {String} site 3-letter radar id
 * @param {String} product product token
 * @param {Date} t any instant inside the wanted UTC hour
 * @returns {Promise<Array<String>>} keys, lexicographic (= chronological)
 */
async function listHourKeys(site, product, t) {
  const prefix = hourPrefix(site, product, t);
  const hit = hourKeysCache.get(prefix);
  if (hit && hit.expires > Date.now()) return hit.value;

  const keys = await listKeys(prefix);

  const now = new Date();
  const isCurrentHour = hourPrefix(site, product, now) === prefix;
  const ttl = isCurrentHour ? HOUR_KEYS_TTL_MS : PAST_HOUR_KEYS_TTL_MS;
  hourKeysCache.set(prefix, { value: keys, expires: Date.now() + ttl });
  return keys;
}

/**
 * Newest key for a site + product, looking back up to three hours.
 *
 * The fallback hours cover the first minutes after a UTC hour rollover
 * (current prefix still empty) and a radar in a slow clear-air VCP.
 *
 * @param {String} site 3-letter radar id
 * @param {String} product product token (e.g. "NST", "N0B", "N0G")
 * @returns {Promise<String|null>} newest key, or null when none recently
 */
async function newestKey(site, product) {
  const now = Date.now();
  for (let back = 0; back < 3; back += 1) {
    // eslint-disable-next-line no-await-in-loop -- stop at the first hour with data
    const keys = await listHourKeys(site, product, new Date(now - back * 60 * 60 * 1000));
    if (keys.length) return keys[keys.length - 1];
  }
  return null;
}

/**
 * Epoch ms encoded in a bucket key's timestamp suffix (UTC).
 *
 * @param {String} key bucket key
 * @returns {Number|null} epoch ms, or null when the key has no timestamp
 */
function l3KeyEpoch(key) {
  const m = /_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/.exec(key || "");
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm, ss);
}

/**
 * Fetch one object as a Buffer.
 *
 * @param {String} key bucket key
 * @returns {Promise<Buffer>} object bytes
 */
async function fetchObject(key) {
  const res = await axios.get(`${BUCKET_BASE}/${key}`, {
    responseType: "arraybuffer",
    timeout: API_TIMEOUT_MS,
  });
  return Buffer.from(res.data);
}

module.exports = {
  BUCKET_BASE,
  API_TIMEOUT_MS,
  hourPrefix,
  listKeys,
  listHourKeys,
  newestKey,
  l3KeyEpoch,
  fetchObject,
};
