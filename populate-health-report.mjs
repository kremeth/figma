#!/usr/bin/env node
/**
 * Fills nutricode-health-report.html from raw_data.json + cohort JSON files.
 * Run from repo root: node populate-health-report.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const require = createRequire(import.meta.url);
const {
  optimalBand: varianceOptimalBand,
  meanOf: varianceMeanOf,
  analyzeSeries: varianceAnalyzeSeries,
} = require('./varianceRules.js');

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const raw = readJson('raw_data2.json');
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

/** Minimal RFC-4180 CSV parser that handles quoted fields (including embedded commas/newlines). */
function parseCsvRow(line) {
  const fields = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

function parseCsv(text) {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let current = '';
  let inQ = false;
  for (let i = 0; i < rawLines.length; i++) {
    const ch = rawLines[i];
    if (ch === '"') inQ = !inQ;
    if (ch === '\n' && !inQ) { rows.push(current); current = ''; }
    else current += ch;
  }
  if (current.trim()) rows.push(current);
  const [headerLine, ...dataLines] = rows.filter(r => r.trim());
  const headers = parseCsvRow(headerLine);
  return dataLines.map(line => {
    const vals = parseCsvRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] ?? '').trim(); });
    return obj;
  });
}

const mainCardsRows = parseCsv(
  fs.readFileSync(path.join(root, 'correlation_cards - main_cards.csv'), 'utf8')
);

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

// ─── Overall health score card (single source of truth) ───────────────────────

const RING_STROKE_PHASE1 = '#17FF00';
const RING_STROKE_PHASE2 = '#5b8fd8';

function menWomenFromGender(g) {
  return g === 'female' ? 'women' : 'men';
}

/**
 * Demographic mean μ for the Nutricode composite (0–100), by age band (and sex).
 * **Source of truth today:** inline calibration table (not yet in normative_metrics.json).
 * If you add published cohort means by sex, replace the body of this function to read them.
 */
function demographicCompositeScoreMean(ageBandKey, genderKey) {
  const byBand = {
    '18-25': 65,
    '26-35': 64,
    '36-45': 63,
    '46-55': 62,
    '56-65': 61,
    '66+': 60,
  };
  let mu = byBand[ageBandKey];
  if (mu == null) mu = 63;
  if (genderKey === 'female') mu -= 0.5;
  return mu;
}

/** Fixed σ for normal approximation of composite score (not in JSON — tune with cohort data). */
const COMPOSITE_SCORE_SD = 14;

