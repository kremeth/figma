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

let correlationCardsResolved = [];
let focusMetricsTags = [];
try {
  correlationCardsResolved = readJson('correlation_cards_resolved.json');
} catch {
  console.warn('correlation_cards_resolved.json not found; focus card copy uses fallbacks');
}
try {
  focusMetricsTags = readJson('focus_metrics_tags_supplements.json');
} catch {
  console.warn('focus_metrics_tags_supplements.json not found; using default focus order');
}

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
/** Rich rows for report_data.json (same filter as trimpPts). */
const trimpReportRows = [];
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
  trimpReportRows.push({
    day: d,
    duration_sec: dur,
    average_intensity: +ai,
    next_day_recovery: +nextRecovery,
    chart_x: x,
    chart_y: y,
    color_hex: color,
    recovery_band: nextRecovery >= 67 ? 'good' : nextRecovery >= 34 ? 'moderate' : 'poor',
  });
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

// ── Plug-and-play: score copy, focus payloads, focus stack HTML ──
function ageToRemBracket(age) {
  if (age == null || !Number.isFinite(+age)) return '26-35';
  const a = +age;
  if (a <= 25) return '18-25';
  if (a <= 35) return '26-35';
  if (a <= 45) return '36-45';
  if (a <= 55) return '46-55';
  if (a <= 65) return '56-65';
  return '66+';
}
function deriveRemPercentilesFromP50(p50) {
  const p50n = +p50;
  if (!Number.isFinite(p50n)) return { p50: 21, p30: 18.2, p60: 22.2, p90: 26.0 };
  return {
    p50: p50n,
    p30: Math.max(5, Math.round((p50n - 2.8) * 10) / 10),
    p60: Math.min(50, Math.round((p50n + 1.2) * 10) / 10),
    p90: Math.min(50, Math.round((p50n + 5.0) * 10) / 10),
  };
}

const remBracketKey = ageToRemBracket(meta.age ?? 30);
let remPctilesFC = deriveRemPercentilesFromP50(21);
const gRemNorm = normative?.rem_sleep?.[gender]?.[remBracketKey];
if (gRemNorm != null && typeof gRemNorm === 'object' && Number.isFinite(+gRemNorm.p50)) {
  remPctilesFC = {
    p50: +gRemNorm.p50,
    p30: +gRemNorm.p30,
    p60: +gRemNorm.p60,
    p90: +gRemNorm.p90,
  };
} else if (typeof gRemNorm === 'number' && Number.isFinite(gRemNorm)) {
  remPctilesFC = deriveRemPercentilesFromP50(gRemNorm);
}
const demographicRemPct = remPctilesFC.p50;

const numDaysFc = Math.max(1, Math.min(31, +(meta.num_days || 30)));
const dailyRemPct = Array.from({ length: numDaysFc }, (_, i) => {
  const k = String(i + 1);
  const secR = m.rem_sleep?.[k];
  const secS = m.sleep_time?.[k];
  if (secS == null || !Number.isFinite(+secS) || +secS <= 0) return null;
  if (secR == null || !Number.isFinite(+secR)) return null;
  return (100 * +secR) / +secS;
});

const deepDailyFC = Array(30).fill(null);
const intensityDailyFC = Array(30).fill(null);
for (let d = 1; d <= 30; d += 1) {
  const k = String(d);
  const ai = dailyAct?.[k]?.average_intensity;
  if (ai != null && Number.isFinite(+ai) && +ai > 0) intensityDailyFC[d - 1] = +ai;
  const st = m.sleep_time?.[k];
  const deep = m.deep_sleep?.[k];
  if (st != null && +st > 0 && deep != null && Number.isFinite(+deep) && +deep > 0) {
    deepDailyFC[d - 1] = (100 * +deep) / +st;
  }
}

const hrvByDayFC = Array.from({ length: numDaysFc }, (_, i) => {
  const v = m.HRV?.[String(i + 1)];
  if (v == null || !Number.isFinite(+v)) return null;
  return +v;
});
const hrvNormM = g(normative.hrv);
let targetHrvMin = Number.isFinite(hrvNormM) ? Math.max(20, Math.round(hrvNormM * 0.88)) : 100;
let targetHrvMax = Number.isFinite(hrvNormM) ? Math.max(targetHrvMin + 5, Math.round(hrvNormM * 1.12)) : 110;
if (targetHrvMin > targetHrvMax) {
  const t = targetHrvMin;
  targetHrvMin = targetHrvMax;
  targetHrvMax = t;
}

