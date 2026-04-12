#!/usr/bin/env node
/**
 * Fills nutricode-health-report.html from raw_data.json + cohort JSON files.
 * Run from repo root: node populate-health-report.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const raw = readJson('raw_data.json');
const bottom10 = readJson('bottom10_percent.json');
const normative = readJson('normative_metrics.json');
const top10 = readJson('top10_percent.json');

const viz = raw?.connect_device_recommendation?.metric_analysis?.visualization;
if (!viz) {
  console.error('Missing connect_device_recommendation.metric_analysis.visualization in raw_data.json');
  process.exit(1);
}

const meta = viz.meta;
const m = viz.metrics;
const dailyAct = viz.daily_activity;
const totalAct = viz.total_activity || {};

function ageBand(age) {
  if (age < 26) return '18-25';
  if (age < 36) return '26-35';
  if (age < 46) return '36-45';
  if (age < 56) return '46-55';
  if (age < 66) return '56-65';
  return '66+';
}

const gender = meta.gender === 'female' ? 'female' : 'male';
const band = ageBand(meta.age ?? 30);
/** Normative bracket: plain number, or { p50, p30, p60, p90 } (REM); cohort code uses p50 as reference. */
const g = (obj) => {
  const v = obj?.[gender]?.[band];
  if (v != null && typeof v === 'object' && Number.isFinite(+v.p50)) return +v.p50;
  return v;
};