/** Standard normal CDF Φ(z), Abramowitz & Stegun (symmetric in z). */
function normalCdf(z) {
  if (!Number.isFinite(z)) return 0.5;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

/** Ordinal for "You're in the [P]th percentile" → replaces "[P]th" with e.g. "71st". */
function ordinalEnglish(n) {
  const k = Math.round(Number(n));
  if (!Number.isFinite(k)) return `${n}th`;
  const x = Math.abs(k) % 100;
  const y = x % 10;
  if (x >= 11 && x <= 13) return `${k}th`;
  if (y === 1) return `${k}st`;
  if (y === 2) return `${k}nd`;
  if (y === 3) return `${k}rd`;
  return `${k}th`;
}

/**
 * Approximate percentile P (1–99) of composite score vs cohort mean μ for age/sex.
 * Model: Φ((score−μ)/σ) with σ = COMPOSITE_SCORE_SD. This is **not** a vendor-supplied
 * percentile; swap `healthScorePercentileP` for real distribution data when available.
 */
function healthScorePercentileP(score, ageBandKey, genderKey) {
  const mu = demographicCompositeScoreMean(ageBandKey, genderKey);
  const s = Number(score);
  if (!Number.isFinite(s) || !Number.isFinite(mu)) return 50;
  const z = (s - mu) / COMPOSITE_SCORE_SD;
  const p = normalCdf(z) * 100;
  return Math.min(99, Math.max(1, Math.round(p)));
}

function scoreBandIdFromScore(score) {
  const s = +score;
  if (s >= 95) return '95-100';
  if (s >= 90) return '90-94';
  if (s >= 85) return '85-89';
  if (s >= 80) return '80-84';
  if (s >= 70) return '70-79';
  if (s >= 60) return '60-69';
  if (s >= 50) return '50-59';
  return 'below-50';
}

/** Exact title + copy templates (placeholders: [P]th, [men/women]). */
const OVERALL_HEALTH_SCORE_BANDS = {
  '95-100': {
    title: 'Exceptional baseline',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. You're already in phase 2, where we work on longevity from an already strong baseline.",
  },
  '90-94': {
    title: 'Phase 2 unlocked',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. You've entered phase 2, where we refine the last weak points and begin working on longevity.",
  },
  '85-89': {
    title: 'Final push',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. In phase 1, the focus is on refining the remaining limiting metrics so your score reaches 90+, where phase 2 begins and the focus shifts to longevity.",
  },
  '80-84': {
    title: 'Strong base',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. You already have a strong base. In phase 1, the focus is to bring your score to 90+. In phase 2, the focus shifts to longevity.",
  },
  '70-79': {
    title: 'Good progress',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. In phase 1, the focus is on improving the limiting metrics that will move your score to 90+, where phase 2 begins and the focus shifts to longevity.",
  },
  '60-69': {
    title: 'Promising base',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. Phase 1 focuses on moving your score toward 90+. Phase 2 then shifts to longevity.",
  },
  '50-59': {
    title: 'Build momentum',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. Phase 1 is about moving your score toward 90+, where phase 2 begins and the focus shifts to longevity.",
  },
  'below-50': {
    title: 'Build the foundation',
    copy: "You're in the [P]th percentile for health metrics among [men/women] your age. Phase 1 is about moving your score toward 90+, where phase 2 begins and the focus shifts to longevity.",
  },
};

function hydrateOverallHealthCopy(template, P, people) {
  return template.replace('[men/women]', people).replace('[P]th', ordinalEnglish(P));
}

/**
 * Single source of truth for the metric-health score card.
 * @param {number|null} percentileOverride — if set (e.g. tests), skip internal P model.
 */
function getOverallHealthScoreState(score, genderKey, ageBandKey, percentileOverride = null) {
  const bandId = scoreBandIdFromScore(score);
  const def = OVERALL_HEALTH_SCORE_BANDS[bandId];
  const people = menWomenFromGender(genderKey);
  const P =
    percentileOverride != null && Number.isFinite(+percentileOverride)
      ? Math.min(99, Math.max(1, Math.round(+percentileOverride)))
      : healthScorePercentileP(score, ageBandKey, genderKey);
  const copy = hydrateOverallHealthCopy(def.copy, P, people);
  const phase = +score >= 90 ? 'phase2' : 'phase1';
  const circleColor = +score >= 90 ? RING_STROKE_PHASE2 : RING_STROKE_PHASE1;
  return {
    bandId,
    title: def.title,
    copy,
    phase,
    circleColor,
    percentile: P,
    demographicMean: demographicCompositeScoreMean(ageBandKey, genderKey),
  };
}

/** Maps getOverallHealthScoreState → populate/HTML fields (phase 1|2 as number). */
function scorePhaseFromOverallState(state) {
  const n = state.phase === 'phase2' ? 2 : 1;
  return {
    bandId: state.bandId,
    title: state.title,
    contextCopy: state.copy,
    phase: n,
    ringStroke: state.circleColor,
    scoreRingWrapClass: n >= 2 ? 'score-ring-wrap score-ring-wrap--phase2' : 'score-ring-wrap',
  };
}

function metricHealthPhaseRowHtml(phase) {
  if (phase >= 2) {
    return `<div class="metric-health-phase-row">
            <span class="phase-badge phase-badge--phase2-active">Phase 2</span>
            <div class="phase-track" role="img" aria-label="Phase 2 of 2">
              <span class="phase-seg phase-seg--done"></span>
              <span class="phase-seg phase-seg--active"></span>
            </div>
            <span class="phase-of">of 2</span>
          </div>`;
  }
  return `<div class="metric-health-phase-row">
            <span class="phase-badge">Phase 1</span>
            <div class="phase-track" role="img" aria-label="Phase 1 of 2">
              <span class="phase-seg phase-seg--on"></span>
              <span class="phase-seg"></span>
            </div>
            <span class="phase-of">of 2</span>
          </div>`;
}

/** CLI: node populate-health-report.mjs --validate-health-score-phases */
function logHealthScorePhaseValidation() {
  const testScores = [49, 55, 64, 74, 82, 87, 92, 97];
  const g = 'male';
  const b = '26-35';
  const mean = demographicCompositeScoreMean(b, g);
  console.log(
    '\n--- Overall health score card validation (gender=male, band=26-35, μ=%s, σ=%s, P=Φ((score−μ)/σ)) ---\n',
    mean,
    COMPOSITE_SCORE_SD,
  );
  for (const s of testScores) {
    const st = getOverallHealthScoreState(s, g, b);
    console.log(
      JSON.stringify(
        {
          score: s,
          title: st.title,
          copy: st.copy,
          phase: st.phase,
          circleColor: st.circleColor,
          gender_placeholder_used: menWomenFromGender(g),
        },
        null,
        2,
      ),
    );
    console.log('');
  }
}

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
  // Colour bands: low → red, moderate → amber, high → green (footer + pill match recovery/sleep pattern).
  if (x < 1.0) return { tag: 'Easy', foot: 'Low VO2 Max stimulus', cls: 'snap-ft--neg' };
  if (x < 1.5) return { tag: 'Easy', foot: 'Low VO2 Max stimulus', cls: 'snap-ft--neg' };
  if (x < 2.0) return { tag: 'Moderate', foot: 'Moderate VO2 Max stimulus', cls: 'snap-ft--warn' };
  if (x < 2.5) return { tag: 'Hard', foot: 'High VO2 Max stimulus', cls: 'snap-ft--pos' };
  return { tag: 'Very hard', foot: 'High VO2 Max stimulus', cls: 'snap-ft--pos' };
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
  if (tag === 'Easy') return 'snap-tag--vhard'; // low intensity → red
  if (tag === 'Moderate') return 'snap-tag--moderate';
  if (tag === 'Hard' || tag === 'Very hard') return 'snap-tag--easy'; // high intensity → green
  return 'snap-tag--vhard';
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

function trimpYFromIntensity(i) {
  // Chart Y: higher intensity is higher (smaller y)
  const minY = 231;
  const maxY = 10;
  const minI = 0.8;
  const maxI = 2.8;
  const t = clamp((i - minI) / (maxI - minI), 0, 1);
  return Math.round(minY - t * (minY - maxY));
}

/** Projection roadmap graph variant shown in "Your path to longevity". */
function projectionBandFromScore(score) {
  if (score >= 90) return 'blue';
  if (score >= 75) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

/** X-axis span: max observed workout duration rounded up to whole hours; default 6h when no points. */
const trimpRawRows = [];
for (let d = 1; d <= (meta.num_days || 30); d++) {
  const row = dailyAct?.[String(d)];
  const dur = row?.total_duration;
  const ai = row?.average_intensity;
  const nextRecovery = m.recovery?.[String(d + 1)];
  if (!Number.isFinite(dur) || !Number.isFinite(ai) || !Number.isFinite(nextRecovery)) continue;
  trimpRawRows.push({ d, dur, ai, nextRecovery });
}
let trimpChartMaxDurationSec = 6 * 3600;
if (trimpRawRows.length > 0) {
  const maxDur = Math.max(...trimpRawRows.map((r) => r.dur));
  trimpChartMaxDurationSec = Math.max(3600, Math.ceil(maxDur / 3600) * 3600);
}

function trimpXFromDurationSec(sec) {
  const minX = 48;
  const maxX = 438;
  const maxSec = trimpChartMaxDurationSec;
  const t = Math.min(1, Math.max(0, sec / maxSec));
  return Math.round(minX + t * (maxX - minX));
}

function buildTrimpChartAxesSvg(maxDurationSec) {
  const minX = 48;
  const maxX = 438;
  const plotTop = 10;
  const plotBottom = 231;
  const hourCount = Math.max(1, Math.round(maxDurationSec / 3600));
  const tickXs = [];
  for (let h = 0; h <= hourCount; h++) {
    tickXs.push(Math.round(minX + (h / hourCount) * (maxX - minX)));
  }
  const innerVerticals = tickXs
    .slice(1, -1)
    .map((x) => `        <line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}"/>`)
    .join('\n');
  const bottomLabels = tickXs
    .map((x, idx) => {
      const label = `${idx}:00`;
      const anchor = idx === 0 ? 'middle' : idx === hourCount ? 'end' : 'middle';
      return `      <text x="${x}" y="246" text-anchor="${anchor}" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="8" fill="#9ca3af">${label}</text>`;
    })
    .join('\n');
  const innerBlock = innerVerticals ? `${innerVerticals}\n` : '';
  return `      <line x1="${minX}" y1="${plotTop}" x2="${minX}" y2="${plotBottom}" stroke="#e9e8e3" stroke-width="1"/>
      <g stroke="#eeece7" stroke-width="1">
${innerBlock}        <line x1="${minX}" y1="136" x2="${maxX}" y2="136"/>
        <line x1="${minX}" y1="83" x2="${maxX}" y2="83"/>
        <line x1="${minX}" y1="41" x2="${maxX}" y2="41"/>
        <line x1="${minX}" y1="${plotTop}" x2="${maxX}" y2="${plotTop}"/>
      </g>
      <line x1="${minX}" y1="${plotBottom}" x2="${maxX}" y2="${plotBottom}" stroke="#e9e8e3" stroke-width="1"/>
      <text x="44" y="188" text-anchor="end" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="8" font-weight="400" fill="#d1d5db" letter-spacing="0.05em">EASY</text>
      <text x="44" y="112" text-anchor="end" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="8" font-weight="400" fill="#d1d5db" letter-spacing="0.05em">MODERATE</text>
      <text x="44" y="64" text-anchor="end" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="8" font-weight="400" fill="#d1d5db" letter-spacing="0.05em">HARD</text>
      <text x="44" y="27" text-anchor="end" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="8" font-weight="400" fill="#d1d5db" letter-spacing="0.05em">VERY HARD</text>
${bottomLabels}
      <text x="243" y="260" text-anchor="middle" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="8" font-weight="400" fill="#9ca3af" letter-spacing="0.08em">DURATION</text>`;
}

const trimpChartAxesSvg = buildTrimpChartAxesSvg(trimpChartMaxDurationSec);

const trimpPts = [];
/** Rich rows for report_data.json (same filter as trimpPts). */
const trimpReportRows = [];
for (const { d, dur, ai, nextRecovery } of trimpRawRows) {
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

const overallHealthScoreState = getOverallHealthScoreState(healthScore, gender, band);
const scorePhase = scorePhaseFromOverallState(overallHealthScoreState);
const scoreHeadline = scorePhase.title;
const scoreContext = scorePhase.contextCopy;
const projectionBand = projectionBandFromScore(healthScore);

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
      standingPct: null,
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
  const hasUser = userVal != null && Number.isFinite(userVal);
  /** ~peer percentile (higher = better vs cohort); used for score-context headline. */
  const standingPct = hasUser ? round1(scoreRatio * 100) : null;
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
    standingPct,
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

/** Mean cohort standing (0–100) across biometric rows with valid data; drives "ahead of X%". */
const bioStandingSamples = Object.values(bio)
  .map((row) => row.standingPct)
  .filter((x) => x != null && Number.isFinite(x));
const aheadPctFallback = Math.min(94, Math.max(8, Math.round(healthScore * 0.65 + 12)));
const aheadPct =
  bioStandingSamples.length > 0
    ? Math.min(
        94,
        Math.max(8, Math.round(bioStandingSamples.reduce((a, b) => a + b, 0) / bioStandingSamples.length)),
      )
    : aheadPctFallback;

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

// Limiting metrics: issue-first selection (below avg → below target → unstable → variable),
// ranked by severity, fallback to longevity priorities if no Tier 1–4 issues exist.
const metricLimitMeta = {
  hrv: { name: 'HRV', higherBetter: true, user: () => hrvAvg, cohort: () => c.hrv, varianceMetricId: 'HRV' },
  vo2: { name: 'VO₂ max', higherBetter: true, user: () => vo2Avg, cohort: () => c.vo2, varianceMetricId: null },
  rhr: { name: 'Resting HR', higherBetter: false, user: () => rhrAvg, cohort: () => c.rhr, varianceMetricId: 'RHR' },
  deep: { name: 'Deep sleep', higherBetter: true, user: () => deepP, cohort: () => c.deep, varianceMetricId: 'DeepSleep' },
  eff: { name: 'Sleep efficiency', higherBetter: true, user: () => effPct, cohort: () => c.eff, varianceMetricId: null },
  dis: { name: 'Sleep disruptions', higherBetter: false, user: () => disturbPerHr, cohort: () => c.dis, varianceMetricId: 'Disruptions' },
  rem: { name: 'REM sleep', higherBetter: true, user: () => remP, cohort: () => c.rem, varianceMetricId: 'REM' },
  sleep: { name: 'Total sleep', higherBetter: true, user: () => hoursSleep, cohort: () => c.sleepH, varianceMetricId: 'TotalSleep' },
  awake: { name: 'Overnight awake time', higherBetter: false, user: () => awakeP, cohort: () => c.awake, varianceMetricId: 'Awake' },
  light: { name: 'Light sleep', higherBetter: false, user: () => lightP, cohort: () => c.light, varianceMetricId: 'LightSleep' },
};

function pctDeficitVsBenchmark(user, bench, higherBetter) {
  if (user == null || bench == null || !Number.isFinite(+user) || !Number.isFinite(+bench) || Math.abs(+bench) < 1e-9) {
    return null;
  }
  if (higherBetter) {
    if (+user >= +bench) return 0;
    return Math.round((100 * (+bench - +user)) / Math.abs(+bench));
  }
  if (+user <= +bench) return 0;
  return Math.round((100 * (+user - +bench)) / Math.abs(+bench));
}

function deficitLabelFromBenchmark(pctDeficit, higherBetter, baselineKind) {
  if (pctDeficit == null || pctDeficit <= 0) return '';
  const dirWord = higherBetter ? 'below' : 'above';
  const baselineWord = baselineKind === 'average' ? 'average' : 'target';
  return `${dirWord} ${baselineWord}`;
}

/** Match bio-bar semantics: avg is center of sorted triplet; target is best side by direction. */
function canonicalBenchmarksFromTriplet(triple, higherBetter) {
  const vals = [triple?.L, triple?.M, triple?.R].map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (vals.length < 3) return { avg: null, target: null, sorted: vals };
  vals.sort((a, b) => a - b);
  const avg = vals[1];
  const target = higherBetter ? vals[2] : vals[0];
  return { avg, target, sorted: vals };
}

function varianceIssueSeries(metricId) {
  const days = Math.max(1, Math.min(31, +(meta.num_days || 30)));
  return Array.from({ length: days }, (_, i) => {
    const k = String(i + 1);
    if (metricId === 'HRV') {
      const v = m.HRV?.[k];
      return v == null || !Number.isFinite(+v) ? null : +v;
    }
    if (metricId === 'RHR') {
      const v = m.RHR?.[k];
      return v == null || !Number.isFinite(+v) ? null : +v;
    }
    if (metricId === 'TotalSleep') {
      const sec = m.sleep_time?.[k];
      return sec == null || !Number.isFinite(+sec) || +sec <= 0 ? null : +sec / 3600;
    }
    if (metricId === 'Disruptions') {
      const d = m.disturbances?.[k];
      const s = m.sleep_time?.[k];
      if (d == null || s == null || !Number.isFinite(+d) || !Number.isFinite(+s) || +s <= 0) return null;
      return +d / (+s / 3600);
    }
    const secByMetric = {
      REM: m.rem_sleep,
      DeepSleep: m.deep_sleep,
      LightSleep: m.light_sleep,
      Awake: m.awake_time,
    }[metricId];
    if (!secByMetric) return null;
    const secMetric = secByMetric?.[k];
    const secSleep = m.sleep_time?.[k];
    if (secMetric == null || secSleep == null || !Number.isFinite(+secMetric) || !Number.isFinite(+secSleep) || +secSleep <= 0) {
      return null;
    }
    return (100 * +secMetric) / +secSleep;
  });
}

/**
 * Single helper for limiting-card issue logic.
 * Priority per metric:
 * 1) below_average
 * 2) below_target
 * 3) unstable
 * 4) variable
 */
function determineMetricIssue(def) {
  const meta = metricLimitMeta[def.key];
  if (!meta) return null;
  const user = meta.user();
  const cohort = meta.cohort() || {};
  const bench = canonicalBenchmarksFromTriplet(cohort, meta.higherBetter);
  const avg = bench.avg;
  const target = bench.target;

  const pctBelowAvg = pctDeficitVsBenchmark(user, avg, meta.higherBetter);
  const pctBelowTarget = pctDeficitVsBenchmark(user, target, meta.higherBetter);

  let issueType = null;
  let label = '';
  let severityScore = 0;

  if (pctBelowAvg != null && pctBelowAvg > 0) {
    issueType = 'below_average';
    label = deficitLabelFromBenchmark(pctBelowAvg, meta.higherBetter, 'average');
    severityScore = 4000 + pctBelowAvg; // always rank above below_target
  } else if (pctBelowTarget != null && pctBelowTarget > 0) {
    issueType = 'below_target';
    label = deficitLabelFromBenchmark(pctBelowTarget, meta.higherBetter, 'target');
    severityScore = 3000 + pctBelowTarget;
  } else {
    let stability = null;
    if (meta.varianceMetricId) {
      const series = varianceIssueSeries(meta.varianceMetricId)
        .filter((v) => v != null && Number.isFinite(+v))
        .map(Number);
      stability = varianceAnalyzeSeries(series, meta.varianceMetricId);
    }
    const outsidePct =
      stability && Number.isFinite(stability.daysInRangePct)
        ? Math.max(0, Math.min(100, Math.round(100 - stability.daysInRangePct)))
        : 0;
    if (stability?.tier === 'unstable') {
      issueType = 'unstable';
      label = 'unstable';
      severityScore = 2000 + outsidePct;
    } else if (stability?.tier === 'variable') {
      issueType = 'variable';
      label = 'variable';
      severityScore = 1000 + outsidePct;
    }
  }

  return {
    key: def.key,
    name: meta.name,
    directionType: meta.higherBetter ? 'higher_is_better' : 'lower_is_better',
    higherBetter: meta.higherBetter,
    userValue: user != null && Number.isFinite(+user) ? +user : null,
    averageValue: avg != null && Number.isFinite(+avg) ? +avg : null,
    targetValue: target != null && Number.isFinite(+target) ? +target : null,
    issueType, // below_average | below_target | unstable | variable | null
    label,
    severityScore,
    selected: false,
    dot: issueType === 'below_average' ? 'red' : issueType ? 'amber' : 'amber',
  };
}

const metricIssueRows = metricDefs
  .filter((d) => d.score != null && Number.isFinite(d.score))
  .map((d) => determineMetricIssue(d))
  .filter(Boolean);

const problemRows = metricIssueRows
  .filter((r) => r.issueType != null)
  .sort((a, b) => b.severityScore - a.severityScore);

const hasTierProblems = problemRows.length > 0;

const LONGEVITY_PRIORITY_FALLBACK = [
  { name: 'Healthspan', label: 'Foundational', dot: 'amber' },
  { name: 'Systems', label: 'Essential', dot: 'amber' },
  { name: 'Energy', label: 'Capacity', dot: 'amber' },
  { name: 'Inflammation', label: 'Cellular', dot: 'amber' },
];

let limits;
let limitingSectionTitle;
if (hasTierProblems) {
  limits = problemRows.slice(0, 3).map((r) => {
    r.selected = true;
    return { name: r.name, badge: r.label, dot: r.dot, issueType: r.issueType, severityScore: r.severityScore };
  });
  limitingSectionTitle = 'LIMITING METRICS';
} else {
  limits = LONGEVITY_PRIORITY_FALLBACK.slice(0, 3).map((r) => ({
    name: r.name,
    badge: r.label,
    dot: r.dot,
    issueType: null,
    severityScore: 0,
  }));
  limitingSectionTitle = 'Longevity priorities';
}

while (limits.length < 3) {
  limits.push({ name: '—', badge: 'No data', dot: 'amber', issueType: null, severityScore: 0 });
}

function logLimitingMetricsDebug() {
  console.log('\n--- Limiting metrics debug (all candidates) ---\n');
  const selectedNames = new Set(limits.slice(0, 3).map((x) => x.name));
  const rows = metricIssueRows.map((r) => ({
    metric: r.name,
    directionType: r.directionType,
    userValue: r.userValue,
    demographicAverage: r.averageValue,
    targetValue: r.targetValue,
    issueType: r.issueType,
    displayLabel: r.label,
    severityScore: r.severityScore,
    selected: selectedNames.has(r.name),
  }));
  console.table(rows);
  console.log('\nFinal section title:', limitingSectionTitle);
  console.log(
    'Final selected cards:',
    limits.slice(0, 3).map((x) => `${x.name} (${x.badge})`).join(' | '),
  );
  console.log('');
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

const dailySleepHoursFC = Array.from({ length: numDaysFc }, (_, i) => {
  const sec = m.sleep_time?.[String(i + 1)];
  if (sec == null || !Number.isFinite(+sec) || +sec <= 0) return null;
  return Math.round((+sec / 3600) * 100) / 100;
});
const dailyDisturbFC = Array.from({ length: numDaysFc }, (_, i) => {
  const v = m.disturbances?.[String(i + 1)];
  return v == null || !Number.isFinite(+v) ? null : +v;
});
const cohortSleepHoursRef =
  c.sleepH?.M != null && Number.isFinite(+c.sleepH.M) ? +c.sleepH.M : hoursSleep ?? null;
const cohortDisruptRef =
  c.dis?.M != null && Number.isFinite(+c.dis.M) ? +c.dis.M : disturbPerHr ?? null;

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

// ─── main_cards.csv lookup helpers ───────────────────────────────────────────

/** Map from code-side metric names to main_cards.csv `metric` column values. */
const METRIC_TO_CSV_METRIC = {
  HRV:          'hrv',
  RHR:          'rhr',
  Disruptions:  'sleep_disruptions',
  REM:          'rem_sleep',
  DeepSleep:    'deep_sleep',
  healthspan:   'healthspan',
};

/**
 * Fetch title/copy/how_it_works from main_cards.csv.
 * Throws an explicit error if no matching row is found — silent fallback is not allowed.
 */
function mainCardText(csvMetric, csvGraph, csvVersion, cardIndex) {
  const row = mainCardsRows.find(
    r => r.metric === csvMetric && r.graph === csvGraph && r.version === csvVersion,
  );
  if (!row) {
    throw new Error(
      `[Card ${cardIndex}] mainCardText lookup failed — no row matched ` +
      `metric="${csvMetric}" graph="${csvGraph}" version="${csvVersion}" in main_cards.csv`,
    );
  }
  return { title: row.title, summary: row.copy, why: row.how_it_works };
}

// ─── Tier 5 supplement priority ───────────────────────────────────────────────

/**
 * Maps the CSV `graph` key used in main_cards.csv to the supplement-slot key
 * used in the Tier 5 priority table.  These are intentionally kept distinct.
 */
const TIER5_SUPPLEMENT_SLOT_KEY = {
  healthspan:   'healthspan',
  systems:      'systems',
  energy:       'energy',
  inflammation: 'oxidative_stress',  // CSV graph key → supplement slot key
};

const TIER5_SUPPLEMENT_PRIORITY = [
  { supplement: 'Magnesium',          slots: ['healthspan', 'oxidative_stress'] },
  { supplement: 'Vitamin B12',        slots: ['healthspan', 'systems'] },
  { supplement: 'Probiotics',         slots: ['healthspan', 'systems'] },
  { supplement: 'Ashwagandha',        slots: ['healthspan', 'oxidative_stress'] },
  { supplement: 'CoQ10',              slots: ['healthspan', 'energy'] },
  { supplement: 'Resveratrol',        slots: ['healthspan', 'energy'] },
  { supplement: 'Acetyl L-Carnitine', slots: ['healthspan', 'energy'] },
  { supplement: 'Omega 3',            slots: ['healthspan', 'oxidative_stress'] },
  { supplement: 'Vitamin D',          slots: ['healthspan', 'systems'] },
];

/**
 * Assigns one supplement to each Tier 5 slot using the fixed priority order.
 * Each slot must have a `csvGraph` property (the main_cards.csv graph column value).
 * Mutates each slot by adding `assignedSupplement`.
 */
function assignTier5Supplements(tier5Slots) {
  for (const slot of tier5Slots) slot.assignedSupplement = null;
  const takenSlotKeys  = new Set();
  const takenSupplements = new Set();
  for (const { supplement, slots: preferred } of TIER5_SUPPLEMENT_PRIORITY) {
    if (takenSupplements.has(supplement)) continue;
    for (const prefSlotKey of preferred) {
      if (takenSlotKeys.has(prefSlotKey)) continue;
      const slot = tier5Slots.find(
        s => TIER5_SUPPLEMENT_SLOT_KEY[s.csvGraph] === prefSlotKey,
      );
      if (!slot) continue;
      slot.assignedSupplement = supplement;
      takenSlotKeys.add(prefSlotKey);
      takenSupplements.add(supplement);
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Best resolved correlation row for a focus metric (prefers significant). */
function pickCorrForResolvedMetric(cards, metric) {
  if (!metric || metric === 'healthspan') return null;
  const matches = (Array.isArray(cards) ? cards : []).filter((c) => c.targetMetric === metric);
  if (!matches.length) return null;
  const sig = matches.filter((c) => c.significant);
  const pool = sig.length ? sig : matches;
  return pool.reduce((a, b) => (+(b.marginScore ?? -999) > +(a.marginScore ?? -999) ? b : a));
}

/** Safe for HTML text nodes (e.g. inside <h1>). */
function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Root `info` or `metric_analysis.info` (e.g. Whoop exports). */
function firstNameFromRaw(raw) {
  const candidates = [
    raw?.info?.first_name,
    raw?.connect_device_recommendation?.metric_analysis?.info?.first_name,
  ];
  for (const fn of candidates) {
    if (fn != null && typeof fn === 'string') {
      const t = fn.trim();
      if (t) return t;
    }
  }
  return null;
}

/**
 * Possessive subject + " Report": "Your Report" or "Mathieu's Report".
 * HTML wraps the subject in .report-name__subject for styling.
 */
function reportTitleParts(raw) {
  const t = firstNameFromRaw(raw);
  if (!t) {
    return {
      plain: 'Your Report',
      html: '<span class="report-name__subject">Your</span> Report',
    };
  }
  const plain = `${t}'s Report`;
  return {
    plain,
    html: `<span class="report-name__subject">${escapeHtmlText(t)}'s</span> Report`,
  };
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

const remWhyFallback =
  'REM sleep is essential for memory consolidation, emotional regulation, stress resilience, and neural recovery. Persistently low REM can reduce cognitive performance, increase perceived stress, and blunt adaptation to training. Raising REM helps your overnight recovery translate into better next-day readiness.';

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
  if (metric === 'RHR') return 'Resting HR';
  if (metric === 'TotalSleep') return 'Total sleep';
  if (metric === 'Disruptions') return 'Disruptions';
  if (metric === 'healthspan') return 'Healthspan';
  return String(metric || 'Priority');
}
function tagDisplayLabel(tag) {
  const t = String(tag || '').toLowerCase().trim();
  const map = {
    healthspan: 'Healthspan',
    hrv: 'HRV',
    recovery: 'Recovery',
    sleep_quality: 'Sleep Quality',
    sleep_disruptions: 'Disruptions',
    deep_sleep: 'Deep Sleep',
    rem_sleep: 'REM Sleep',
    rhr: 'RHR',
  };
  if (map[t]) return map[t];
  return t
    .split('_')
    .filter(Boolean)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ') || 'Priority';
}
function metricChartLabel(metric) {
  if (metric === 'HRV') return 'HRV';
  if (metric === 'RHR') return 'Resting Heart Rate';
  if (metric === 'REM') return 'REM Sleep';
  if (metric === 'DeepSleep') return 'Deep Sleep';
  if (metric === 'LightSleep') return 'Light Sleep';
  if (metric === 'TotalSleep') return 'Total Sleep';
  if (metric === 'Disruptions') return 'Disruptions';
  if (metric === 'Awake') return 'Awake Time';
  return metricDotLabel(metric);
}
function metricUnit(metric) {
  if (metric === 'HRV') return 'ms';
  if (metric === 'RHR') return 'bpm';
  if (metric === 'TotalSleep') return 'h';
  if (metric === 'Disruptions') return '/h';
  if (metric === 'REM' || metric === 'DeepSleep' || metric === 'LightSleep' || metric === 'Awake') return '%';
  return '';
}
function isLowerBetterMetric(metric) {
  return metric === 'RHR' || metric === 'Disruptions' || metric === 'LightSleep' || metric === 'Awake';
}
function metricTriple(metric) {
  if (metric === 'HRV') return c.hrv;
  if (metric === 'RHR') return c.rhr;
  if (metric === 'TotalSleep') return c.sleepH;
  if (metric === 'Disruptions') return c.dis;
  if (metric === 'REM') return c.rem;
  if (metric === 'DeepSleep') return c.deep;
  if (metric === 'LightSleep') return c.light;
  if (metric === 'Awake') return c.awake;
  return null;
}
function metricDailySeries(metric) {
  return Array.from({ length: numDaysFc }, (_, i) => {
    const k = String(i + 1);
    if (metric === 'HRV') {
      const v = m.HRV?.[k];
      return v == null || !Number.isFinite(+v) ? null : +v;
    }
    if (metric === 'RHR') {
      const v = m.RHR?.[k];
      return v == null || !Number.isFinite(+v) ? null : +v;
    }
    if (metric === 'TotalSleep') {
      const sec = m.sleep_time?.[k];
      return sec == null || !Number.isFinite(+sec) || +sec <= 0 ? null : +sec / 3600;
    }
    if (metric === 'Disruptions') {
      const d = m.disturbances?.[k];
      const s = m.sleep_time?.[k];
      if (d == null || s == null || !Number.isFinite(+d) || !Number.isFinite(+s) || +s <= 0) return null;
      return +d / (+s / 3600);
    }
    const secByMetric = {
      REM: m.rem_sleep,
      DeepSleep: m.deep_sleep,
      LightSleep: m.light_sleep,
      Awake: m.awake_time,
    }[metric];
    if (!secByMetric) return null;
    const secMetric = secByMetric?.[k];
    const secSleep = m.sleep_time?.[k];
    if (secMetric == null || secSleep == null || !Number.isFinite(+secMetric) || !Number.isFinite(+secSleep) || +secSleep <= 0) {
      return null;
    }
    return (100 * +secMetric) / +secSleep;
  });
}

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

const fcSleepHoursPayload = {
  numDays: numDaysFc,
  dailyHours: dailySleepHoursFC,
  refHours: cohortSleepHoursRef,
};
const fcDisturbPayload = {
  numDays: numDaysFc,
  counts: dailyDisturbFC,
  refCount: cohortDisruptRef,
};

const rhrCohortMed =
  c.rhr?.M != null && Number.isFinite(+c.rhr.M) ? Math.round(+c.rhr.M) : null;
const hrvSummaryFallback = `Your average HRV is <strong>${hrvAvg != null ? Math.round(hrvAvg) : '—'}</strong> ms; cohort-informed target band <strong>${targetHrvMin}–${targetHrvMax}</strong> ms.`;
const rhrSummaryFallback = `Your average resting heart rate is <strong>${rhrAvg != null ? Math.round(rhrAvg) : '—'}</strong> bpm${
  rhrCohortMed != null ? ` vs cohort median <strong>${rhrCohortMed}</strong> bpm` : ''
}.`;
let totalSleepSummaryFallback = 'Your total sleep is being tracked against cohort norms.';
if (hoursSleep != null && Number.isFinite(hoursSleep) && cohortSleepHoursRef != null && Number.isFinite(cohortSleepHoursRef)) {
  const hs = hoursSleep.toFixed(1);
  const cr = cohortSleepHoursRef.toFixed(1);
  totalSleepSummaryFallback = `Your average total sleep is <strong>${hs}</strong> h vs cohort median near <strong>${cr}</strong> h.`;
}
let disruptSummaryFallback = 'Night-time disruptions are tracked against cohort norms.';
if (disturbPerHr != null && Number.isFinite(disturbPerHr) && cohortDisruptRef != null && Number.isFinite(cohortDisruptRef)) {
  disruptSummaryFallback = `You average about <strong>${disturbPerHr.toFixed(1)}</strong> disruptions per hour of sleep vs cohort median near <strong>${cohortDisruptRef.toFixed(1)}</strong>.`;
}

function metricPercentSeries(metric) {
  const secByMetric = {
    REM: m.rem_sleep,
    DeepSleep: m.deep_sleep,
    LightSleep: m.light_sleep,
    Awake: m.awake_time,
  }[metric];
  if (!secByMetric) return null;
  return Array.from({ length: numDaysFc }, (_, i) => {
    const k = String(i + 1);
    const secMetric = secByMetric?.[k];
    const secSleep = m.sleep_time?.[k];
    if (secMetric == null || secSleep == null || !Number.isFinite(+secMetric) || !Number.isFinite(+secSleep) || +secSleep <= 0) {
      return null;
    }
    return (100 * +secMetric) / +secSleep;
  });
}

function remLikePayloadForMetric(metric) {
  const pct = metricDailySeries(metric);
  const tri = metricTriple(metric);
  const triVals = [tri?.L, tri?.M, tri?.R].map((v) => Number(v)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const fallbackP50 = tri?.M ?? (metric === 'DeepSleep' ? deepP : metric === 'LightSleep' ? lightP : metric === 'Awake' ? awakeP : remP);
  const p50 = Number.isFinite(+fallbackP50) ? +fallbackP50 : remPctilesFC.p50;
  const fallbackBands = deriveRemPercentilesFromP50(p50);
  return {
    numDays: numDaysFc,
    dailyPct: pct,
    remPctiles:
      triVals.length === 3
        ? { p50, p30: triVals[0], p60: triVals[1], p90: triVals[2] }
        : fallbackBands,
    demographicPct: p50,
    metaGender: gender,
    metaAge: meta.age ?? 30,
    metricLabel: metricChartLabel(metric),
    baselineLabel: 'cohort median',
    unitLabel: metricUnit(metric) || '%',
    lowerIsBetter: isLowerBetterMetric(metric),
  };
}

/** Normative REM row (p30 / p50 / p90) for the user's age bracket, if present. */
function normRemBracketObj() {
  const v = normative?.rem_sleep?.[gender]?.[band];
  if (v != null && typeof v === 'object' && Number.isFinite(+v.p50)) return v;
  return null;
}

const FOCUS_VARIANCE_METRICS = new Set([
  'HRV',
  'RHR',
  'TotalSleep',
  'Disruptions',
  'REM',
  'DeepSleep',
  'LightSleep',
  'Awake',
]);

/**
 * Nightly band chart payload for any focus metric (graph_type "variance").
 * Shaded target band uses variance_rules.json via varianceRules.js (band around
 * the window mean of nightly values), same semantics as stability analysis.
 */
function variancePayloadForMetric(metric) {
  const mKey = FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV';
  const series = metricDailySeries(mKey).map((v) => (v == null || !Number.isFinite(+v) ? null : +v));
  const unit = metricUnit(mKey) || '';
  const label = metricChartLabel(mKey);
  const lower = isLowerBetterMetric(mKey);

  const vals = series.filter((v) => v != null && Number.isFinite(+v)).map((v) => +v);
  const mu = varianceMeanOf(vals);
  const rulesBand =
    mu != null && Number.isFinite(+mu) ? varianceOptimalBand(+mu, mKey) : null;

  let targetMin = 0;
  let targetMax = 100;
  if (
    rulesBand &&
    Number.isFinite(rulesBand.low) &&
    Number.isFinite(rulesBand.high) &&
    rulesBand.high > rulesBand.low
  ) {
    targetMin = rulesBand.low;
    targetMax = rulesBand.high;
  } else {
    switch (mKey) {
      case 'HRV': {
        const hM = g(normative.hrv);
        targetMin = Number.isFinite(hM) ? Math.max(20, Math.round(hM * 0.88)) : 40;
        targetMax = Number.isFinite(hM) ? Math.max(targetMin + 5, Math.round(hM * 1.12)) : targetMin + 30;
        break;
      }
      case 'RHR': {
        targetMin =
          c.rhr?.R != null && Number.isFinite(+c.rhr.R) ? +c.rhr.R : Math.max(35, Math.round((rhrAvg ?? 50) - 4));
        targetMax = c.rhr?.M != null && Number.isFinite(+c.rhr.M) ? +c.rhr.M : Math.round((rhrAvg ?? 50) + 2);
        break;
      }
      case 'TotalSleep': {
        const M = c.sleepH?.M ?? hoursSleep ?? 7;
        const hi = c.sleepH?.R ?? M * 1.12;
        targetMin = round1(Math.max(4, M * 0.9));
        targetMax = round1(Math.min(12, hi));
        break;
      }
      case 'Disruptions': {
        targetMin = 0;
        const M = c.dis?.M ?? 1;
        targetMax = round1(Math.max(0.12, M * 1.35));
        break;
      }
      case 'REM': {
        const o = normRemBracketObj();
        if (o && Number.isFinite(+o.p30) && Number.isFinite(+o.p90)) {
          targetMin = Math.round(+o.p30);
          targetMax = Math.round(+o.p90);
        } else {
          const p50 = g(normative.rem_sleep) ?? 21;
          targetMin = Math.max(5, Math.round(p50 * 0.88));
          targetMax = Math.min(50, Math.round(p50 * 1.12));
        }
        break;
      }
      case 'DeepSleep': {
        const lo = c.deep?.L ?? 5;
        const hi = c.deep?.R ?? 24;
        targetMin = Math.round(Math.max(3, lo));
        targetMax = Math.round(Math.min(45, hi));
        break;
      }
      case 'LightSleep': {
        targetMin = 0;
        targetMax = round1(c.light?.M ?? 57);
        break;
      }
      case 'Awake': {
        targetMin = 0;
        targetMax = round1(Math.max(2, (c.awake?.M ?? 7) * 1.25));
        break;
      }
      default: {
        targetMin = 0;
        targetMax = 100;
      }
    }
  }

  const yAxisLabel = mKey === 'HRV' ? 'HRV' : mKey === 'RHR' ? 'RESTING HR' : label.toUpperCase();

  if (targetMin > targetMax) {
    const t = targetMin;
    targetMin = targetMax;
    targetMax = t;
  }

  const titleSuffix = mKey === 'HRV' ? ' (RMSSD)' : '';
  const titleLabel = `Nightly ${label}${titleSuffix}`;

  return {
    numDays: numDaysFc,
    seriesByDay: series,
    hrvByDay: series,
    targetMin,
    targetMax,
    metricLabel: label,
    unitLabel: unit,
    yAxisLabel,
    titleLabel,
    lowerIsBetter: lower,
  };
}

/** main_cards.csv `graph` column has no `7day_average` row — cohort copy still applies. */
function mainCardsCsvGraph(graphType) {
  if (graphType === '7day_average') return 'cohort';
  return graphType;
}

/**
 * main_cards.csv `version`: NA | baseline | top 10% | unstable | variable
 * (Cohort version from bio standing; variance version from stability tiers.)
 */
function mainCardsCsvVersion(graphType, metric) {
  if (graphType === 'healthspan') return 'NA';
  const eff = mainCardsCsvGraph(graphType);
  if (eff === 'cohort') {
    const BIO_KEY = {
      HRV: 'hrv',
      RHR: 'rhr',
      Disruptions: 'dis',
      REM: 'rem',
      DeepSleep: 'deep',
      TotalSleep: 'sleepH',
      LightSleep: 'light',
      Awake: 'awake',
    };
    const key = BIO_KEY[metric];
    const standing = key && bio[key] ? bio[key].standingPct : null;
    return standing != null && standing >= 50 ? 'top 10%' : 'baseline';
  }
  if (eff === 'variance') {
    const mKey = FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV';
    const series = metricDailySeries(mKey);
    const vals = series.filter((v) => v != null && Number.isFinite(+v)).map(Number);
    const a = varianceAnalyzeSeries(vals, mKey);
    if (!a || a.tier == null) return 'unstable';
    if (a.tier === 'unstable') return 'unstable';
    return 'variable';
  }
  return 'baseline';
}

function pctDiffVsReference(a, b) {
  if (a == null || b == null || !Number.isFinite(+a) || !Number.isFinite(+b)) return null;
  const B = Math.abs(+b);
  if (B < 1e-9) return null;
  return Math.round((Math.abs(+a - +b) / B) * 100);
}

/** Expected nightly minutes for a sleep stage from normative % and typical sleep duration (hours). */
function normStageMinutesFromPct(normPct, sleepHoursNorm) {
  if (normPct == null || sleepHoursNorm == null || !Number.isFinite(+normPct) || !Number.isFinite(+sleepHoursNorm)) {
    return null;
  }
  return (+normPct / 100) * (+sleepHoursNorm * 60);
}

function fmtMainCardNumber(csvMetric, raw) {
  if (raw == null || !Number.isFinite(+raw)) return '—';
  const v = +raw;
  if (csvMetric === 'sleep_disruptions') return round1(v).toFixed(1);
  if (csvMetric === 'hrv' || csvMetric === 'rhr') return String(Math.round(v));
  if (csvMetric === 'rem_sleep' || csvMetric === 'deep_sleep') {
    const x = Math.round(v * 10) / 10;
    return Number.isInteger(x) ? String(x) : x.toFixed(1);
  }
  return String(v);
}

/**
 * Replace [X], [A], [B] in main_cards copy using the same window means and L/M/R cohort
 * triples as the bio bench (normative + top10_percent JSON).
 */
function interpolateMainCardCopy(text, metric, csvMetric, csvGraph, csvVersion) {
  if (!text || (!text.includes('[X]') && !text.includes('[A]') && !text.includes('[B]'))) return text;

  if (csvGraph === 'variance' && (csvVersion === 'unstable' || csvVersion === 'variable')) {
    const mKey = FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV';
    const series = metricDailySeries(mKey);
    const vals = series.filter((v) => v != null && Number.isFinite(+v)).map(Number);
    const a = varianceAnalyzeSeries(vals, mKey);
    const outsidePct =
      a != null && Number.isFinite(a.daysInRangePct)
        ? Math.max(0, Math.min(100, Math.round(100 - a.daysInRangePct)))
        : null;
    let s = text;
    if (s.includes('[X]')) s = s.split('[X]').join(outsidePct == null ? '—' : String(outsidePct));
    return s;
  }

  if (csvGraph !== 'cohort' || (csvVersion !== 'baseline' && csvVersion !== 'top 10%')) return text;

  const sleepHoursNorm = g(normative.total_sleep);

  let rawA = null;
  let rawB = null;
  let rawX = null;

  if (csvMetric === 'sleep_disruptions') {
    rawA = disturbPerHr;
    rawB = csvVersion === 'baseline' ? c.dis?.M : c.dis?.R;
  } else if (csvMetric === 'hrv') {
    rawA = hrvAvg;
    rawB = csvVersion === 'baseline' ? c.hrv?.M : c.hrv?.R;
  } else if (csvMetric === 'rhr') {
    rawA = rhrAvg;
    rawB = csvVersion === 'baseline' ? c.rhr?.M : c.rhr?.R;
  } else if (csvMetric === 'rem_sleep') {
    rawA = remAvgS != null && Number.isFinite(+remAvgS) ? +remAvgS / 60 : null;
    const normPct = g(normative.rem_sleep);
    const topPct = g(top10.rem_sleep);
    if (csvVersion === 'baseline') {
      rawB = normStageMinutesFromPct(normPct, sleepHoursNorm);
    } else {
      rawB = normStageMinutesFromPct(topPct, sleepHoursNorm);
    }
  } else if (csvMetric === 'deep_sleep') {
    rawA = deepAvgS != null && Number.isFinite(+deepAvgS) ? +deepAvgS / 60 : null;
    const normPct = g(normative.deep_sleep);
    const topPct = g(top10.deep_sleep);
    rawB =
      csvVersion === 'baseline'
        ? normStageMinutesFromPct(normPct, sleepHoursNorm)
        : normStageMinutesFromPct(topPct, sleepHoursNorm);
  } else {
    return text;
  }

  if (csvVersion === 'baseline') {
    rawX = pctDiffVsReference(rawA, rawB);
  }

  const strA = fmtMainCardNumber(csvMetric, rawA);
  const strB = fmtMainCardNumber(csvMetric, rawB);
  const strX = rawX == null || !Number.isFinite(+rawX) ? '—' : String(rawX);

  let s = text;
  if (s.includes('[X]')) s = s.split('[X]').join(strX);
  if (s.includes('[A]')) s = s.split('[A]').join(strA);
  if (s.includes('[B]')) s = s.split('[B]').join(strB);
  return s;
}

/** Same-day training intensity (x) vs nightly metric (y). */
function scatterPointsForMetric(metric) {
  const mKey = FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV';
  const ySeries = metricDailySeries(mKey);
  const pts = [];
  for (let day = 1; day <= numDaysFc; day += 1) {
    const x = dailyAct?.[String(day)]?.average_intensity;
    const yi = ySeries[day - 1];
    if (x == null || yi == null) continue;
    if (!Number.isFinite(+x) || !Number.isFinite(+yi)) continue;
    pts.push({ x: +x, y: +yi });
  }
  return pts;
}

function defaultGraphTypeFromTier(tier) {
  if (tier === 1 || tier === 2) return 'cohort';
  if (tier === 3 || tier === 4) return 'variance';
  if (tier === 5) return 'healthspan';
  return 'cohort';
}

function focusChartDataForGraphType(graphType, metric) {
  switch (graphType) {
    case 'cohort':
      return remLikePayloadForMetric(metric);
    case '7day_average':
      return {
        metricDaily: metricDailySeries(metric),
        intensityDaily: fc2Payload.intensityDaily,
        metricLabel: metricChartLabel(metric),
        leftUnit: metricUnit(metric) || '',
      };
    case 'variance':
      return variancePayloadForMetric(metric);
    case 'single_correlation': {
      const mKey = FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV';
      return {
        points: scatterPointsForMetric(mKey),
        yAxisLabel: metricChartLabel(mKey).toUpperCase(),
        xAxisLabel: 'Training Intensity',
        yUnit: metricUnit(mKey) || '',
        pointYLabel: metricChartLabel(mKey),
      };
    }
    case 'healthspan':
      return null;
    case 'extension_system_decline':
    case 'extension_energy_age':
    case 'extension_inflammation':
      return null;
    default:
      return variancePayloadForMetric(FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV');
  }
}

function focusCaptionForGraphType(graphType, metric) {
  switch (graphType) {
    case 'cohort':
      return `Daily ${metricChartLabel(metric)} vs demographic average`;
    case '7day_average':
      return `${metricChartLabel(metric)} (7-day trend) vs training intensity`;
    case 'variance':
      return variancePayloadForMetric(metric).titleLabel;
    case 'single_correlation':
      return `Training intensity vs ${metricChartLabel(FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV')}`;
    case 'healthspan':
      return 'HEALTHSPAN WITH PROACTIVE SUPPORT';
    case 'extension_system_decline':
      return 'SYSTEM FUNCTION VS LIFESPAN';
    case 'extension_energy_age':
      return 'ENERGY VS AGE';
    case 'extension_inflammation':
      return 'Impact of inflammation on longevity';
    default:
      return 'Metric trend';
  }
}

function focusChartAria(graphType, metric) {
  switch (graphType) {
    case 'cohort':
      return `Daily ${metricChartLabel(metric)}; bars colored by cohort percentile band (red through blue)`;
    case '7day_average':
      return `${metricChartLabel(metric)} trend and training intensity over 30 days`;
    case 'variance': {
      const v = variancePayloadForMetric(metric);
      const dec = v.unitLabel === 'h' ? 1 : 2;
      const lo =
        v.unitLabel === '/h' || v.unitLabel === 'h'
          ? `${Number(v.targetMin).toFixed(dec)}`
          : `${Math.round(v.targetMin)}`;
      const hi =
        v.unitLabel === '/h' || v.unitLabel === 'h'
          ? `${Number(v.targetMax).toFixed(dec)}`
          : `${Math.round(v.targetMax)}`;
      return `Nightly ${v.metricLabel}; target ${lo}–${hi} ${v.unitLabel}; blue dots within target band`;
    }
    case 'single_correlation': {
      const lab = metricChartLabel(FOCUS_VARIANCE_METRICS.has(metric) ? metric : 'HRV');
      return `Scatter of same-day training intensity versus ${lab}`;
    }
    case 'healthspan':
      return 'Lifespan versus healthspan schematic: Normal and With Protocol curves';
    case 'extension_system_decline':
      return 'System function vs lifespan: gut, immunity, metabolism, musculoskeletal illustrative curves';
    case 'extension_energy_age':
      return 'Energy vs age illustrative curve';
    case 'extension_inflammation':
      return 'Longevity expectation vs inflammation load illustrative curve';
    default:
      return 'Focus chart';
  }
}

function focusLegendInner(fc, graphType, metric) {
  if (graphType === 'cohort') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch ${fc}-legend__swatch--avg" style="display:inline-block;width:22px;height:0;border-top:1px dashed #9ca3af;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Demographic Avg.</span>
                    </div>
                  </div>`;
  }
  if (graphType === '7day_average') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch ${fc}-legend__swatch--deep" style="display:inline-block;width:22px;height:0;border-top:2px solid #0071e3;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">${escapeHtmlText(metricChartLabel(metric))}</span>
                    </div>
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch ${fc}-legend__swatch--load" style="display:inline-block;width:22px;height:0;border-top:2px solid #ffd60a;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Training Load</span>
                    </div>
                  </div>`;
  }
  if (graphType === 'single_correlation') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch ${fc}-legend__swatch--reg" aria-hidden="true"></span>
                      <span class="${fc}-legend__label">Regression Line</span>
                    </div>
                  </div>`;
  }
  if (graphType === 'healthspan') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #6b7280;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Passive</span>
                    </div>
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #10b981;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Proactive</span>
                    </div>
                  </div>`;
  }
  if (graphType === 'extension_system_decline') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #ef4444;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Gut health</span>
                    </div>
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #3b82f6;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Immunity</span>
                    </div>
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #8b5cf6;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Metabolism</span>
                    </div>
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #10b981;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Musculoskeletal</span>
                    </div>
                  </div>`;
  }
  if (graphType === 'extension_energy_age') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #3b82f6;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Energy level</span>
                    </div>
                  </div>`;
  }
  if (graphType === 'extension_inflammation') {
    return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch" style="display:inline-block;width:22px;height:0;border-top:2px solid #10b981;border-radius:0;background:transparent;"></span>
                      <span class="${fc}-legend__label">Longevity outlook</span>
                    </div>
                  </div>`;
  }
  return `<div class="${fc}-legend" aria-hidden="true">
                    <div class="${fc}-legend__item">
                      <span class="${fc}-legend__swatch ${fc}-legend__swatch--target-range"></span>
                      <span class="${fc}-legend__label">Target range</span>
                    </div>
                  </div>`;
}

function buildFocusSlotFromFm(fm, cardIndex) {
  const metric = fm.metric;
  const corr = pickCorrForResolvedMetric(correlationCardsResolved, metric);
  const graphType = fm.graph_type || defaultGraphTypeFromTier(fm.tier);
  const data = graphType === 'healthspan' ? null : focusChartDataForGraphType(graphType, metric);
  const useCorr = Boolean(corr && corr.significant && corr.title);
  const cap = focusCaptionForGraphType(graphType, metric);
  const csvGraph = mainCardsCsvGraph(graphType);

  let title;
  let summary;
  let why;

  if (useCorr) {
    // Correlation cards → text from correlationCardsResolved (derived from correlation_cards-2.csv).
    title = escapeCorrText(corr.title);
    summary = escapeCorrText(corr.body || '');
    why = escapeCorrText(corr.how_it_works || '');
  } else {
    // All non-correlation cards → text from main_cards.csv.
    const csvMetric = METRIC_TO_CSV_METRIC[metric];
    if (!csvMetric) {
      throw new Error(
        `[Card ${cardIndex}] buildFocusSlotFromFm: no METRIC_TO_CSV_METRIC entry for metric="${metric}"`,
      );
    }
    const csvVersion = (metric === 'healthspan' || fm.tier === 5)
      ? 'NA'
      : mainCardsCsvVersion(graphType, metric);
    const csvText = mainCardText(csvMetric, csvGraph, csvVersion, cardIndex);
    title = escapeHtmlText(csvText.title);
    summary = interpolateMainCardCopy(csvText.summary, metric, csvMetric, csvGraph, csvVersion);
    why = interpolateMainCardCopy(csvText.why, metric, csvMetric, csvGraph, csvVersion);
  }

  return { metric, graphType, csvGraph, data, title, summary, cap, why, corr: useCorr ? corr : null };
}

const focusSlotsResolved = sortedFocusMetrics.slice(0, 4).map((fm, idx) => buildFocusSlotFromFm(fm, idx + 1));

function focusDotLabelForStackIndex(idx, stackSlot) {
  if (idx < sortedFocusMetrics.length) {
    const fm = sortedFocusMetrics[idx];
    return fm?.tag ? tagDisplayLabel(fm.tag) : metricDotLabel(fm.metric);
  }
  return stackSlot?.dotLabel || stackSlot?.cap || `Slide ${idx + 1}`;
}

/** Static extension slides after priority 1–4 (Figma Nutricode 23838:18813, 18865, 18898). */
// Text (title/summary/why) — Layer A: main_cards.csv keyed by csvGraph.
// Supplement — Layer B: assigned separately via assignTier5Supplements(); never influences text.
const _extSystems = mainCardText('healthspan', 'systems',      'NA', 5);
const _extEnergy  = mainCardText('healthspan', 'energy',       'NA', 6);
const _extInflam  = mainCardText('healthspan', 'inflammation', 'NA', 7);

const focusExtensionSlots = [
  {
    metric: 'extension_system_decline',
    graphType: 'extension_system_decline',
    csvGraph: 'systems',      // Layer A key (main_cards.csv `graph` column)
    data: null,
    corr: null,
    dotLabel: 'Systems',
    title:   escapeHtmlText(_extSystems.title),
    summary: _extSystems.summary,
    cap:     'SYSTEM FUNCTION VS LIFESPAN',
    why:     _extSystems.why,
  },
  {
    metric: 'extension_energy_age',
    graphType: 'extension_energy_age',
    csvGraph: 'energy',       // Layer A key
    data: null,
    corr: null,
    dotLabel: 'Energy',
    title:   escapeHtmlText(_extEnergy.title),
    summary: _extEnergy.summary,
    cap:     'ENERGY VS AGE',
    why:     _extEnergy.why,
  },
  {
    metric: 'extension_inflammation',
    graphType: 'extension_inflammation',
    csvGraph: 'inflammation', // Layer A key; Layer B slot key = 'oxidative_stress' via TIER5_SUPPLEMENT_SLOT_KEY
    data: null,
    corr: null,
    dotLabel: 'Inflammation',
    title:   escapeHtmlText(_extInflam.title),
    summary: _extInflam.summary,
    cap:     'Impact of inflammation on longevity',
    why:     _extInflam.why,
  },
];

// ── Tier 5 supplement assignment (Layer B) ────────────────────────────────────
// Collect all Tier 5 slots: the healthspan slot from focusSlotsResolved + the three extension slots.
const tier5Slots = [
  ...focusSlotsResolved.filter(s => s.metric === 'healthspan' || s.graphType === 'healthspan'),
  ...focusExtensionSlots,
];
assignTier5Supplements(tier5Slots);
// ─────────────────────────────────────────────────────────────────────────────

const focusStackSlots = [...focusSlotsResolved, ...focusExtensionSlots];

const focusSlotChartSpecs = focusStackSlots.map((s) =>
  s.graphType === 'healthspan' ||
    s.graphType === 'extension_system_decline' ||
    s.graphType === 'extension_energy_age' ||
    s.graphType === 'extension_inflammation'
    ? { graph_type: null, data: null }
    : { graph_type: s.graphType, data: s.data },
);

const dotsButtonsHtml = focusStackSlots
  .map((stackSlot, idx) => {
    const lbl = focusDotLabelForStackIndex(idx, stackSlot);
    const active = idx === 0 ? ' active' : '';
    const sel = idx === 0 ? 'true' : 'false';
    const tab = idx === 0 ? '0' : '-1';
    return `              <button type="button" class="rec-rhr-dot${active}" aria-label="${escAttr(lbl)}" role="tab" aria-selected="${sel}" aria-controls="focus-card-${idx + 1}" tabindex="${tab}"><span class="rec-rhr-dot__label" aria-hidden="true">${lbl}</span></button>`;
  })
  .join('\n');

/** Matches Figma Nutricode → LongevityHealthspanChart (node 23835:10191): Normal vs With Protocol. */
const FONT_HS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

function healthspanLifespanVsHealthspanSvg(slotNumber) {
  const VB = '4 38 279 140';
  // Keep y-label column at fixed x positions and shift plot right to match.
  const XL = 52;
  const XR = 274;
  const YT = 48;
  const YB = 150;
  const W = XR - XL;
  const H = YB - YT;
  /** t ∈ [0,1] = lifespan 20→100 (axis ticks). */
  const xOf = (t) => XL + t * W;
  /** p ∈ [0,1] = healthspan 0% (bottom) → 100% (top). */
  const yOf = (p) => YB - p * H;

  function fnNormal(t) {
    if (t <= 0.2) return 1;
    if (t >= 1) return 0.06;
    const u = (t - 0.2) / 0.8;
    return 1 - 0.94 * (u * u * (3 - 2 * u));
  }
  function fnProtocol(t) {
    // Keep a long high plateau, then a late, steep decline.
    if (t <= 0.62) return 1;
    if (t >= 1) return 0.08;
    const u = (t - 0.62) / 0.38;
    return 1 - 0.92 * Math.pow(u, 6.2);
  }

  function samplePath(fn, steps = 64) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let p = Math.max(0, Math.min(1, fn(t)));
      pts.push({ x: xOf(t), y: yOf(p) });
    }
    const head = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    if (pts.length === 1) return head;
    return `${head} L ${pts
      .slice(1)
      .map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`)
      .join(' L ')}`;
  }

  const dNormal = samplePath(fnNormal);
  const dProtocol = samplePath(fnProtocol);

  const yTicks = [
    { p: 1, lab: '100%' },
    { p: 0.75, lab: '75%' },
    { p: 0.5, lab: '50%' },
    { p: 0.25, lab: '25%' },
  ];
  const yTickSvg = yTicks
    .map(({ p, lab }) => {
      const y = yOf(p);
      return `<line x1="${XL}" y1="${y.toFixed(1)}" x2="${XR}" y2="${y.toFixed(1)}" stroke="#f0f0f2" stroke-width="1" vector-effect="non-scaling-stroke"/>
                      <text x="40" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="${FONT_HS}" font-size="7" font-weight="400" fill="#b7bcc6">${lab}</text>`;
    })
    .join('\n                      ');

  const ages = [20, 40, 60, 80, 100];
  const xTickSvg = ages
    .map((age) => {
      const t = (age - 20) / 80;
      const x = xOf(t);
      return `<text x="${x.toFixed(1)}" y="${YB + 12}" text-anchor="middle" font-family="${FONT_HS}" font-size="7" font-weight="400" fill="#9ca3af">${age}</text>`;
    })
    .join('\n                      ');

  const aria = escAttr(
    'Lifespan versus healthspan: illustrative Normal trajectory and With Protocol trajectory (Nutricode design).',
  );

  return `                    <svg id="focus-chart-${slotNumber}" class="focus-healthspan-svg" viewBox="${VB}" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${aria}">
                      <defs>
                        <linearGradient id="hsGrad-${slotNumber}" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="rgb(15,23,42)" stop-opacity="0.02"/>
                          <stop offset="32%" stop-color="rgb(15,23,42)" stop-opacity="0"/>
                        </linearGradient>
                      </defs>
                      <title>Longevity: healthspan over lifespan</title>
                      <desc>Normal (gray) versus With Protocol (green). Schematic chart aligned to Nutricode Figma LongevityHealthspanChart.</desc>
                      <rect x="${XL}" y="${YT}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" rx="0" fill="url(#hsGrad-${slotNumber})"/>
                      ${yTickSvg}
                      <line x1="${XL}" y1="${YT}" x2="${XL}" y2="${YB}" stroke="#e5e7eb" stroke-width="1" vector-effect="non-scaling-stroke"/>
                      <line x1="${XL}" y1="${YB}" x2="${XR}" y2="${YB}" stroke="#e5e7eb" stroke-width="1" vector-effect="non-scaling-stroke"/>
                      <text transform="translate(20 ${((YT + YB) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-family="${FONT_HS}" font-size="7.5" font-weight="400" fill="#6b7280">Healthspan</text>
                      <path d="${dNormal}" stroke="#6b7280" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
                      <path d="${dProtocol}" stroke="#10b981" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
                      ${xTickSvg}
                      <text x="${((XL + XR) / 2).toFixed(1)}" y="${YB + 22}" text-anchor="middle" font-family="${FONT_HS}" font-size="7.5" font-weight="400" fill="#6b7280">Lifespan</text>
                    </svg>`;
}

function extChartPlotBox() {
  return { VB: '4 38 279 140', XL: 52, XR: 262, YT: 50, YB: 151 };
}

function extPathFromFn(xOf, yOf, fn, steps = 56) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = Math.max(0, Math.min(1, fn(t)));
    pts.push({ x: xOf(t), y: yOf(p) });
  }
  const head = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  if (pts.length === 1) return head;
  return `${head} L ${pts
    .slice(1)
    .map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`)
    .join(' L ')}`;
}

/** Figma 23838:18813 — four system trajectories vs lifespan. */
function extensionSystemDeclineSvg(slotNumber) {
  const { VB, XL, YT, YB } = extChartPlotBox();
  const XR = 274;
  const W = XR - XL;
  const H = YB - YT;
  const xOf = (t) => XL + t * W;
  const yOf = (p) => YB - p * H;
  const decline = (t, start, span, floor) => {
    if (t <= start) return 1;
    if (t >= 1) return floor;
    const u = Math.min(1, Math.max(0, (t - start) / span));
    const s = u * u * (3 - 2 * u);
    return 1 - (1 - floor) * s;
  };
  const series = [
    { c: '#ef4444', fn: (t) => decline(t, 0.08, 0.72, 0.08) },
    { c: '#3b82f6', fn: (t) => decline(t, 0.14, 0.78, 0.12) },
    { c: '#8b5cf6', fn: (t) => decline(t, 0.2, 0.82, 0.14) },
    { c: '#10b981', fn: (t) => decline(t, 0.26, 0.86, 0.18) },
  ];
  const paths = series.map((s) => `<path d="${extPathFromFn(xOf, yOf, s.fn)}" stroke="${s.c}" stroke-width="1.6" fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);
  const yLabs = [1, 0.75, 0.5, 0.25].map(
    (p, i) =>
      `<line x1="${XL}" y1="${yOf(p).toFixed(1)}" x2="${XR}" y2="${yOf(p).toFixed(1)}" stroke="#f0f0f2" stroke-width="1"/><text x="40" y="${(yOf(p) + 3).toFixed(1)}" text-anchor="end" font-family="${FONT_HS}" font-size="7" fill="#b7bcc6">${[100, 75, 50, 25][i]}%</text>`,
  );
  const ages = [20, 40, 60, 80, 100];
  const xLabs = ages.map((a) => {
    const t = (a - 20) / 80;
    return `<text x="${xOf(t).toFixed(1)}" y="${YB + 11}" text-anchor="middle" font-family="${FONT_HS}" font-size="7" fill="#9ca3af">${a}</text>`;
  });
  const aria = escAttr(
    'System function vs lifespan: Gut health, Immunity, Metabolism, Musculoskeletal illustrative decline curves.',
  );
  return `                    <svg id="focus-chart-${slotNumber}" class="focus-extension-svg" viewBox="${VB}" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${aria}">
                      <defs><linearGradient id="exg-${slotNumber}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgb(15,23,42)" stop-opacity="0.02"/><stop offset="32%" stop-color="rgb(15,23,42)" stop-opacity="0"/></linearGradient></defs>
                      <rect x="${XL}" y="${YT}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="url(#exg-${slotNumber})"/>
                      ${yLabs.join('')}
                      <line x1="${XL}" y1="${YT}" x2="${XL}" y2="${YB}" stroke="#e5e7eb" stroke-width="1"/><line x1="${XL}" y1="${YB}" x2="${XR}" y2="${YB}" stroke="#e5e7eb" stroke-width="1"/>
                      <text transform="translate(20 ${((YT + YB) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-family="${FONT_HS}" font-size="7.5" fill="#6b7280">System Function</text>
                      ${paths.join('')}
                      ${xLabs.join('')}
                      <text x="${((XL + XR) / 2).toFixed(1)}" y="${YB + 21}" text-anchor="middle" font-family="${FONT_HS}" font-size="7.5" fill="#6b7280">Lifespan</text>
                    </svg>`;
}

/** Figma 23838:18865 — energy vs age. */
function extensionEnergyOverAgeSvg(slotNumber) {
  const { VB, XL, YT, YB } = extChartPlotBox();
  const XR = 274;
  const W = XR - XL;
  const H = YB - YT;
  const xOf = (t) => XL + t * W;
  const yOf = (p) => YB - p * H;
  const fnEnergy = (t) => {
    // Smooth, monotonic decline across age.
    const u = Math.max(0, Math.min(1, t));
    return 1 - 0.7 * Math.pow(u, 1.55);
  };
  const d = extPathFromFn(xOf, yOf, fnEnergy, 64);
  const yLabs = [1, 0.75, 0.5, 0.25].map(
    (p, i) =>
      `<line x1="${XL}" y1="${yOf(p).toFixed(1)}" x2="${XR}" y2="${yOf(p).toFixed(1)}" stroke="#f0f0f2" stroke-width="1"/><text x="40" y="${(yOf(p) + 3).toFixed(1)}" text-anchor="end" font-family="${FONT_HS}" font-size="7" fill="#b7bcc6">${[100, 75, 50, 25][i]}%</text>`,
  );
  const ages = [20, 40, 60, 80, 100];
  const xLabs = ages.map((a) => {
    const t = (a - 20) / 80;
    return `<text x="${xOf(t).toFixed(1)}" y="${YB + 11}" text-anchor="middle" font-family="${FONT_HS}" font-size="7" fill="#9ca3af">${a}</text>`;
  });
  const aria = escAttr('Energy levels across age; illustrative curve.');
  return `                    <svg id="focus-chart-${slotNumber}" class="focus-extension-svg" viewBox="${VB}" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${aria}">
                      <defs><linearGradient id="exe-${slotNumber}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgb(15,23,42)" stop-opacity="0.02"/><stop offset="32%" stop-color="rgb(15,23,42)" stop-opacity="0"/></linearGradient></defs>
                      <rect x="${XL}" y="${YT}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="url(#exe-${slotNumber})"/>
                      ${yLabs.join('')}
                      <line x1="${XL}" y1="${YT}" x2="${XL}" y2="${YB}" stroke="#e5e7eb" stroke-width="1"/><line x1="${XL}" y1="${YB}" x2="${XR}" y2="${YB}" stroke="#e5e7eb" stroke-width="1"/>
                      <text transform="translate(20 ${((YT + YB) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-family="${FONT_HS}" font-size="7.5" fill="#6b7280">Energy</text>
                      <path d="${d}" stroke="#3b82f6" stroke-width="2" fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                      ${xLabs.join('')}
                      <text x="${((XL + XR) / 2).toFixed(1)}" y="${YB + 21}" text-anchor="middle" font-family="${FONT_HS}" font-size="7.5" fill="#6b7280">Age</text>
                    </svg>`;
}

/** Figma 23838:18898 — longevity expectation vs inflammation (ordinal axes). */
function extensionInflammationLongevitySvg(slotNumber) {
  const { VB, XL, YT, YB } = extChartPlotBox();
  const XR = 274;
  const W = XR - XL;
  const H = YB - YT;
  const xLow = XL + W * 0.12;
  const xMed = XL + W * 0.5;
  const xHigh = XL + W * 0.88;
  const yHi = YB - H * 0.88;
  const yMd = YB - H * 0.5;
  const yLo = YB - H * 0.12;
  const xSep1 = (xLow + xMed) / 2;
  const xSep2 = (xMed + xHigh) / 2;
  const ySep1 = (yHi + yMd) / 2;
  const ySep2 = (yMd + yLo) / 2;
  const aria = escAttr(
    'Longevity expectation vs inflammation load: illustrative downward relationship.',
  );
  // Flipped-log decline: gentle start, steeper fall near the right end.
  const k = 3.4;
  const pts = [];
  const n = 32;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = xLow + (xHigh - xLow) * u;
    const eased = (Math.exp(k * u) - 1) / (Math.exp(k) - 1);
    const y = yHi + (yLo - yHi) * eased;
    pts.push({ x, y });
  }
  const d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts
    .slice(1)
    .map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' L ')}`;
  return `                    <svg id="focus-chart-${slotNumber}" class="focus-extension-svg" viewBox="${VB}" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${aria}">
                      <defs><linearGradient id="exi-${slotNumber}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgb(15,23,42)" stop-opacity="0.02"/><stop offset="32%" stop-color="rgb(15,23,42)" stop-opacity="0"/></linearGradient></defs>
                      <rect x="${XL}" y="${YT}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="url(#exi-${slotNumber})"/>
                      <line x1="${xSep1.toFixed(1)}" y1="${YT}" x2="${xSep1.toFixed(1)}" y2="${YB}" stroke="#f0f0f2" stroke-width="1"/>
                      <line x1="${xSep2.toFixed(1)}" y1="${YT}" x2="${xSep2.toFixed(1)}" y2="${YB}" stroke="#f0f0f2" stroke-width="1"/>
                      <line x1="${XL}" y1="${ySep1.toFixed(1)}" x2="${XR}" y2="${ySep1.toFixed(1)}" stroke="#f0f0f2" stroke-width="1"/>
                      <line x1="${XL}" y1="${ySep2.toFixed(1)}" x2="${XR}" y2="${ySep2.toFixed(1)}" stroke="#f0f0f2" stroke-width="1"/>
                      <line x1="${XL}" y1="${YT}" x2="${XL}" y2="${YB}" stroke="#e5e7eb" stroke-width="1"/><line x1="${XL}" y1="${YB}" x2="${XR}" y2="${YB}" stroke="#e5e7eb" stroke-width="1"/>
                      <text x="40" y="${(yHi + 3).toFixed(1)}" text-anchor="end" font-family="${FONT_HS}" font-size="7" fill="#b7bcc6">High</text>
                      <text x="40" y="${(yMd + 3).toFixed(1)}" text-anchor="end" font-family="${FONT_HS}" font-size="7" fill="#b7bcc6">Med</text>
                      <text x="40" y="${(yLo + 3).toFixed(1)}" text-anchor="end" font-family="${FONT_HS}" font-size="7" fill="#b7bcc6">Low</text>
                      <text transform="translate(20 ${((YT + YB) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-family="${FONT_HS}" font-size="7" fill="#6b7280">Longevity Expectation</text>
                      <path d="${d}" stroke="#0f766e" stroke-width="2" fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                      <text x="${xLow.toFixed(1)}" y="${YB + 11}" text-anchor="middle" font-family="${FONT_HS}" font-size="7" fill="#9ca3af">Low</text>
                      <text x="${xMed.toFixed(1)}" y="${YB + 11}" text-anchor="middle" font-family="${FONT_HS}" font-size="7" fill="#9ca3af">Med</text>
                      <text x="${xHigh.toFixed(1)}" y="${YB + 11}" text-anchor="middle" font-family="${FONT_HS}" font-size="7" fill="#9ca3af">High</text>
                      <text x="${((XL + XR) / 2).toFixed(1)}" y="${YB + 22}" text-anchor="middle" font-family="${FONT_HS}" font-size="6.5" fill="#6b7280">Inflammation/Oxidative Stress</text>
                    </svg>`;
}

function renderFocusCardShell(slotIdx, s) {
  const n = slotIdx + 1;
  const fc = `fc${n}`;
  const activeCls = slotIdx === 0 ? ' is-active' : '';
  const style =
    slotIdx === 0 || slotIdx === 2 || slotIdx === 3 || slotIdx >= 4
      ? ' style="--focus-card-accent-rgb: 0, 113, 227; --focus-card-text-color: #0a69d1;"'
      : '';
  const vb =
    s.graphType === 'single_correlation'
      ? '-60 0 320 156'
      : s.graphType === '7day_average'
        ? '0 0 400 210'
        : s.graphType === 'variance'
          ? '4 38 279 140'
          : '14 38 269 140';
  const isHealthspanChart = s.graphType === 'healthspan';
  const isExtSystem = s.graphType === 'extension_system_decline';
  const isExtEnergy = s.graphType === 'extension_energy_age';
  const isExtInflam = s.graphType === 'extension_inflammation';
  const scatterExtra =
    s.graphType === 'single_correlation'
      ? ' class="trimp-chart focus-scatter-svg" overflow="visible"'
      : '';
  const titleExtra =
    s.graphType === 'single_correlation'
      ? `
                      <title>Next-day resting heart rate versus same-day training intensity.</title>`
      : '';
  let chartInner;
  if (isHealthspanChart) chartInner = healthspanLifespanVsHealthspanSvg(n);
  else if (isExtSystem) chartInner = extensionSystemDeclineSvg(n);
  else if (isExtEnergy) chartInner = extensionEnergyOverAgeSvg(n);
  else if (isExtInflam) chartInner = extensionInflammationLongevitySvg(n);
  else {
    chartInner = `                    <svg id="focus-chart-${n}" viewBox="${vb}" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escAttr(focusChartAria(s.graphType, s.metric))}"${scatterExtra}>${titleExtra}
                    </svg>`;
  }
  const legendHtml = focusLegendInner(fc, s.graphType, s.metric);

  return `        <div class="focus-card focus-card__shell${activeCls}" id="focus-card-${n}" data-focus-index="${slotIdx}" role="article" aria-label="Priority ${n} recommendation"${style}>
            <div class="focus-card__stage">
              <div class="${fc}-accent" aria-hidden="true"></div>
              <div class="${fc}-body">
                <div class="focus-card__head">
                  <h3 class="${fc}-title">${s.title}</h3>
                  <p class="${fc}-summary">${s.summary}</p>
                </div>
                <div class="${fc}-sep" aria-hidden="true"></div>
                <div class="focus-card__mid">
                  <p class="${fc}-cap">${s.cap}</p>
                  <div class="${fc}-chart-panel">
