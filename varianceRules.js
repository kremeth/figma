/**
 * Optimal band + stability tiers from variance_rules.json.
 * band "relative": low = μ*(1-halfWidth), high = μ*(1+halfWidth)
 * band "absolute": low = μ-halfWidth, high = μ+halfWidth
 */

const path = require("path");
const rules = require(path.join(__dirname, "variance_rules.json"));

const METRIC_IDS = Object.keys(rules.metrics);

function getMetricRule(metricId) {
  return rules.metrics[metricId] ?? null;
}

/**
 * @param {number} mu
 * @param {string} metricId key in rules.metrics
 * @returns {{ low: number, high: number } | null}
 */
function optimalBand(mu, metricId) {
  const m = getMetricRule(metricId);
  if (!m || mu == null || Number.isNaN(Number(mu))) return null;
  const u = Number(mu);
  const hw = Number(m.halfWidth);
  if (Number.isNaN(hw)) return null;

  let low;
  let high;
  if (m.band === "relative") {
    low = u * (1 - hw);
    high = u * (1 + hw);
  } else if (m.band === "absolute") {
    low = u - hw;
    high = u + hw;
  } else {
    return null;
  }

  if (m.clipBand) {
    if (typeof m.boundMin === "number") low = Math.max(low, m.boundMin);
    if (typeof m.boundMax === "number") high = Math.min(high, m.boundMax);
  }

  if (low > high) return null;

  return { low, high };
}

function valueInBand(value, band) {
  if (band == null || value == null || Number.isNaN(Number(value))) return false;
  const v = Number(value);
  return v >= band.low && v <= band.high;
}

/**
 * Mean of valid numeric entries; ignores null/NaN.
 * @param {number[]} values
 * @returns {number | null}
 */
function meanOf(values) {
  const valid = (values || []).map(Number).filter((x) => !Number.isNaN(x));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/**
 * Share of values inside optimal band around their mean (same window).
 * @param {number[]} values
 * @param {string} metricId
 * @returns {{ mean: number, band: { low: number, high: number }, daysInRangePct: number, n: number } | null}
 */
function stabilityFromSeries(values, metricId) {
  const valid = (values || []).map(Number).filter((x) => !Number.isNaN(x));
  const n = valid.length;
  if (n === 0) return null;

  const mu = meanOf(valid);
  const band = optimalBand(mu, metricId);
  if (!band) return null;

  let inRange = 0;
  for (const v of valid) {
    if (valueInBand(v, band)) inRange++;
  }

  return {
    mean: mu,
    band,
    daysInRangePct: (100 * inRange) / n,
    n,
  };
}

/**
 * @param {number} daysInRangePct 0–100
 * @returns {string | null} tier id
 */
function stabilityTier(daysInRangePct) {
  const pct = Number(daysInRangePct);
  if (Number.isNaN(pct)) return null;
  for (const t of rules.stabilityTiers) {
    if (pct >= t.minPct && pct <= t.maxPct) return t.id;
  }
  return null;
}

/**
 * One call: series → band around mean, % days in band, tier id.
 * @param {number[]} values
 * @param {string} metricId
 */
function analyzeSeries(values, metricId) {
  const s = stabilityFromSeries(values, metricId);
  if (!s) return null;
  return {
    metricId,
    ...s,
    tier: stabilityTier(s.daysInRangePct),
  };
}

module.exports = {
  rules,
  METRIC_IDS,
  getMetricRule,
  optimalBand,
  valueInBand,
  meanOf,
  stabilityFromSeries,
  stabilityTier,
  analyzeSeries,
};