function seriesMean(series) {
  if (!series || typeof series !== 'object') return null;
  const vals = Object.values(series).filter((v) => v != null && typeof v === 'number' && !Number.isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmtDateShort(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtRange(start, end) {
  return `${fmtDateShort(start)}–${fmtDateShort(end)}, ${new Date(end + 'T12:00:00Z').getFullYear()}`;
}

function deviceLabel(dev) {
  if (!dev) return 'Wearable';
  const s = String(dev);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function trimpLabel(x) {
  if (x == null || !Number.isFinite(x))
    return { tag: '—', foot: 'Training load is limited', cls: 'snap-ft--neg' };
  if (x < 1.0) return { tag: 'Easy', foot: 'Training load looks good', cls: 'snap-ft--pos' };
  if (x < 1.5) return { tag: 'Easy', foot: 'Training load looks good', cls: 'snap-ft--pos' };
  if (x < 2.0) return { tag: 'Moderate', foot: 'Training load can increase', cls: 'snap-ft--warn' };
  if (x < 2.5) return { tag: 'Hard', foot: 'Training load is limited', cls: 'snap-ft--neg' };
  return { tag: 'Very hard', foot: 'Training load is limited', cls: 'snap-ft--neg' };
}

/**
 * Map value to bar position with:
 * - linear mapping between bottom-10% and top-10% benchmarks
 * - asymptotic tails outside the range
 * - asymptotes at 25% of each outer segment from the bar ends
 *   (for 10/90 ticks: 2.5% and 97.5%)
 */
function barPos(v, left, mid, right, lowerIsBetter) {
  if (v == null || !Number.isFinite(v)) return 50;

  const L = Number(left);
  const M = Number(mid);
  const R = Number(right);
  if (![L, M, R].every(Number.isFinite)) return 50;

  // Visual anchors on the bar.
  const xL = 10;
  const xM = 50;
  const xR = 90;

  // 25% into each outer segment from the bar ends.
  const xA_left = 0 + 0.25 * (xL - 0);
  const xA_right = 100 - 0.25 * (100 - xR);

  // Higher = faster approach to asymptote.
  const k = 2.2;

  // Normalize so "worse -> left, better -> right" for both metric types.
  const vv = lowerIsBetter ? -v : v;
  const LL = lowerIsBetter ? -L : L;
  const MM = lowerIsBetter ? -M : M;
  const RR = lowerIsBetter ? -R : R;
  if (!(LL < MM && MM < RR)) return 50;

  // Linear section inside [LL, RR].
  if (vv >= LL && vv <= RR) {
    if (vv <= MM) {
      const t = (vv - LL) / (MM - LL);
      return xL + t * (xM - xL);
    }
    const t = (vv - MM) / (RR - MM);
    return xM + t * (xR - xM);
  }

  // Left tail: approach xA_left asymptotically.
  if (vv < LL) {
    const d = (LL - vv) / (MM - LL);
    return xA_left + (xL - xA_left) * Math.exp(-k * d);
  }

  // Right tail: approach xA_right asymptotically.
  const d = (vv - RR) / (RR - MM);
  return xA_right - (xA_right - xR) * Math.exp(-k * d);
}

function badgeFor(ratio) {
  if (ratio > 0.9) return { cls: 'elite', text: 'Elite' }; // blue
  if (ratio >= 0.6) return { cls: 'optimal', text: 'Optimal' }; // green
  if (ratio > 0.3) {
    if (ratio >= 0.4) return { cls: 'below', text: 'Normal' }; // orange
    return { cls: 'below', text: 'Limited' }; // orange
  }
  return { cls: 'low', text: 'Low' }; // red
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// --- Core series ---
const recoveryAvg = seriesMean(m.recovery);
const sleepScoreAvg = seriesMean(m.sleep_score);
const hrvAvg = seriesMean(m.HRV);
const rhrAvg = seriesMean(m.RHR);
const vo2Vals = Object.values(m.vo2_max || {}).filter((v) => v != null && typeof v === 'number');
const vo2Avg = vo2Vals.length ? vo2Vals.reduce((a, b) => a + b, 0) / vo2Vals.length : null;

const sleepSecAvg = seriesMean(m.sleep_time);
const effAvg = seriesMean(m.sleep_efficiency);
const disturbAvg = seriesMean(m.disturbances);

const remAvgS = seriesMean(m.rem_sleep);
const deepAvgS = seriesMean(m.deep_sleep);
const lightAvgS = seriesMean(m.light_sleep);
const awakeAvgS = seriesMean(m.awake_time);

function nightPcts(i) {
  const key = String(i);
  const a = m.awake_time?.[key];
  const l = m.light_sleep?.[key];
  const d = m.deep_sleep?.[key];
  const r = m.rem_sleep?.[key];
  if ([a, l, d, r].some((x) => x == null || typeof x !== 'number')) return null;
  const t = a + l + d + r;
  if (t <= 0) return null;
  return [
    Math.round((a / t) * 100),
    Math.round((l / t) * 100),
    Math.round((d / t) * 100),
    Math.round((r / t) * 100),
  ];
}

const nights = [];
for (let i = 1; i <= (meta.num_days || 30); i++) {
  const p = nightPcts(i);
  if (p) nights.push(p);
  else nights.push(null);
}

const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);
let remP = 0,
  deepP = 0,
  lightP = 0,
  awakeP = 0;
let nP = 0;
for (let i = 1; i <= (meta.num_days || 30); i++) {
  const p = nightPcts(i);
  if (!p) continue;
  const t = p[0] + p[1] + p[2] + p[3];
  if (t <= 0) continue;
  awakeP += p[0];
  lightP += p[1];
  deepP += p[2];
  remP += p[3];
  nP++;
}
if (nP) {
  remP = Math.round(remP / nP);
  deepP = Math.round(deepP / nP);
  lightP = Math.round(lightP / nP);
  awakeP = Math.round(awakeP / nP);
}

const hoursSleep = sleepSecAvg != null ? sleepSecAvg / 3600 : null;
const disturbPerHr =
  disturbAvg != null && hoursSleep != null && hoursSleep > 0 ? disturbAvg / hoursSleep : null;
const effPct = effAvg != null ? effAvg * 100 : null;

// TRIMP / daily intensity
const intensities = [];
for (let i = 1; i <= (meta.num_days || 30); i++) {
  const ai = dailyAct?.[String(i)]?.average_intensity;
  if (ai != null && typeof ai === 'number') intensities.push(ai);
}
const trimpAvg = intensities.length ? intensities.reduce((a, b) => a + b, 0) / intensities.length : null;
const tr = trimpLabel(trimpAvg);

function trimpTagClass(tag) {
  if (tag === 'Easy') return 'snap-tag--easy';
  if (tag === 'Moderate') return 'snap-tag--moderate';
  if (tag === 'Very hard') return 'snap-tag--vhard';
  return 'snap-tag--hard';
}

/** Footer glyph follows pill tag band; stroke uses currentColor (neutral grey on .snapshot-tile .snap-ft). */
const SNAP_FT_ICON_RED = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="7" cy="7" r="5.75" stroke="currentColor" stroke-width="1"/>
            <path d="M4.5 7h5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
        </svg>`;

const SNAP_FT_ICON_YELLOW = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 10V3M2.75 5.75L6 2.5l3.25 3.25" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>`;

const SNAP_FT_ICON_GREEN = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1" fill="none"/>
            <path d="M4.5 6l1.5 1.5 1.5-3" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>`;

function snapFtIconSvg(tagCls) {
  if (tagCls === 'snap-tag--easy') return SNAP_FT_ICON_GREEN;
  if (tagCls === 'snap-tag--vhard') return SNAP_FT_ICON_RED;
  return SNAP_FT_ICON_YELLOW;
}

function trimpXFromDurationSec(sec) {
  const minX = 48;
  const maxX = 438;
  const maxSec = 6 * 3600;
  const t = clamp(sec / maxSec, 0, 1);
  return Math.round(minX + t * (maxX - minX));
}

function trimpYFromIntensity(i) {
  // Chart Y: higher intensity is higher (smaller y)
  const minY = 231;
  const maxY = 10;
  const minI = 0.8;
  const maxI = 2.8;
  const t = clamp((i - minI) / (maxI - minI), 0, 1);
  return Math.round(minY - t * (minY - maxY));
}

const trimpPts = [];
for (let d = 1; d <= (meta.num_days || 30); d++) {
  const row = dailyAct?.[String(d)];
  const dur = row?.total_duration;
  const ai = row?.average_intensity;
  const nextRecovery = m.recovery?.[String(d + 1)];
  if (!Number.isFinite(dur) || !Number.isFinite(ai) || !Number.isFinite(nextRecovery)) continue;
  const x = trimpXFromDurationSec(dur);
  const y = trimpYFromIntensity(ai);
  const color = nextRecovery >= 67 ? '#22c55e' : nextRecovery >= 34 ? '#f59e0b' : '#ef4444';
  trimpPts.push({ x, y, color });
}

// Recovery donut
const recVals = Object.values(m.recovery || {}).filter((v) => v != null && typeof v === 'number');
let hi = 0,
  med = 0,
  lo = 0;
for (const v of recVals) {
  if (v >= 67) hi++;
  else if (v >= 34) med++;
  else lo++;
}
const recoveryDonutAvg = recoveryAvg != null ? Math.round(recoveryAvg) : 0;

// Health score (Nutricode equation v3)
function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function metricScoreStandard(raw, poor, excellent) {
  if (raw == null || !Number.isFinite(raw)) return null;
  return clamp(((raw - poor) / (excellent - poor)) * 100, 0, 100);
}

function metricScoreInverted(raw, poor, excellent) {
  if (raw == null || !Number.isFinite(raw)) return null;
  return clamp(((poor - raw) / (poor - excellent)) * 100, 0, 100);
}

const metricDefs = [
  { key: 'hrv', w: 0.22, score: metricScoreStandard(hrvAvg, 20, 100) },
  { key: 'vo2', w: 0.18, score: metricScoreStandard(vo2Avg, 25, 55) },
  { key: 'rhr', w: 0.12, score: metricScoreInverted(rhrAvg, 80, 45) },
  { key: 'deep', w: 0.12, score: metricScoreStandard(deepP, 10, 22) },
  { key: 'eff', w: 0.1, score: metricScoreStandard(effPct, 70, 98) },
  { key: 'dis', w: 0.08, score: metricScoreInverted(disturbPerHr, 3.5, 0.5) },
  { key: 'rem', w: 0.07, score: metricScoreStandard(remP, 15, 25) },
  { key: 'sleep', w: 0.07, score: metricScoreStandard(hoursSleep, 5.0, 8.5) },
  { key: 'awake', w: 0.02, score: metricScoreInverted(awakeP, 15, 3) },
  { key: 'light', w: 0.02, score: metricScoreInverted(lightP, 70, 45) },
];

// Clinical floor cap in v3: total sleep below 7h should not exceed a floor penalty value.
if (hoursSleep != null && Number.isFinite(hoursSleep) && hoursSleep < 7) {
  const sleepMetric = metricDefs.find((x) => x.key === 'sleep');
  if (sleepMetric && sleepMetric.score != null) sleepMetric.score = Math.max(sleepMetric.score, 60);
}

const available = metricDefs.filter((x) => x.score != null && Number.isFinite(x.score));
let healthScore = 67;
if (available.length >= 3) {
  const wSum = available.reduce((a, x) => a + x.w, 0);
  const weighted = available.reduce((a, x) => a + x.score * (x.w / wSum), 0);
  healthScore = Math.round(clamp(weighted, 0, 100));
}

const C = 314.16;
const dash = (healthScore / 100) * C;
const dashRest = C - dash;

// HR zones from total_activity
const zoneSecs = [0, 0, 0, 0, 0, 0];
for (const sport of Object.values(totalAct)) {
  if (!sport || typeof sport !== 'object') continue;
  for (let z = 0; z < 6; z++) {
    zoneSecs[z] += Number(sport[`time_zone_${z}`]) || 0;
  }
}
const zMax = Math.max(...zoneSecs, 1);
const zoneRows = [
  { lbl: '90–100%', sec: zoneSecs[5], color: '#ef4444' },
  { lbl: '80–89%', sec: zoneSecs[4], color: '#f59e0b' },
  { lbl: '70–79%', sec: zoneSecs[3], color: '#22c55e' },
  { lbl: '60–69%', sec: zoneSecs[2], color: '#60a5fa' },
  { lbl: '50–59%', sec: zoneSecs[1], color: '#93c5fd' },
  { lbl: '0–49%', sec: zoneSecs[0], color: '#d1d5db' },
].map((row) => ({
  ...row,
  w: Math.max(0.5, (row.sec / zMax) * 100),
  minW: row.sec > 0 ? 2 : 0,
}));

// Activity summary
const sports = Object.entries(totalAct)
  .map(([name, o]) => ({
    name,
    total: o?.total ?? 0,
    dur: o?.total_duration ?? 0,
  }))
  .filter((x) => x.total > 0 && x.dur > 0)
  .sort((a, b) => b.dur - a.dur);

const activityCount = sports.reduce((a, s) => a + s.total, 0);
const activityDurTotal = sports.reduce((a, s) => a + s.dur, 0);

function sportTitle(k) {
  return k
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Cohort triples
const c = {
  vo2: { L: g(bottom10.vo2max), M: g(normative.vo2max), R: g(top10.vo2max) },
  hrv: { L: g(bottom10.hrv), M: g(normative.hrv), R: g(top10.hrv) },
  rhr: { L: g(bottom10.rhr), M: g(normative.rhr), R: g(top10.rhr) },
  sleepH: { L: g(bottom10.total_sleep), M: g(normative.total_sleep), R: g(top10.total_sleep) },
  eff: { L: g(bottom10.sleep_efficiency), M: g(normative.sleep_efficiency), R: g(top10.sleep_efficiency) },
  dis: { L: g(bottom10.sleep_disruptions), M: g(normative.sleep_disruptions), R: g(top10.sleep_disruptions) },
  rem: { L: g(bottom10.rem_sleep), M: g(normative.rem_sleep), R: g(top10.rem_sleep) },
  deep: { L: g(bottom10.deep_sleep), M: g(normative.deep_sleep), R: g(top10.deep_sleep) },
  light: { L: g(bottom10.light_sleep), M: g(normative.light_sleep), R: g(top10.light_sleep) },
  awake: { L: g(bottom10.awake), M: g(normative.awake), R: g(top10.awake) },
};

function fmtBench(n, dec = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (dec === 0) return String(Math.round(n));
  const r = round1(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Matches cohort bar inline fill so modifier class is not wrong vs background. */
function bioBenchFillMod(fillColor) {
  if (fillColor === '#ff0000') return 'bio-bench-fill--red';
  if (fillColor === '#ff9f0a') return 'bio-bench-fill--amber';
  if (fillColor === '#5da9c8') return 'bio-bench-fill--blue';
  return 'bio-bench-fill--green';
}

function bioBlock(vo, unit, lower, triple, userVal, dec = 0) {
  const sortedBench = [Number(triple.L), Number(triple.M), Number(triple.R)]
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (sortedBench.length < 3) {
    const fillColor = '#34c759';
    return {
      wrapLow: 'bio-bench-track-wrap--higher',
      width: '50%',
      fillColor,
      fillMod: bioBenchFillMod(fillColor),
      dotLeft: '50%',
      m1: '—',
      m2: '—',
      m3: '—',
      val: userVal == null ? '—' : dec === 0 ? String(Math.round(userVal)) : round1(userVal).toFixed(dec),
      unit,
      badgeCls: 'normal',
      badgeText: 'Normal',
    };
  }

  const [b1, b2, b3] = sortedBench;
  const pos = barPos(userVal, b1, b2, b3, false);
  const pctStr = `${round1(pos)}%`;
  const visualRatio = pos / 100;
  // For lower-is-better metrics, invert color/tag scoring while keeping low->high axis.
  const scoreRatio = lower ? 1 - visualRatio : visualRatio;
  const b = badgeFor(scoreRatio);
  let fillColor = '#34c759';
  if (scoreRatio <= 0.3) fillColor = '#ff0000';
  else if (scoreRatio < 0.6) fillColor = '#ff9f0a';
  else if (scoreRatio > 0.9) fillColor = '#5da9c8';
  const wrapLow = 'bio-bench-track-wrap--higher';
  const valStr = userVal == null ? '—' : dec === 0 ? String(Math.round(userVal)) : round1(userVal).toFixed(dec);
  return {
    wrapLow,
    width: pctStr,
    fillColor,
    fillMod: bioBenchFillMod(fillColor),
    dotLeft: pctStr,
    m1: fmtBench(b1, 1),
    m2: fmtBench(b2, 1),
    m3: fmtBench(b3, 1),
    val: valStr,
    unit,
    badgeCls: b.cls,
    badgeText: b.text,
  };
}

const bio = {
  vo2: bioBlock(false, 'ml/kg/min', false, c.vo2, vo2Avg, 0),
  hrv: bioBlock(false, 'ms', false, c.hrv, hrvAvg, 0),
  rhr: bioBlock(false, 'bpm', true, c.rhr, rhrAvg, 0),
  sleepH: bioBlock(false, 'h', false, c.sleepH, hoursSleep, 1),
  eff: bioBlock(false, '%', false, c.eff, effPct, 0),
  dis: bioBlock(false, '/h', true, c.dis, disturbPerHr, 1),
  rem: bioBlock(false, '%', false, c.rem, remP, 0),
  deep: bioBlock(false, '%', false, c.deep, deepP, 0),
  light: bioBlock(false, '%', true, c.light, lightP, 0),
  awake: bioBlock(false, '%', true, c.awake, awakeP, 0),
};

// Sleep tile footnote — green ≥85%, yellow 70–84%, red &lt;70% (same bands as pill labels)
let sleepFoot = 'Sleep is too low.';
let sleepFootCls = 'snap-ft--neg';
let sleepTag = { cls: 'snap-tag--moderate', text: 'Sufficient' };
if (sleepScoreAvg != null) {
  if (sleepScoreAvg >= 85) {
    sleepFoot = 'Sleep looks good';
    sleepFootCls = 'snap-ft--pos';
    sleepTag = { cls: 'snap-tag--easy', text: 'Optimal' };
  } else if (sleepScoreAvg >= 70) {
    sleepFoot = 'Sleep can improve';
    sleepFootCls = 'snap-ft--warn';
    sleepTag = { cls: 'snap-tag--moderate', text: 'Sufficient' };
  } else {
    sleepFoot = 'Sleep is too low.';
    sleepFootCls = 'snap-ft--neg';
    sleepTag = { cls: 'snap-tag--vhard', text: 'Poor' };
  }
}

// Limiting metrics: top 3 worst by health-score rank (lowest sub-scores first), with cohort-context badges
const metricLimitMeta = {
  hrv: { name: 'HRV', higherBetter: true, user: () => hrvAvg, cohort: () => c.hrv },
  vo2: { name: 'VO₂ max', higherBetter: true, user: () => vo2Avg, cohort: () => c.vo2 },
  rhr: { name: 'Resting HR', higherBetter: false, user: () => rhrAvg, cohort: () => c.rhr },
  deep: { name: 'Deep sleep', higherBetter: true, user: () => deepP, cohort: () => c.deep },
  eff: { name: 'Sleep efficiency', higherBetter: true, user: () => effPct, cohort: () => c.eff },
  dis: { name: 'Disruptions', higherBetter: false, user: () => disturbPerHr, cohort: () => c.dis },
  rem: { name: 'REM sleep', higherBetter: true, user: () => remP, cohort: () => c.rem },
  sleep: { name: 'Total sleep', higherBetter: true, user: () => hoursSleep, cohort: () => c.sleepH },
  awake: { name: 'Awake time', higherBetter: false, user: () => awakeP, cohort: () => c.awake },
  light: { name: 'Light sleep', higherBetter: false, user: () => lightP, cohort: () => c.light },
};

function limitingRowFromMetric(def) {
  const meta = metricLimitMeta[def.key];
  if (!meta) return null;
  const user = meta.user();
  const M = meta.cohort()?.M;
  const score = def.score;
  const badness = 100 - score;
  let badge = 'Below target';
  let dot = 'amber';
  if (score != null && score < 40) dot = 'red';
  else if (score != null && score < 55) dot = 'amber';

  if (user != null && Number.isFinite(user) && M != null && Number.isFinite(M) && Math.abs(M) > 1e-9) {
    if (meta.higherBetter) {
      if (user < M) {
        badge = `${Math.round(((M - user) / Math.abs(M)) * 100)}% below avg`;
      } else if (badness > 50) {
        badge = 'Needs attention';
        dot = 'red';
      }
    } else if (user > M) {
      badge = `${Math.round(((user - M) / Math.abs(M)) * 100)}% above avg`;
    } else if (badness > 50) {
      badge = 'Needs attention';
      dot = 'red';
    }
  } else if (score != null && score < 45) {
    badge = 'Needs attention';
    dot = 'red';
  }

  return { name: meta.name, badge, dot, badness };
}

let limits = metricDefs
  .filter((d) => d.score != null && Number.isFinite(d.score))
  .map((d) => limitingRowFromMetric(d))
  .filter(Boolean)
  .sort((a, b) => b.badness - a.badness)
  .slice(0, 3)
  .map(({ name, badge, dot }) => ({ name, badge, dot }));

while (limits.length < 3) {
  limits.push({ name: '—', badge: 'No data', dot: 'amber' });
}

const cohortAge =
  band === '26-35'
    ? '26–35'
    : band === '18-25'
      ? '18–25'
      : band === '36-45'
        ? '36–45'
        : band === '46-55'
          ? '46–55'
          : band === '56-65'
            ? '56–65'
            : '66+';
const cohortLabel = `${gender === 'female' ? 'women' : 'men'} aged ${cohortAge}`;
const metaLine = `${fmtRange(meta.start_date, meta.end_date)} · ${deviceLabel(meta.device)} · ${gender === 'female' ? 'Women' : 'Men'} · ${cohortAge}`;

// Same bands as recovery donut legend: green ≥67%, yellow 34–66%, red &lt;34%
let recFoot = { text: 'Recovery is limited', cls: 'snap-ft--neg' };
let recTag = { cls: 'snap-tag--moderate', text: 'Moderate' };
if (recoveryAvg != null) {
  if (recoveryAvg >= 67) {
    recFoot = { text: 'Recovery looks good', cls: 'snap-ft--pos' };
    recTag = { cls: 'snap-tag--easy', text: 'High' };
  } else if (recoveryAvg < 34) {
    recFoot = { text: 'Recovery is limited', cls: 'snap-ft--neg' };
    recTag = { cls: 'snap-tag--vhard', text: 'Low' };
  } else {
    recFoot = { text: 'Recovery can improve', cls: 'snap-ft--warn' };
    recTag = { cls: 'snap-tag--moderate', text: 'Moderate' };
  }
}

let html = fs.readFileSync(path.join(root, 'nutricode-health-report.html'), 'utf8');

function rep(re, fn) {
  const before = html;
  html = typeof fn === 'string' ? html.replace(re, fn) : html.replace(re, fn);
  if (html === before && !before.match(re)) console.warn('Pattern missed:', re);
}

html = html.replace(/bio-bench-fill--bio-bench-fill--(green|amber)/g, 'bio-bench-fill--$1');

// Header
rep(/<p class="report-meta-line">[^<]*<\/p>/, `<p class="report-meta-line">${metaLine}</p>`);
rep(/<span class="header-sync-text">[^<]*<\/span>/, `<span class="header-sync-text">${meta.num_days ?? 30} days synced</span>`);
rep(
  /\.bio-badge\.optimal[\s\S]*?\.bio-badge\.needs-imp\s+\{[^}]*\}/,
  `.bio-badge.optimal   { background: var(--green-bg); color: var(--green); }
    .bio-badge.normal    { background: var(--green-bg); color: var(--green); }
    .bio-badge.below     { background: var(--amber-bg); color: var(--amber); }
    .bio-badge.low       { background: var(--red-bg); color: var(--red); }
    .bio-badge.elite     { background: rgba(15, 23, 42, 0.08); color: #0f3b4f; border: 1px solid rgba(93, 169, 200, 0.35); }
    .bio-badge.needs-imp { background: var(--amber-bg); color: var(--amber); }`,
);

// Score ring
rep(/data-score="[^"]*"/, `data-score="${healthScore}"`);
rep(
  /(<text x="0" y="-6" text-anchor="middle"\s*font-size="28"[^>]*>)\d+(<\/text>)/,
  `$1${healthScore}$2`,
);
rep(
  /stroke-dasharray="[^"]+"/,
  `stroke-dasharray="${dash.toFixed(2)} ${dashRest.toFixed(2)}"`,
);
rep(
  /aria-label="Health score: \d+ out of 100"/,
  `aria-label="Health score: ${healthScore} out of 100"`,
);

// Limiting list
const limHtml = limits
  .slice(0, 3)
  .map(
    (l) => `<li class="limiting-row">
            <div class="limiting-left">
              <span class="limiting-dot limiting-dot--${l.dot}" aria-hidden="true"></span>
              <span class="limiting-name">${l.name}</span>
      </div>
            <div class="limiting-right">
              <span class="limiting-badge limiting-badge--${l.dot === 'amber' ? 'amber' : 'red'}">${l.badge}</span>
      </div>
          </li>`,
  )
  .join('\n          ');
rep(/<ul class="limiting-list"[^>]*>[\s\S]*?<\/ul>/, `<ul class="limiting-list" aria-label="Metrics needing attention">\n          ${limHtml}\n        </ul>`);

// Snapshot tiles — value row + pill tag (matches training-intensity tile pattern)
rep(
  /(<p class="snap-name">Avg Recovery<\/p>[\s\S]*?<div class="snap-tile-value(?: snap-tile-value--row)?">\s*<p class="snap-val">)\d+(<span class="snap-unit"> %<\/span><\/p>)(?:\s*<span class="snap-tag[^"]*">[^<]*<\/span>)?\s*<\/div>/,
  `$1${Math.round(recoveryAvg ?? 0)}$2\n        <span class="snap-tag ${recTag.cls}">${recTag.text.replace(/</g, '&lt;')}</span>\n      </div>`,
);
rep(
  /(<p class="snap-name">Avg Recovery<\/p>[\s\S]*?<div class=")snap-ft snap-ft--(?:flat|pos|neg|warn)(")([\s\S]*?<span>)[^<]*(<\/span>)/,
  `$1snap-ft ${recFoot.cls}$2>\n        <span class="snap-ft-icon" aria-hidden="true">\n          ${snapFtIconSvg(recTag.cls)}\n        </span>\n        <span>${recFoot.text.replace(/</g, '&lt;')}$4`,
);
rep(
  /(<p class="snap-name">Sleep Performance<\/p>[\s\S]*?<div class="snap-tile-value(?: snap-tile-value--row)?">\s*<p class="snap-val">)\d+(<span class="snap-unit"> %<\/span><\/p>)(?:\s*<span class="snap-tag[^"]*">[^<]*<\/span>)?\s*<\/div>/,
  `$1${Math.round(sleepScoreAvg ?? 0)}$2\n        <span class="snap-tag ${sleepTag.cls}">${sleepTag.text.replace(/</g, '&lt;')}</span>\n      </div>`,
);
rep(
  /(<p class="snap-name">Sleep Performance<\/p>[\s\S]*?<div class=")snap-ft snap-ft--(?:flat|pos|neg|warn)(")([\s\S]*?<span>)[^<]*(<\/span>\s*<\/div>\s*<\/div>\s*<div class="snapshot-tile)/,
  `$1snap-ft ${sleepFootCls}$2>\n        <span class="snap-ft-icon" aria-hidden="true">\n          ${snapFtIconSvg(sleepTag.cls)}\n        </span>\n        <span>${sleepFoot.replace(/</g, '&lt;')}$4`,
);

rep(
  /<div class="snap-tile-value snap-tile-value--row">\s*<p class="snap-val">[\d.]+<\/p>\s*<span class="snap-tag snap-tag--[-\w]+">[^<]*<\/span>/,
  `<div class="snap-tile-value snap-tile-value--row">
        <p class="snap-val">${trimpAvg != null ? trimpAvg.toFixed(1) : '—'}</p>
        <span class="snap-tag ${trimpTagClass(tr.tag)}">${tr.tag}</span>`,
);
rep(
  /(<p class="snap-name">Avg Training Intensity<\/p>[\s\S]*?<div class=")snap-ft snap-ft--(?:flat|pos|neg|warn)(")([\s\S]*?<span>)[^<]*(<\/span>\s*<\/div>\s*<\/div>\s*<\/div>\s*<dialog)/,
  `$1snap-ft ${tr.cls}$2>\n        <span class="snap-ft-icon" aria-hidden="true">\n          ${snapFtIconSvg(trimpTagClass(tr.tag))}\n        </span>\n        <span>${tr.foot.replace(/</g, '&lt;')}$4`,
);

// Recovery donut
rep(
  /(<span class="donut-legend-name">High<\/span>[\s\S]*?<span class="donut-legend-num">)\d+(<\/span>)/,
  `$1${hi}$2`,
);
rep(
  /(<span class="donut-legend-name">Moderate<\/span>[\s\S]*?<span class="donut-legend-num">)\d+(<\/span>)/,
  `$1${med}$2`,
);
rep(
  /(<span class="donut-legend-name">Low<\/span>[\s\S]*?<span class="donut-legend-num">)\d+(<\/span>)/,
  `$1${lo}$2`,
);
rep(
  /aria-label="Recovery: [^"]*"/,
  `aria-label="Recovery: ${recoveryDonutAvg}% average; ${hi} high, ${med} moderate, ${lo} low days out of ${meta.num_days ?? 30}"`,
);
rep(
  /<text x="0" y="-1" text-anchor="middle" font-size="12"[^>]*>\d+%<\/text>/,
  `<text x="0" y="-1" text-anchor="middle" font-size="12" font-weight="600" fill="#17171a">${recoveryDonutAvg}%</text>`,
);

const rDonut = 30;
const Cdonut = 2 * Math.PI * rDonut;
const totRec = Math.max(hi + med + lo, 1);
const arcM = (med / totRec) * Cdonut;
const arcH = (hi / totRec) * Cdonut;
const arcL = (lo / totRec) * Cdonut;
rep(
  /(<!-- Moderate first from 12 o'clock[\s\S]*?-->\s*<circle[\s\S]*?stroke="#f59e0b"[\s\S]*?stroke-dasharray=")[\d.]+ [\d.]+("[\s\S]*?stroke-dashoffset=")0/,
  `$1${arcM.toFixed(2)} ${Cdonut.toFixed(1)}$20`,
);
rep(
  /(<!-- High:[\s\S]*?-->\s*<circle[\s\S]*?stroke="#22c55e"[\s\S]*?stroke-dasharray=")[\d.]+ [\d.]+("[\s\S]*?stroke-dashoffset=")-?[\d.]+/,
  `$1${arcH.toFixed(2)} ${Cdonut.toFixed(1)}$2${(-arcM).toFixed(2)}`,
);
rep(
  /(<!-- Low:[\s\S]*?-->\s*<circle[\s\S]*?stroke="#ef4444"[\s\S]*?stroke-dasharray=")[\d.]+ [\d.]+("[\s\S]*?stroke-dashoffset=")-?[\d.]+/,
  `$1${arcL.toFixed(2)} ${Cdonut.toFixed(1)}$2${(-(arcM + arcH)).toFixed(2)}`,
);

// Sleep legend
rep(
  /<span class="sleep-legend-name">REM<\/span>\s*<span class="sleep-legend-pct">\d+%<\/span>/,
  `<span class="sleep-legend-name">REM</span>
          <span class="sleep-legend-pct">${remP}%</span>`,
);
rep(
  /<span class="sleep-legend-name">Deep<\/span>\s*<span class="sleep-legend-pct">\d+%<\/span>/,
  `<span class="sleep-legend-name">Deep</span>
          <span class="sleep-legend-pct">${deepP}%</span>`,
);
rep(
  /<span class="sleep-legend-name">Light<\/span>\s*<span class="sleep-legend-pct">\d+%<\/span>/,
  `<span class="sleep-legend-name">Light</span>
          <span class="sleep-legend-pct">${lightP}%</span>`,
);
rep(
  /<span class="sleep-legend-name">Awake<\/span>\s*<span class="sleep-legend-pct">\d+%<\/span>/,
  `<span class="sleep-legend-name">Awake</span>
          <span class="sleep-legend-pct">${awakeP}%</span>`,
);

// Sleep axis
const dk = meta.date_keys || [];
rep(
  /<div class="sleep-chart-axis">\s*<span>[^<]*<\/span>\s*<span>[^<]*<\/span>\s*<\/div>/,
  `<div class="sleep-chart-axis">
        <span>${dk[0] ? fmtDateShort(dk[0]) : ''}</span>
        <span>${dk[dk.length - 1] ? fmtDateShort(dk[dk.length - 1]) : ''}</span>
      </div>`,
);

// Training intensity vs next-day recovery points
const trGood = trimpPts
  .filter((p) => p.color === '#22c55e')
  .map((p) => `      <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#22c55e"/>`)
  .join('\n');
const trMod = trimpPts
  .filter((p) => p.color === '#f59e0b')
  .map((p) => `      <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#f59e0b"/>`)
  .join('\n');
const trPoor = trimpPts
  .filter((p) => p.color === '#ef4444')
  .map((p) => `      <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#ef4444"/>`)
  .join('\n');
const trimpCircles = `      <!-- Good next day recovery -->
${trGood || '      <!-- none -->'}
      <!-- Moderate next day recovery -->
${trMod || '      <!-- none -->'}
      <!-- Poor next day recovery -->
${trPoor || '      <!-- none -->'}`;
rep(
  /<!-- Good next day recovery -->[\s\S]*?<!-- Poor next day recovery -->[\s\S]*?(?=\s*<\/svg>)/,
  trimpCircles,
);

// Activity summary block
const actRows = sports.slice(0, 5).map((s) => {
  const title = sportTitle(s.name);
  return `      <div class="act-summary-row">
        <span class="act-summary-count">${s.total}×</span>
        <span class="act-summary-name">${title}</span>
        <span class="act-summary-dur">${formatDuration(s.dur)}</span>
      </div>`;
});
rep(
  /<div class="act-summary-header">[\s\S]*?<\/div>\s*<div class="act-summary-list"[^>]*>/,
  `<div class="act-summary-header">
      <div class="act-summary-hd-col">
        <p class="act-col-lbl">Activities</p>
        <p class="act-big">${activityCount}</p>
      </div>
      <div class="act-summary-hd-col">
        <p class="act-col-lbl act-col-lbl--duration">
          <span class="act-col-lbl__long">Total duration</span>
          <span class="act-col-lbl__short">Duration</span>
        </p>
        <p class="act-big">${formatDuration(activityDurTotal)}</p>
      </div>
    </div>
    <div class="act-summary-list" aria-label="Activity frequency and duration">`,
);
rep(/<div class="act-summary-list"[^>]*>[\s\S]*<\/div>\s*<\/div>\s*(?=<!-- HR Zones)/, () => {
  const inner = actRows.length ? `\n${actRows.join('\n')}\n    ` : '\n';
  return `<div class="act-summary-list" aria-label="Activity frequency and duration">${inner}</div>
  </div>

  `;
});

// HR zones
const hrzHtml = zoneRows
  .map(
    (z) => `    <div class="hrz-row">
      <span class="hrz-zone-lbl">${z.lbl}</span>
      <div class="hrz-track"><div class="hrz-bar" style="width:${z.w.toFixed(2)}%;${z.minW ? `min-width:${z.minW}px;` : ''}background:${z.color};"></div></div>
      <span class="hrz-time">${formatDuration(z.sec)}</span>
      </div>`,
  )
  .join('\n');
rep(
  /<!-- HR Zones[\s\S]*?-->\s*<div class="chart-card[^>]*>[\s\S]*?<\/div>\s*\r?\n\s*<\/div><!-- \/page-section: 30-day snapshot -->/,
  `<!-- HR Zones (data) -->
  <div class="chart-card reveal d1 chart-stack-gap">
    <div class="chart-hd">
      <p class="chart-title">Heart rate zones</p>
      </div>
${hrzHtml}
</div>

  </div><!-- /page-section: 30-day snapshot -->`,
);

// Bio cohort note
rep(
  /Reference numbers under each bar are cohort benchmarks for <strong>[^<]+<\/strong>\./,
  `Reference numbers under each bar are cohort benchmarks for <strong>${cohortLabel}</strong>.`,
);

function replaceBioRow(label, b) {
  const re = new RegExp(
    `(<span class="bio-row-name">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/span>[\\s\\S]*?<div class="bio-bench-track-wrap )bio-bench-track-wrap--(?:higher|lower)([\\s\\S]*?<div class="bio-bench-fill )bio-bench-fill--(?:green|amber|red|blue)(" style="width:)[^"]+`,
    'm',
  );
  html = html.replace(re, `$1${b.wrapLow}$2${b.fillMod}$3${b.width};background:${b.fillColor};`);

  const reDot = new RegExp(
    `(<span class="bio-row-name">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/span>[\\s\\S]*?<span class="bio-bench-dot" style="left:)[^%]+%`,
    'm',
  );
  html = html.replace(reDot, `$1${b.dotLeft}`);

  const reMark = new RegExp(
    `(<span class="bio-row-name">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/span>[\\s\\S]*?<div class="bio-bench-mark-row">\\s*)(?:<span[^>]*>[\\s\\S]*?<\\/span>\\s*){3}`,
    'm',
  );
  html = html.replace(
    reMark,
    `$1<span title="Bottom 10%">${b.m1}</span>
                  <span title="Average">${b.m2}</span>
                  <span title="Top 10%">${b.m3}</span>`,
  );

  const reVal = new RegExp(
    `(<span class="bio-row-name">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/span>[\\s\\S]*?<span class="bio-value">)[^<]*(</span><span class="bio-unit">)[^<]*(</span>)`,
    'm',
  );
  html = html.replace(reVal, `$1${b.val}$2${b.unit}$3`);

  const reBadge = new RegExp(
    `(<span class="bio-row-name">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/span>[\\s\\S]*?<span class="bio-badge )([\\w-]+)([^>]*>)[^<]*<`,
    'm',
  );
  html = html.replace(reBadge, `$1${b.badgeCls}$3${b.badgeText}<`);
}

replaceBioRow('VO₂ Max', bio.vo2);
replaceBioRow('HRV', bio.hrv);
replaceBioRow('Resting HR', bio.rhr);
replaceBioRow('Total sleep', bio.sleepH);
replaceBioRow('Sleep efficiency', bio.eff);
replaceBioRow('Disruptions', bio.dis);
replaceBioRow('REM', bio.rem);
replaceBioRow('Deep', bio.deep);
replaceBioRow('Light', bio.light);
replaceBioRow('Awake', bio.awake);

// Sleep chart nights array
const nightsStr = JSON.stringify(nights);
rep(/const nights = \[[\s\S]*?\];/, `const nights = ${nightsStr};`);
rep(
  /nights\.forEach\(\(night, i\) => \{[\s\S]*?groups \+= '<\/g>';\s*\}\);/,
  `nights.forEach((night, i) => {
        const x = Math.round(i * (W / n));
        const id = 'sleep-clip-' + i;
        defs += \`<clipPath id="\${id}"><rect x="\${x}" y="0" width="\${bw}" height="\${H}" rx="\${rx}" ry="\${rx}"/></clipPath>\`;
        groups += \`<g clip-path="url(#\${id})">\`;
        const hasData =
          Array.isArray(night) &&
          night.length === 4 &&
          night.some((v) => Number.isFinite(v) && v > 0);
        if (!hasData) {
          groups += \`<rect x="\${x}" y="0" width="\${bw}" height="\${H}" fill="#f3f4f6"/>\`;
          groups += \`<text x="\${x + bw / 2}" y="\${H / 2}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-90 \${x + bw / 2} \${H / 2})" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="6" font-weight="600" fill="#9ca3af" letter-spacing="0.06em">NO DATA</text>\`;
        } else {
          let y = H;
          night.forEach((pct, j) => {
            const h = Math.round((pct / 100) * H);
            y -= h;
            groups += \`<rect x="\${x}" y="\${y}" width="\${bw}" height="\${h}" fill="\${colors[j]}"/>\`;
          });
        }
        groups += '</g>';
      });`,
);

// Projection "Now" milestone
rep(/<p class="proj-val">67<\/p>\s*<p class="proj-lbl">Now<\/p>/, `<p class="proj-val">${healthScore}</p>
        <p class="proj-lbl">Now</p>`);

fs.writeFileSync(path.join(root, 'nutricode-health-report.html'), html, 'utf8');
console.log('Updated nutricode-health-report.html from raw_data.json');