${chartInner}
                  </div>
                  ${legendHtml}
                </div>
                <div class="${fc}-footer">
                  <details class="${fc}-why-details">
                    <summary>
                      <span class="focus-why-summary-row">
                        <span class="${fc}-why-label">Why it matters</span>
                        <span class="${fc}-why-icon" aria-hidden="true"></span>
                      </span>
                    </summary>
                    <p class="${fc}-why-panel">${s.why}</p>
                  </details>
                </div>
              </div>
            </div>
        </div>`;
}

const focusChartsSnippet = fs.readFileSync(path.join(root, 'focus-charts-inline-snippet.js'), 'utf8');
const focusChartBundle = `  // REPORT_INJECT_FOCUS_DATA
  const FOCUS_SLOTS = ${JSON.stringify(focusSlotChartSpecs)};
  /*NUTRICODE_FOCUS_CHART_SNIPPET_V1*/
${focusChartsSnippet}
  /*END_NUTRICODE_FOCUS_CHART_SNIPPET_V1*/
`;

const focusStackHtml = `<!-- FOCUS_STACK_CORRELATION_START -->
${focusStackSlots.map((s, i) => renderFocusCardShell(i, s)).join('\n')}
<!-- FOCUS_STACK_CORRELATION_END -->`;

let html = fs.readFileSync(path.join(root, 'nutricode-health-report.html'), 'utf8');

function rep(re, fn) {
  const before = html;
  html = typeof fn === 'string' ? html.replace(re, fn) : html.replace(re, fn);
  if (html === before && !before.match(re)) console.warn('Pattern missed:', re);
}

rep(
  /\/\/ REPORT_INJECT_FOCUS_DATA[\s\S]*?\/\*END_NUTRICODE_FOCUS_CHART_SNIPPET_V1\*\/\s*\n|  const FC1_REM_DATA = [\s\S]*?buildFocusScatterFromRaw\(\) \{[\s\S]*?scheduleEqualizeFocusCorrelationSections\(\);\n  \}\)\(\);\n/,
  focusChartBundle,
);
rep(
  /<!-- FOCUS_STACK_CORRELATION_START -->[\s\S]*?<!-- FOCUS_STACK_CORRELATION_END -->/,
  focusStackHtml,
);
rep(
  /(<div class="rec-rhr-dots" id="recRhrDots" role="tablist" aria-label="Choose priority recommendation">)\s*[\s\S]*?(\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="focus-carousel reveal d1" id="focusCarousel")/,
  `$1\n${dotsButtonsHtml}\n            $2`,
);
rep(
  /<span id="recRhrCount"[^>]*>PRIORITY · 1 of \d+<\/span>/,
  `<span id="recRhrCount" aria-live="polite">PRIORITY · 1 of ${focusStackSlots.length}</span>`,
);
rep(
  /<p class="score-headline">[^<]*<\/p>/,
  `<p class="score-headline">${escapeHtmlText(scoreHeadline)}</p>`,
);
rep(
  /<p class="score-context">[^<]*<\/p>/,
  `<p class="score-context">${escapeHtmlText(scoreContext)}</p>`,
);
rep(
  /<h2 class="section-label section-label--caps" id="focus-heading">[\s\S]*?<\/h2>/,
  `<h2 class="section-label section-label--caps" id="focus-heading">How you move from ${healthScore} to 90+</h2>`,
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
const reportTitle = reportTitleParts(raw);
rep(/<h1 class="report-name">[\s\S]*?<\/h1>/, `<h1 class="report-name">${reportTitle.html}</h1>`);
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

// Score ring + phase row (metric health card — single source: scorePhase)
rep(
  /<div class="score-ring-wrap" data-score="/,
  `<div class="${scorePhase.scoreRingWrapClass}" data-score="`,
);
rep(/data-score="\d+"/, `data-score="${healthScore}"`);
rep(
  /(<text x="0" y="-6" text-anchor="middle"\s*font-size="28"[^>]*>)\d+(<\/text>)/,
  `$1${healthScore}$2`,
);
rep(
  /(id="score-ring-arc"[\s\S]*?stroke=")(#[0-9A-Fa-f]+)/,
  `$1${scorePhase.ringStroke}`,
);
rep(
  /(id="score-ring-arc"[\s\S]*?stroke-dasharray=")[\d.]+ [\d.]+/,
  `$1${dash.toFixed(2)} ${dashRest.toFixed(2)}`,
);
rep(
  /aria-label="Health score: \d+ out of 100"/,
  `aria-label="Health score: ${healthScore} out of 100"`,
);
rep(
  /<div class="metric-health-phase-row">[\s\S]*?<span class="phase-of">of 2<\/span>\s*<\/div>\s*<p class="score-headline">/,
  `${metricHealthPhaseRowHtml(scorePhase.phase)}\n          <p class="score-headline">`,
);

// Limiting list
rep(
  /<p class="limiting-label">[\s\S]*?<\/p>/,
  `<p class="limiting-label">${escapeHtmlText(limitingSectionTitle)}</p>`,
);
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
  /<div class="snap-tile-value snap-tile-value--row">\s*<p class="snap-val">(?:[\d.]+|\u2014|\u2013|-)<\/p>\s*<span class="snap-tag snap-tag--[-\w]+">[^<]*<\/span>/,
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
  /<!-- TRIMP_CHART_AXES_START -->[\s\S]*?<!-- TRIMP_CHART_AXES_END -->/,
  `<!-- TRIMP_CHART_AXES_START -->\n${trimpChartAxesSvg}\n<!-- TRIMP_CHART_AXES_END -->`,
);
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
    cohort_standing_pct: b.standingPct ?? null,
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
    report_title: reportTitle.plain,
  },
  health_score: {
    score: healthScore,
    headline: scoreHeadline,
    context: scoreContext,
    score_band_id: scorePhase.bandId,
    phase_current: scorePhase.phase,
    phase_label: overallHealthScoreState.phase,
    phase_total: 2,
    ring_stroke_hex: scorePhase.ringStroke,
    health_metrics_percentile: overallHealthScoreState.percentile,
    demographic_composite_mean: overallHealthScoreState.demographicMean,
    percentile_model: 'normal_cdf_vs_demographicCompositeScoreMean',
    percentile_sigma: COMPOSITE_SCORE_SD,
    ahead_of_peer_pct: aheadPct,
    ahead_of_peer_pct_basis:
      bioStandingSamples.length > 0 ? 'biometric_standing_mean' : 'health_score_fallback',
    ahead_of_peer_metrics_count: bioStandingSamples.length,
    ring_circumference: C,
    ring_dash: +dash.toFixed(2),
    ring_dash_gap: +dashRest.toFixed(2),
  },
  longevity_path: {
    selected_graph: projectionBand,
    selected_card_class: `proj-card--${projectionBand}`,
  },
  limiting_section_title: limitingSectionTitle,
  limiting_metrics: limits.map((l) => ({
    name: l.name,
    badge: l.badge,
    dot: l.dot,
    issue_type: l.issueType ?? null,
    severity_score: l.severityScore ?? 0,
  })),
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
    duration_axis_max_seconds: trimpChartMaxDurationSec,
    duration_axis_max_hours: Math.round(trimpChartMaxDurationSec / 3600),
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
    tab_order: focusStackSlots.map((s, idx) => ({
      priority: idx + 1,
      metric: s.metric,
      tab_label: focusDotLabelForStackIndex(idx, s),
    })),
    cards: focusStackSlots.map((s, i) => ({
      slot: i + 1,
      dom_id: `focus-card-${i + 1}`,
      metric: s.metric,
      chart_type: s.graphType,
      tab_label: focusDotLabelForStackIndex(i, s),
      title: s.title,
      summary_html: s.summary,
      chart_caption: s.cap,
      why_panel: s.why,
      chart_data: s.data,
      correlation: s.corr
        ? {
            label: s.corr.label,
            marginScore: s.corr.marginScore,
            csvKey: s.corr.csvKey ?? null,
            significant: s.corr.significant,
          }
        : null,
    })),
  },
};

if (process.argv.includes('--validate-health-score-phases')) {
  logHealthScorePhaseValidation();
}
if (process.argv.includes('--debug-limiting-metrics')) {
  logLimitingMetricsDebug();
}

fs.writeFileSync(path.join(root, 'report_data.json'), `${JSON.stringify(reportData, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(root, 'nutricode-health-report.html'), html, 'utf8');
console.log('Updated nutricode-health-report.html and report_data.json from raw_data2.json + focus order.');