const scatterPtsFC = [];
for (let day = 1; day < numDaysFc; day += 1) {
  const today = dailyAct?.[String(day)];
  const x = today?.average_intensity;
  const yRaw = m.RHR?.[String(day + 1)];
  if (x == null || yRaw == null || !Number.isFinite(+x) || !Number.isFinite(+yRaw)) continue;
  scatterPtsFC.push({ x: +x, y: +yRaw });
}

function pickBestCorr(cards, pred) {
  const matches = (Array.isArray(cards) ? cards : []).filter(pred);
  if (!matches.length) return null;
  return matches.reduce((a, b) =>
    +(b.marginScore ?? -999) > +(a.marginScore ?? -999) ? b : a,
  );
}

const deepSleepCorr = pickBestCorr(
  correlationCardsResolved,
  (c) =>
    c.targetMetric === 'DeepSleep' &&
    String(c.label || '').includes('rolling') &&
    String(c.label || '').includes('Training Intensity'),
);
const rhrNextDayCorr = pickBestCorr(
  correlationCardsResolved,
  (c) =>
    c.targetMetric === 'RHR' &&
    String(c.csvKey || '').includes('RHR(t)') &&
    String(c.csvKey || '').includes('Training Intensity(t-1)'),
);
const lightRollingCorr = pickBestCorr(
  correlationCardsResolved,
  (c) =>
    c.targetMetric === 'LightSleep' &&
    String(c.label || '').includes('rolling') &&
    String(c.label || '').includes('Training Intensity'),
);

function escapeCorrText(t) {
  if (t == null) return '';
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

const lightCohortRaw = g(normative.light_sleep);
const lightCohortPct =
  typeof lightCohortRaw === 'number' && Number.isFinite(lightCohortRaw) ? lightCohortRaw : 57;

let remSummaryHtml = '';
if (remP < demographicRemPct - 0.05 && demographicRemPct > 0) {
  const pct = Math.round(((demographicRemPct - remP) / demographicRemPct) * 100);
  remSummaryHtml = `Your REM Sleep is <strong>${pct}%</strong> below your demographic average (<strong>${remP}%</strong> <strong>vs</strong> <strong>${Math.round(demographicRemPct)}%</strong>).`;
} else if (remP > demographicRemPct + 0.05 && demographicRemPct > 0) {
  const pct = Math.round(((remP - demographicRemPct) / demographicRemPct) * 100);
  remSummaryHtml = `Your REM Sleep is <strong>${pct}%</strong> above your demographic average (<strong>${remP}%</strong> <strong>vs</strong> <strong>${Math.round(demographicRemPct)}%</strong>).`;
} else {
  remSummaryHtml = `Your REM Sleep is near your demographic average (<strong>${remP}%</strong> <strong>vs</strong> <strong>${Math.round(demographicRemPct)}%</strong>).`;
}

let lightSummaryHtml = '';
if (lightP > lightCohortPct + 0.5) {
  const pct = Math.round(((lightP - lightCohortPct) / lightCohortPct) * 100);
  lightSummaryHtml = `Your Light Sleep is <strong>${pct}%</strong> above your demographic average (<strong>${lightP}%</strong> <strong>vs</strong> <strong>${Math.round(lightCohortPct)}%</strong>).`;
} else if (lightP < lightCohortPct - 0.5) {
  const pct = Math.round(((lightCohortPct - lightP) / lightCohortPct) * 100);
  lightSummaryHtml = `Your Light Sleep is <strong>${pct}%</strong> below your demographic average (<strong>${lightP}%</strong> <strong>vs</strong> <strong>${Math.round(lightCohortPct)}%</strong>).`;
} else {
  lightSummaryHtml = `Your Light Sleep is near your demographic average (<strong>${lightP}%</strong> <strong>vs</strong> <strong>${Math.round(lightCohortPct)}%</strong>).`;
}

const fc1Title = 'Boost REM Sleep';
const fc1Cap = 'Daily REM sleep vs demographic average';
const fc1WhyPanel =
  'REM sleep is essential for memory consolidation, emotional regulation, stress resilience, and neural recovery. Persistently low REM can reduce cognitive performance, increase perceived stress, and blunt adaptation to training. Raising REM helps your overnight recovery translate into better next-day readiness.';

const fc2Title = deepSleepCorr?.title ? escapeCorrText(deepSleepCorr.title) : 'Protect Deep Sleep';
const fc2Summary = deepSleepCorr?.body
  ? escapeCorrText(deepSleepCorr.body)
  : 'When training load runs high for several days in a row, deep sleep often compresses—timing recovery becomes important.';
const fc2Cap = 'Deep sleep % vs training intensity';
const fc2WhyPanel = deepSleepCorr?.how_it_works
  ? escapeCorrText(deepSleepCorr.how_it_works)
  : 'Your Deep Sleep is dropping during harder training weeks, reducing recovery time when your body needs it most. Keeping intensity in check on most days helps preserve deep sleep and long-term adaptation.';

const fc3Title = 'Lower Light Sleep';
const fc3Summary = lightSummaryHtml;
const fc3Cap = 'Nightly HRV (RMSSD)';
const fc3WhyPanel = lightRollingCorr?.how_it_works
  ? escapeCorrText(lightRollingCorr.how_it_works)
  : 'Excess light sleep often means your night is not progressing deeply enough into restorative deep and REM phases. If light sleep stays high, total sleep may look adequate while recovery quality remains suboptimal. Reducing light-sleep share supports better sleep architecture and improves physical and cognitive restoration.';

const fc4Title = rhrNextDayCorr?.title ? escapeCorrText(rhrNextDayCorr.title) : 'Recover Better';
const fc4Summary = rhrNextDayCorr?.body
  ? escapeCorrText(rhrNextDayCorr.body)
  : 'On harder training days, next-day resting heart rate often runs higher—recovery and sleep quality matter.';
const fc4Cap = 'Intensity vs Next-Day Resting Heart Rate';
const fc4WhyPanel = rhrNextDayCorr?.how_it_works
  ? escapeCorrText(rhrNextDayCorr.how_it_works)
  : 'The upward direction of the regression line suggests that harder sessions are currently creating more recovery stress, making post-training recovery especially important for protecting next-day RHR.';

let scoreHeadline = 'Building base';
if (healthScore >= 85) scoreHeadline = 'High performer';
else if (healthScore >= 75) scoreHeadline = 'Good progress';
else if (healthScore >= 60) scoreHeadline = 'Strong foundation';

const aheadPct = Math.min(94, Math.max(8, Math.round(healthScore * 0.65 + 12)));
const yourPeople = gender === 'female' ? 'women' : 'men';
const scoreContext = `You're already ahead of ${aheadPct}% of ${yourPeople} your age. In phase 1, we bring your metric health to 90+. In phase 2, we build long-term longevity from that stronger baseline.`;

let sortedFocusMetrics = [...focusMetricsTags].sort((a, b) => (a.order || 0) - (b.order || 0));
if (sortedFocusMetrics.length < 4) {
  sortedFocusMetrics = [
    { order: 1, metric: 'REM' },
    { order: 2, metric: 'DeepSleep' },
    { order: 3, metric: 'LightSleep' },
    { order: 4, metric: 'HRV' },
  ];
}
function metricDotLabel(metric) {
  if (metric === 'REM') return 'REM Sleep';
  if (metric === 'DeepSleep') return 'Deep Sleep';
  if (metric === 'LightSleep') return 'Light Sleep';
  if (metric === 'HRV') return 'Recovery';
  return String(metric || 'Priority');
}
const dotsButtonsHtml = sortedFocusMetrics
  .map((fm, idx) => {
    const lbl = metricDotLabel(fm.metric);
    const active = idx === 0 ? ' active' : '';
    const sel = idx === 0 ? 'true' : 'false';
    const tab = idx === 0 ? '0' : '-1';
    return `              <button type="button" class="rec-rhr-dot${active}" aria-label="${escAttr(lbl)}" role="tab" aria-selected="${sel}" aria-controls="focus-card-${idx + 1}" tabindex="${tab}"><span class="rec-rhr-dot__label" aria-hidden="true">${lbl}</span></button>`;
  })
  .join('\n');

const fc1Payload = {
  numDays: numDaysFc,
  dailyPct: dailyRemPct,
  remPctiles: remPctilesFC,
  demographicPct: demographicRemPct,
  metaGender: gender,
  metaAge: meta.age ?? 30,
};
const fc2Payload = { deepDaily: deepDailyFC, intensityDaily: intensityDailyFC };
const fc3Payload = {
  numDays: numDaysFc,
  hrvByDay: hrvByDayFC,
  targetMin: targetHrvMin,
  targetMax: targetHrvMax,
};
const fc4Payload = { points: scatterPtsFC };

const injectBlock = `  const FC1_REM_DATA = ${JSON.stringify(fc1Payload)};
  const FC2_DEEP_INT_DATA = ${JSON.stringify(fc2Payload)};
  const FC3_HRV_DATA = ${JSON.stringify(fc3Payload)};
  const FC4_SCATTER_DATA = ${JSON.stringify(fc4Payload)};`;

const focusStackHtml = `<!-- FOCUS_STACK_CORRELATION_START -->

        <div class="focus-card focus-card__shell is-active" id="focus-card-1" data-focus-index="0" role="article" aria-label="Priority 1 recommendation" style="--focus-card-accent-rgb: 0, 113, 227; --focus-card-text-color: #0a69d1;">
            <div class="focus-card__stage">
              <div class="fc1-accent" aria-hidden="true"></div>
              <div class="fc1-body">
                <div class="focus-card__head">
                  <h3 class="fc1-title">${fc1Title}</h3>
                  <p class="fc1-summary">${remSummaryHtml}</p>
                </div>
                <div class="fc1-sep" aria-hidden="true"></div>
                <div class="focus-card__mid">
                  <p class="fc1-cap">${fc1Cap}</p>
                  <div class="fc1-chart-panel">
                    <svg id="fc1-rem-chart" viewBox="14 38 269 140" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Daily REM sleep percent; bars colored by cohort percentile band (red through blue)"></svg>
                  </div>
                  <div class="fc1-legend" aria-hidden="true">
                    <div class="fc1-legend__item">
                      <span class="fc1-legend__swatch fc1-legend__swatch--avg"></span>
                      <span class="fc1-legend__label">Demographic Avg.</span>
                    </div>
                  </div>
                </div>
                <div class="fc1-footer">
                  <details class="fc1-why-details">
                    <summary>
                      <span class="focus-why-summary-row">
                        <span class="fc1-why-label">Why it matters</span>
                        <span class="fc1-why-icon" aria-hidden="true"></span>
                      </span>
                    </summary>
                    <p class="fc1-why-panel">${fc1WhyPanel}</p>
                  </details>
                </div>
              </div>
            </div>
        </div>

        <div class="focus-card focus-card__shell" id="focus-card-2" data-focus-index="1" role="article" aria-label="Priority 2 recommendation">
            <div class="focus-card__stage">
              <div class="fc2-accent" aria-hidden="true"></div>
              <div class="fc2-body">
                <div class="focus-card__head">
                  <h3 class="fc2-title">${fc2Title}</h3>
                  <p class="fc2-summary">${fc2Summary}</p>
                </div>
                <div class="fc2-sep" aria-hidden="true"></div>
                <div class="focus-card__mid">
                  <p class="fc2-cap">${fc2Cap}</p>
                  <div class="fc2-chart-panel">
                    <svg id="c-dual-deep-intensity" viewBox="0 0 400 210" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Daily deep sleep percentage (blue dots and line) and training intensity (yellow dots and line) over 30 days"></svg>
                  </div>
                  <div class="fc2-legend" aria-hidden="true">
                    <div class="fc2-legend__item">
                      <span class="fc2-legend__swatch fc2-legend__swatch--deep"></span>
                      <span class="fc2-legend__label">Deep Sleep %</span>
                    </div>
                    <div class="fc2-legend__item">
                      <span class="fc2-legend__swatch fc2-legend__swatch--load"></span>
                      <span class="fc2-legend__label">Training Load</span>
                    </div>
                  </div>
                </div>
                <div class="fc2-footer">
                  <details class="fc2-why-details">
                    <summary>
                      <span class="focus-why-summary-row">
                        <span class="fc2-why-label">Why it matters</span>
                        <span class="fc2-why-icon" aria-hidden="true"></span>
                      </span>
                    </summary>
                    <p class="fc2-why-panel">${fc2WhyPanel}</p>
                  </details>
                </div>
              </div>
            </div>
        </div>

        <div class="focus-card focus-card__shell" id="focus-card-3" data-focus-index="2" role="article" aria-label="Priority 3 recommendation" style="--focus-card-accent-rgb: 0, 113, 227; --focus-card-text-color: #0a69d1;">
            <div class="focus-card__stage">
              <div class="fc3-accent" aria-hidden="true"></div>
              <div class="fc3-body">
                <div class="focus-card__head">
                  <h3 class="fc3-title">${fc3Title}</h3>
                  <p class="fc3-summary">${fc3Summary}</p>
                </div>
                <div class="fc3-sep" aria-hidden="true"></div>
                <div class="focus-card__mid">
                  <p class="fc3-cap">${fc3Cap}</p>
                  <div class="fc3-chart-panel">
                    <svg id="fc3-hrv-chart" viewBox="14 38 269 140" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Nightly HRV; shaded target band; blue dots in band"></svg>
                </div>
                  <div class="fc3-legend" aria-hidden="true">
                    <div class="fc3-legend__item">
                      <span class="fc3-legend__swatch fc3-legend__swatch--target-range"></span>
                      <span class="fc3-legend__label">Target range</span>
                    </div>
                  </div>
                </div>
                <div class="fc3-footer">
                  <details class="fc3-why-details">
                    <summary>
                      <span class="focus-why-summary-row">
                        <span class="fc3-why-label">Why it matters</span>
                        <span class="fc3-why-icon" aria-hidden="true"></span>
                      </span>
                    </summary>
                    <p class="fc3-why-panel">${fc3WhyPanel}</p>
                  </details>
                </div>
              </div>
            </div>
        </div>

        <div class="focus-card focus-card__shell" id="focus-card-4" data-focus-index="3" role="article" aria-label="Priority 4 recommendation" style="--focus-card-accent-rgb: 0, 113, 227; --focus-card-text-color: #0a69d1;">
            <div class="focus-card__stage">
              <div class="fc4-accent" aria-hidden="true"></div>
              <div class="fc4-body">
                <div class="focus-card__head">
                  <h3 class="fc4-title">${fc4Title}</h3>
                  <p class="fc4-summary">${fc4Summary}</p>
                </div>
                <div class="fc4-sep" aria-hidden="true"></div>
                <div class="focus-card__mid">
                  <p class="fc4-cap">${fc4Cap}</p>
                  <div class="fc4-chart-panel">
                    <svg id="c-scatter" class="trimp-chart focus-scatter-svg" viewBox="-60 0 320 156" overflow="visible" fill="none" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Scatter of training intensity versus next-day resting heart rate">
                      <title>Next-day resting heart rate versus same-day training intensity.</title>
                    </svg>
                  </div>
                  <div class="fc4-legend" aria-hidden="true">
                    <div class="fc4-legend__item">
                      <span class="fc4-legend__swatch fc4-legend__swatch--reg" aria-hidden="true"></span>
                      <span class="fc4-legend__label">Regression Line</span>
                    </div>
                  </div>
                </div>
                <div class="fc4-footer">
                  <details class="fc4-why-details">
                    <summary>
                      <span class="focus-why-summary-row">
                        <span class="fc4-why-label">Why it matters</span>
                        <span class="fc4-why-icon" aria-hidden="true"></span>
                      </span>
                    </summary>
                    <p class="fc4-why-panel">${fc4WhyPanel}</p>
                  </details>
                </div>
              </div>
            </div>
        </div>
<!-- FOCUS_STACK_CORRELATION_END -->`;

let html = fs.readFileSync(path.join(root, 'nutricode-health-report.html'), 'utf8');

function rep(re, fn) {
  const before = html;
  html = typeof fn === 'string' ? html.replace(re, fn) : html.replace(re, fn);
  if (html === before && !before.match(re)) console.warn('Pattern missed:', re);
}

rep(
  /(?:[ \t]*\/\/ REPORT_INJECT_FOCUS_DATA\s*\r?\n|  const FC1_REM_DATA = .*\r?\n  const FC2_DEEP_INT_DATA = .*\r?\n  const FC3_HRV_DATA = .*\r?\n  const FC4_SCATTER_DATA = .*\r?\n)/,
  `${injectBlock}\n`,
);
rep(
  /<!-- FOCUS_STACK_CORRELATION_START -->[\s\S]*?<!-- FOCUS_STACK_CORRELATION_END -->/,
  focusStackHtml,
);
rep(
  /(<div class="rec-rhr-dots" id="recRhrDots" role="tablist" aria-label="Choose priority recommendation">)\s*[\s\S]*?(\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="focus-carousel reveal d1" id="focusCarousel")/,
  `$1\n${dotsButtonsHtml}\n            $2`,
);
rep(/<p class="score-headline">[^<]*<\/p>/, `<p class="score-headline">${scoreHeadline}</p>`);
rep(/<p class="score-context">[^<]*<\/p>/, `<p class="score-context">${scoreContext}</p>`);
rep(
  /<h2 class="section-label section-label--caps" id="focus-heading">[\s\S]*?<\/h2>/,
  `<h2 class="section-label section-label--caps" id="focus-heading">How you move from<br />${healthScore} to 90+</h2>`,
);
rep(
  /aria-label="Health score rises from \d+ toward 90/,
  `aria-label="Health score rises from ${healthScore} toward 90`,
);
rep(
  /<title>Projection: score from \d+ toward 90\+ then sustained<\/title>/,
  `<title>Projection: score from ${healthScore} toward 90+ then sustained</title>`,
);
rep(
  /<!-- Points: start \(\d+\), transition/,
  `<!-- Points: start (${healthScore}), transition`,
);
rep(
  /(<text x="10" y="112" text-anchor="middle" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="10" fill="rgba\(0,0,0,0\.5\)">)\d+(<\/text>)/,
  `$1${healthScore}$2`,
);

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

function bioJson(b) {
  return {
    value_display: b.val,
    unit: b.unit,
    bar_width: b.width,
    dot_position: b.dotLeft,
    fill_hex: b.fillColor,
    bench_bottom10: b.m1,
    bench_average: b.m2,
    bench_top10: b.m3,
    badge_cls: b.badgeCls,
    badge_text: b.badgeText,
  };
}

const reportData = {
  meta: {
    date_range: metaLine,
    device: meta.device ?? null,
    gender,
    age_band: band,
    cohort_label: cohortLabel,
    num_days: numDaysFc,
  },
  health_score: {
    score: healthScore,
    headline: scoreHeadline,
    context: scoreContext,
    phase_current: 1,
    phase_total: 2,
    ring_circumference: C,
    ring_dash: +dash.toFixed(2),
    ring_dash_gap: +dashRest.toFixed(2),
  },
  limiting_metrics: limits.map((l) => ({ name: l.name, badge: l.badge, dot: l.dot })),
  snapshot: {
    avg_recovery: {
      value: recoveryAvg != null ? Math.round(recoveryAvg) : null,
      tag: recTag.text,
      tag_cls: recTag.cls,
      foot_text: recFoot.text,
    },
    sleep_performance: {
      value: sleepScoreAvg != null ? Math.round(sleepScoreAvg) : null,
      tag: sleepTag.text,
      tag_cls: sleepTag.cls,
      foot_text: sleepFoot,
    },
    avg_training_intensity: {
      value: trimpAvg != null ? +trimpAvg.toFixed(1) : null,
      tag: tr.tag,
      tag_cls: trimpTagClass(tr.tag),
      foot_text: tr.foot,
    },
  },
  recovery_donut: {
    average_pct: recoveryDonutAvg,
    high_days: hi,
    moderate_days: med,
    low_days: lo,
    legend_high_range: '67%+',
    legend_moderate_range: '34–66%',
    legend_low_range: '0–33%',
  },
  sleep_breakdown: {
    avg_rem_pct: remP,
    avg_deep_pct: deepP,
    avg_light_pct: lightP,
    avg_awake_pct: awakeP,
    nights,
  },
  training_intensity_vs_next_day_recovery: {
    points: trimpReportRows,
  },
  activities: {
    total_count: activityCount,
    total_duration_sec: activityDurTotal,
    total_duration_fmt: formatDuration(activityDurTotal),
    by_sport: sports.map((s) => ({
      key: s.name,
      display_name: sportTitle(s.name),
      session_count: s.total,
      duration_sec: s.dur,
      duration_fmt: formatDuration(s.dur),
    })),
  },
  heart_rate_zones: zoneRows.map((z) => ({
    zone_label: z.lbl,
    seconds: z.sec,
    time_fmt: formatDuration(z.sec),
    bar_width_pct: +z.w.toFixed(2),
    color: z.color,
  })),
  biometric_health: {
    cardiovascular: {
      vo2_max: bioJson(bio.vo2),
      hrv: bioJson(bio.hrv),
      resting_hr: bioJson(bio.rhr),
    },
    sleep_quality: {
      total_sleep: bioJson(bio.sleepH),
      sleep_efficiency: bioJson(bio.eff),
      disruptions_per_hour: bioJson(bio.dis),
    },
    sleep_stages: {
      rem_pct: bioJson(bio.rem),
      deep_pct: bioJson(bio.deep),
      light_pct: bioJson(bio.light),
      awake_pct: bioJson(bio.awake),
    },
  },
  focus_section: {
    heading_template: `How you move from ${healthScore} to 90+`,
    tab_order: sortedFocusMetrics.map((fm, idx) => ({
      priority: idx + 1,
      metric: fm.metric,
      tab_label: metricDotLabel(fm.metric),
    })),
    cards: [
      {
        slot: 1,
        dom_id: 'focus-card-1',
        chart_type: 'rem_bars',
        tab_label: 'REM Sleep',
        title: fc1Title,
        summary_html: remSummaryHtml,
        chart_caption: fc1Cap,
        why_panel: fc1WhyPanel,
        chart_data: fc1Payload,
      },
      {
        slot: 2,
        dom_id: 'focus-card-2',
        chart_type: 'deep_sleep_vs_intensity_dual',
        tab_label: 'Deep Sleep',
        title: fc2Title,
        summary_html: fc2Summary,
        chart_caption: fc2Cap,
        why_panel: fc2WhyPanel,
        chart_data: fc2Payload,
        correlation: deepSleepCorr
          ? { label: deepSleepCorr.label, marginScore: deepSleepCorr.marginScore, csvKey: deepSleepCorr.csvKey }
          : null,
      },
      {
        slot: 3,
        dom_id: 'focus-card-3',
        chart_type: 'hrv_nightly',
        tab_label: 'Light Sleep',
        title: fc3Title,
        summary_html: fc3Summary,
        chart_caption: fc3Cap,
        why_panel: fc3WhyPanel,
        chart_data: fc3Payload,
        correlation_light_load: lightRollingCorr
          ? { label: lightRollingCorr.label, marginScore: lightRollingCorr.marginScore }
          : null,
      },
      {
        slot: 4,
        dom_id: 'focus-card-4',
        chart_type: 'intensity_vs_next_day_rhr_scatter',
        tab_label: 'Recovery',
        title: fc4Title,
        summary_html: fc4Summary,
        chart_caption: fc4Cap,
        why_panel: fc4WhyPanel,
        chart_data: fc4Payload,
        correlation: rhrNextDayCorr
          ? { label: rhrNextDayCorr.label, marginScore: rhrNextDayCorr.marginScore, csvKey: rhrNextDayCorr.csvKey }
          : null,
      },
    ],
  },
};

fs.writeFileSync(path.join(root, 'report_data.json'), `${JSON.stringify(reportData, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(root, 'nutricode-health-report.html'), html, 'utf8');
console.log('Updated nutricode-health-report.html and report_data.json from raw_data.json');
