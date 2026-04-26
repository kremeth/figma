#!/usr/bin/env node
// Populate supplement_impact_report_updated.html from an extraction JSON.
// Usage:
//   node populate-supplement-impact.mjs \
//     --data extraction_Mitch_Woodward_apple_APR_2026.json \
//     --template supplement_impact_report_updated.html \
//     --out supplement_impact_report_populated.html

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    data: "extraction_Mitch_Woodward_apple_APR_2026.json",
    template: "supplement_impact_report_updated.html",
    out: "supplement_impact_report_populated.html",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--data" || a === "--template" || a === "--out") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[++i];
    } else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node populate-supplement-impact.mjs [--data file.json] [--template file.html] [--out file.html]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function round(v, dec = 0) {
  if (!isNum(v)) return null;
  const m = 10 ** dec;
  return Math.round(v * m) / m;
}

function capFirst(s) {
  return typeof s === "string" && s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIsoDate(iso) {
  // "2026-03-17" → { y, m, d }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Bad ISO date: ${iso}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function monthDay(iso) {
  const { m, d } = parseIsoDate(iso);
  return `${MONTHS_SHORT[m - 1]} ${d}`;
}

function formatDateRangeLabel(start, end) {
  // "Mar 17 – Apr 9, 2026" (en-dash; same year assumed, pulled from end)
  const { y } = parseIsoDate(end);
  return `${monthDay(start)} \u2013 ${monthDay(end)}, ${y}`;
}

function ageBand(age) {
  // Match cohort bands used by the report (men aged 36–45, etc.)
  if (age < 26) return "18-25";
  if (age < 36) return "26-35";
  if (age < 46) return "36-45";
  if (age < 56) return "46-55";
  if (age < 66) return "56-65";
  return "66+";
}

function ageBandLabel(band) {
  // "36-45" → "36–45" (en-dash)
  return band.replace("-", "\u2013");
}

/** Supplement stack for the report header when not set on extraction `info`. */
const REPORT_STACK = {
  sub: "CoQ10 / Magnesium / Omega 3 / Vitamin D",
};

const METRICS_RESEARCH_FILENAME = "metrics_supplement_research copy 5.json";

/** Map extraction / header names → keys in metrics research JSON. */
function normalizeSupplementResearchKey(name) {
  if (typeof name !== "string") return "";
  let s = name.trim();
  if (!s) return "";
  if (/^omega-?3$/i.test(s)) return "Omega 3";
  return s;
}

/** Column header text (e.g. Omega 3 → Omega-3). */
function displaySupplementColumnName(researchKey) {
  if (researchKey === "Omega 3") return "Omega-3";
  return researchKey;
}

function getStackKeys(ctx) {
  const info = ctx.info || {};
  if (Array.isArray(info.supplements) && info.supplements.length) {
    return info.supplements.map(normalizeSupplementResearchKey).filter(Boolean);
  }
  if (typeof info.supplement_stack === "string" && info.supplement_stack.trim()) {
    return info.supplement_stack
      .split(/\s*\/\s*/)
      .map(normalizeSupplementResearchKey)
      .filter(Boolean);
  }
  return REPORT_STACK.sub.split(/\s*\/\s*/).map((x) => normalizeSupplementResearchKey(x)).filter(Boolean);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Expected support matrix rows — keys match top-level objects in metrics research JSON. */
const EXPECTED_MATRIX_METRICS = [
  { label: "Recovery", key: "recovery" },
  { label: "HRV", key: "hrv" },
  { label: "Deep Sleep", key: "deep_sleep" },
  { label: "REM Sleep", key: "rem_sleep" },
  { label: "Sleep Quality", key: "sleep_quality" },
  { label: "Sleep Disruptions", key: "sleep_disruptions" },
  { label: "RHR", key: "rhr" },
  { label: "VO2 Max", key: "vo2_max" },
  { label: "Workout Effort", key: "workout_effort" },
];

function cellFromResearchEntry(entry) {
  if (!entry || !Number.isFinite(entry.supplement_score)) {
    return { cls: "matrix-pill--support-na", text: "Not targeted", title: "" };
  }
  const score = entry.supplement_score;
  const imp = (entry.impact || "").trim();
  const title = `Research supplement score ${score}`;
  if (imp === "Very High") return { cls: "matrix-pill--support-vh", text: "Very high", title };
  if (imp === "High") return { cls: "matrix-pill--support-h", text: "High", title };
  if (imp === "Moderate") return { cls: "matrix-pill--support-m", text: "Moderate", title };
  if (imp === "Low") return { cls: "matrix-pill--support-m", text: "Low", title: `${title}; impact ${imp}` };
  return { cls: "matrix-pill--support-m", text: "Moderate", title: `${title}; impact ${imp || "n/a"}` };
}

function buildExpectedSupportMatrixHtml(metricsResearch, stackKeys) {
  if (!stackKeys.length) return "";
  const thCols = stackKeys
    .map((k) => `<th>${escapeHtml(displaySupplementColumnName(k))}</th>`)
    .join("\n                ");
  const rows = EXPECTED_MATRIX_METRICS.map(({ label, key }) => {
    const metricBlock = metricsResearch[key] || {};
    const tds = stackKeys
      .map((sup) => {
        const entry = metricBlock[sup];
        const { cls, text, title } = cellFromResearchEntry(entry);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `                <td><span class="matrix-pill ${cls}"${titleAttr}>${escapeHtml(text)}</span></td>`;
      })
      .join("\n");
    return `              <tr>
                <th>${escapeHtml(label)}</th>
${tds}
              </tr>`;
  }).join("\n");

  return `      <p class="section-label stack-focus-heading" id="stack-focus-areas-heading">Where the starting stack was expected to help</p>
      <div class="matrix-card card header-expected-matrix" aria-labelledby="stack-focus-areas-heading">
        <h3 class="matrix-card__title">Expected areas of support</h3>
        <p class="matrix-card__body">This shows where each supplement was most likely to help before we looked at the 30-day outcome. Labels follow <strong>supplement_score</strong> + impact tiers from the research library (hover a cell for the numeric score).</p>
        <div class="matrix-scroll">
          <table class="matrix-table" aria-label="Expected support matrix">
            <thead>
              <tr>
                <th>Metric</th>
                ${thCols}
              </tr>
            </thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>
      </div>`;
}

function meanRecoveryInRange(days, lo, hi) {
  const vals = [];
  for (const d of days) {
    if (d.dayN < lo || d.dayN > hi) continue;
    if (isNum(d.recovery)) vals.push(d.recovery);
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Pre-stack vs last-7 extract days — shared by Nutricode composite header and recovery card.
 * - Baseline: all extract days strictly before first supplement day (hinge = last pre day).
 * - Recent: last up to 7 nights in the extract.
 */
function computeCompositeWindowDays(ctx) {
  const n = ctx.days.length;
  const hinge = ctx.hingeBreakDay;
  const w1Lo = 1;
  const w1Hi = Math.max(0, hinge);
  const w4Hi = Math.max(1, n);
  const w4Lo = Math.max(1, n - 6);
  return { w1Lo, w1Hi, w4Lo, w4Hi };
}

/** WHOOP (or any) daily recovery %: mean over all pre-supplement days vs last 7 days (same windows as composite). */
function buildRecoveryCardPayload(ctx) {
  const days = ctx.days;
  const n = days.length;
  if (n < 1) return null;
  const { w1Lo, w1Hi, w4Lo, w4Hi } = computeCompositeWindowDays(ctx);
  if (w1Hi < w1Lo) return null;
  const m1 = meanRecoveryInRange(days, w1Lo, w1Hi);
  const m4 = meanRecoveryInRange(days, w4Lo, w4Hi);
  if (m1 == null || m4 == null) return null;
  const r1 = Math.round(m1);
  const r4 = Math.round(m4);
  const pctRel = m1 > 0 ? Math.round(((m4 - m1) / m1) * 100) : 0;

  // Same rounded score: treat as flat (avoid red "Lower" when raw means differ slightly, e.g. −1%).
  if (r1 === r4) {
    return {
      r1,
      r4,
      pillClass: "pill--flat",
      pillText: "Stayed constant",
      cardMod: "metric-card--flat",
      deltaClass: "is-flat",
      deltaStr: "±0%",
      pctRel: 0,
    };
  }

  let pillClass = "pill--hold";
  let pillText = "Stable";
  let cardMod = "metric-card--up";
  let deltaClass = "is-up";
  if (pctRel > 0) {
    pillClass = "pill--up";
    pillText = "Improved";
    cardMod = "metric-card--up";
    deltaClass = "is-up";
  } else if (pctRel < 0) {
    pillClass = "pill--down";
    pillText = "Lower";
    cardMod = "metric-card--down";
    deltaClass = "is-down";
  } else {
    pillClass = "pill--hold";
    pillText = "Stable";
    cardMod = "metric-card--up";
    deltaClass = "is-up";
  }
  let deltaStr = "±0%";
  if (pctRel > 0) deltaStr = `+${pctRel}%`;
  else if (pctRel < 0) deltaStr = `${pctRel}%`;
  return { r1, r4, pillClass, pillText, cardMod, deltaClass, deltaStr, pctRel };
}

function renderRecoveryMetricCard(p, deviceRaw) {
  const dev = (deviceRaw || "").toLowerCase();
  const headingId = dev === "whoop" ? "whoop-recovery-heading" : "device-recovery-heading";
  const title =
    dev === "whoop"
      ? "WHOOP Recovery"
      : `${capFirst(deviceRaw || "device")} recovery`;
  const compareAria =
    dev === "whoop"
      ? "WHOOP recovery score: pre-stack average vs last 7 days"
      : `Recovery score: pre-stack average vs last 7 days (${deviceRaw || "device"})`;
  return `      <div class="metric-card ${p.cardMod} metric-card--line card" aria-labelledby="${headingId}">
        <div class="metric-card-line__main">
          <div class="metric-card-line__lead">
            <div class="metric-card-line__title-row">
              <span class="pill ${p.pillClass}">${p.pillText}</span>
              <h3 class="metric-card__name" id="${headingId}">${title} <span class="metric-card-line__paren">Average score</span></h3>
            </div>
          </div>

          <div class="metric-card-line__compare" role="group" aria-label="${compareAria}">
            <div class="metric-card-line__node">
              <span class="metric-card-line__node-label">Pre-stack</span>
              <div class="metric-card-line__node-value">
                <span class="mono">${p.r1}</span><span class="metric-card-line__node-suffix">/100</span>
              </div>
            </div>
            <div class="metric-card-line__bridge" aria-hidden="true">
              <span class="metric-card-line__bridge-line"></span>
              <svg class="metric-card-line__bridge-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 12h12m0 0l-4.5-4.5M17 12l-4.5 4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="metric-card-line__node metric-card-line__node--now">
              <span class="metric-card-line__node-label">Last 7 days</span>
              <div class="metric-card-line__node-value">
                <span class="mono">${p.r4}</span><span class="metric-card-line__node-suffix">/100</span>
              </div>
            </div>
          </div>

          <div class="metric-card-line__delta-col">
            <span class="metric-card__delta metric-card-line__delta-pill ${p.deltaClass}">${p.deltaStr}</span>
            <span class="metric-card-line__delta-cap">vs pre-stack</span>
          </div>
        </div>
      </div>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-day derivation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extract-day index of the last calendar day strictly before supplements began.
 * Hinge regression uses this as the breakpoint (continuous at c; grey dots for day <= c).
 * Override with extraction.info.supplement_start_date (YYYY-MM-DD) = first day on stack.
 */
function supplementStartIsoFromExtraction(extraction) {
  const raw = extraction.info && extraction.info.supplement_start_date;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();
  return "2026-03-27";
}

function computeHingeBreakDay(days, supplementStartIso) {
  let last = 0;
  for (const d of days) {
    if (typeof d.date === "string" && d.date < supplementStartIso) last = d.dayN;
  }
  return last;
}

function buildContext(extraction) {
  const meta = extraction.visualization.meta;
  const dates = meta.date_keys; // length = num_days
  const M = extraction.visualization.metrics || {};
  const A = extraction.visualization.daily_activity || {};
  const T = extraction.visualization.total_activity || {};
  const info = extraction.info || {};
  const dr = extraction.date_range || {};

  const days = [];
  for (let i = 0; i < dates.length; i++) {
    const dayN = i + 1;
    const date = dates[i];
    const key = String(dayN);
    const act = (A[key] && A[key].total) || {};
    days.push({
      dayN,
      date,
      rem: M.rem_sleep ? M.rem_sleep[key] : null,
      deep: M.deep_sleep ? M.deep_sleep[key] : null,
      light: M.light_sleep ? M.light_sleep[key] : null,
      awake: M.awake_time ? M.awake_time[key] : null,
      sleepSec: M.sleep_time ? M.sleep_time[key] : null,
      disturb: M.disturbances ? M.disturbances[key] : null,
      hrv: M.HRV ? M.HRV[key] : null,
      rhr: M.RHR ? M.RHR[key] : null,
      vo2: M.vo2_max ? M.vo2_max[key] : null,
      trainSec: act.total_duration,
      intensity: act.average_intensity,
      recovery: M.recovery ? M.recovery[key] : null,
    });
  }

  // Training-load stats
  let trainingDays = 0;
  for (const d of days) {
    if (isNum(d.trainSec) && d.trainSec > 0) trainingDays++;
  }
  let totalActivitySec = 0;
  for (const k of Object.keys(T)) {
    const v = T[k] && T[k].total_duration;
    if (isNum(v)) totalActivitySec += v;
  }
  const totalActivityHours = totalActivitySec / 3600;

  const supplementStartIso = supplementStartIsoFromExtraction(extraction);
  const hingeBreakDay = computeHingeBreakDay(days, supplementStartIso);

  return {
    info,
    dateRange: dr,
    meta,
    totalActivity: T,
    days,
    trainingDays,
    totalActivityHours,
    supplementStartIso,
    hingeBreakDay,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Series (18 *_POINTS arrays)
// ──────────────────────────────────────────────────────────────────────────

function stageSumOf(d) {
  if (isNum(d.rem) && isNum(d.deep) && isNum(d.light) && isNum(d.awake)) {
    const s = d.rem + d.deep + d.light + d.awake;
    return s > 0 ? s : null;
  }
  return null;
}

function buildSeries(days) {
  const DEEP_POINTS = [];
  const DEEP_TIME_POINTS = [];
  const REM_POINTS = [];
  const REM_TIME_POINTS = [];
  const RESTORATIVE_TIME_POINTS = [];
  const RESTORATIVE_PCT_POINTS = [];
  const RHR_POINTS = [];
  const HRV_POINTS = [];
  const INTENSITY_POINTS = [];
  const TRAINING_TIME_POINTS = [];
  const TRIMP_POINTS = [];
  const VO2_MAX_POINTS = [];
  const ASLEEP_POINTS = [];
  const DISTURBANCES_POINTS = [];
  const DISTURBANCES_PER_HOUR_POINTS = [];
  const SLEEP_EFFICIENCY_POINTS = [];
  const LIGHT_SLEEP_PCT_POINTS = [];
  const AWAKE_SLEEP_PCT_POINTS = [];

  for (const d of days) {
    const base = { day: d.dayN, date: d.date };
    const ss = stageSumOf(d);

    // Stage percentages (4-stage denominator, matches template method notes)
    const deepPct = ss != null ? round((d.deep / ss) * 100, 2) : null;
    const remPct = ss != null ? round((d.rem / ss) * 100, 2) : null;
    const lightPct = ss != null ? round((d.light / ss) * 100, 1) : null;
    const awakePct = ss != null ? round((d.awake / ss) * 100, 1) : null;
    const restorativeSec = isNum(d.deep) && isNum(d.rem) ? d.deep + d.rem : null;
    const restorativePct =
      ss != null && restorativeSec != null ? round((restorativeSec / ss) * 100, 2) : null;
    const sleepEffPct =
      ss != null && isNum(d.rem) && isNum(d.deep) && isNum(d.light)
        ? round(((d.rem + d.deep + d.light) / ss) * 100, 1)
        : null;

    // Minutes (from seconds)
    const deepMin = isNum(d.deep) ? Math.round(d.deep / 60) : null;
    const remMin = isNum(d.rem) ? Math.round(d.rem / 60) : null;
    const restorativeMin = isNum(restorativeSec) ? Math.round(restorativeSec / 60) : null;
    const asleepMin = isNum(d.sleepSec) ? Math.round(d.sleepSec / 60) : null;
    const trainingMin = isNum(d.trainSec) ? Math.round(d.trainSec / 60) : null;

    // Intensity & TRIMP proxy
    const intensityPct = isNum(d.intensity) ? round(d.intensity * 100, 1) : null;
    const trimp =
      intensityPct != null && trainingMin != null ? round(trainingMin * intensityPct, 1) : null;

    // Disturbances per hour of sleep
    const sleepHours = isNum(d.sleepSec) && d.sleepSec > 0 ? d.sleepSec / 3600 : null;
    const disturbPerHour =
      isNum(d.disturb) && sleepHours != null ? round(d.disturb / sleepHours, 3) : null;

    DEEP_POINTS.push({ ...base, pct: deepPct });
    DEEP_TIME_POINTS.push({ ...base, val: deepMin });
    REM_POINTS.push({ ...base, pct: remPct });
    REM_TIME_POINTS.push({ ...base, val: remMin });
    RESTORATIVE_TIME_POINTS.push({ ...base, val: restorativeMin });
    RESTORATIVE_PCT_POINTS.push({ ...base, pct: restorativePct });
    RHR_POINTS.push({ ...base, val: isNum(d.rhr) ? Math.round(d.rhr) : null });
    HRV_POINTS.push({ ...base, val: isNum(d.hrv) ? Math.round(d.hrv) : null });
    INTENSITY_POINTS.push({ ...base, val: intensityPct });
    TRAINING_TIME_POINTS.push({ ...base, val: trainingMin });
    TRIMP_POINTS.push({ ...base, val: trimp });
    VO2_MAX_POINTS.push({ ...base, val: isNum(d.vo2) ? round(d.vo2, 2) : null });
    ASLEEP_POINTS.push({ ...base, val: asleepMin });
    DISTURBANCES_POINTS.push({ ...base, val: isNum(d.disturb) ? d.disturb : null });
    DISTURBANCES_PER_HOUR_POINTS.push({ ...base, val: disturbPerHour });
    SLEEP_EFFICIENCY_POINTS.push({ ...base, val: sleepEffPct });
    LIGHT_SLEEP_PCT_POINTS.push({ ...base, pct: lightPct });
    AWAKE_SLEEP_PCT_POINTS.push({ ...base, pct: awakePct });
  }

  return {
    DEEP_POINTS,
    DEEP_TIME_POINTS,
    REM_POINTS,
    REM_TIME_POINTS,
    RESTORATIVE_TIME_POINTS,
    RESTORATIVE_PCT_POINTS,
    RHR_POINTS,
    HRV_POINTS,
    INTENSITY_POINTS,
    TRAINING_TIME_POINTS,
    TRIMP_POINTS,
    VO2_MAX_POINTS,
    ASLEEP_POINTS,
    DISTURBANCES_POINTS,
    DISTURBANCES_PER_HOUR_POINTS,
    SLEEP_EFFICIENCY_POINTS,
    LIGHT_SLEEP_PCT_POINTS,
    AWAKE_SLEEP_PCT_POINTS,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Composite health score (Nutricode v3) — mirrors <script> in the HTML template
// ──────────────────────────────────────────────────────────────────────────

function meanForDayRangePoints(points, dayLo, dayHi, getVal) {
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.day < dayLo || p.day > dayHi) continue;
    const v = getVal(p);
    if (v != null && typeof v === "number" && !Number.isNaN(v)) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : null;
}

function buildCompositeRawMetricsFromSeries(series, dayLo, dayHi) {
  return {
    hrv: meanForDayRangePoints(series.HRV_POINTS, dayLo, dayHi, (p) => p.val),
    vo2: meanForDayRangePoints(series.VO2_MAX_POINTS, dayLo, dayHi, (p) => p.val),
    rhr: meanForDayRangePoints(series.RHR_POINTS, dayLo, dayHi, (p) => p.val),
    deep: meanForDayRangePoints(series.DEEP_POINTS, dayLo, dayHi, (p) => p.pct),
    eff: meanForDayRangePoints(series.SLEEP_EFFICIENCY_POINTS, dayLo, dayHi, (p) => p.val),
    dis: meanForDayRangePoints(series.DISTURBANCES_PER_HOUR_POINTS, dayLo, dayHi, (p) => p.val),
    rem: meanForDayRangePoints(series.REM_POINTS, dayLo, dayHi, (p) => p.pct),
    sleep: meanForDayRangePoints(series.ASLEEP_POINTS, dayLo, dayHi, (p) =>
      p.val != null ? p.val / 60 : null
    ),
    awake: meanForDayRangePoints(series.AWAKE_SLEEP_PCT_POINTS, dayLo, dayHi, (p) => p.pct),
    light: meanForDayRangePoints(series.LIGHT_SLEEP_PCT_POINTS, dayLo, dayHi, (p) => p.pct),
  };
}

function ncClamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function metricScoreStdNC(raw, poor, excellent) {
  if (raw == null || !Number.isFinite(raw)) return null;
  return ncClamp(((raw - poor) / (excellent - poor)) * 100, 0, 100);
}

function metricScoreInvNC(raw, poor, excellent) {
  if (raw == null || !Number.isFinite(raw)) return null;
  return ncClamp(((poor - raw) / (poor - excellent)) * 100, 0, 100);
}

function nutricodeHealthScoreV3(raw) {
  const defs = [
    { key: "hrv", w: 0.22, score: metricScoreStdNC(raw.hrv, 20, 100) },
    { key: "vo2", w: 0.18, score: metricScoreStdNC(raw.vo2, 25, 55) },
    { key: "rhr", w: 0.12, score: metricScoreInvNC(raw.rhr, 80, 45) },
    { key: "deep", w: 0.12, score: metricScoreStdNC(raw.deep, 10, 22) },
    { key: "eff", w: 0.1, score: metricScoreStdNC(raw.eff, 70, 98) },
    { key: "dis", w: 0.08, score: metricScoreInvNC(raw.dis, 3.5, 0.5) },
    { key: "rem", w: 0.07, score: metricScoreStdNC(raw.rem, 15, 25) },
    { key: "sleep", w: 0.07, score: metricScoreStdNC(raw.sleep, 5, 8.5) },
    { key: "awake", w: 0.02, score: metricScoreInvNC(raw.awake, 15, 3) },
    { key: "light", w: 0.02, score: metricScoreInvNC(raw.light, 70, 45) },
  ];
  if (raw.sleep != null && Number.isFinite(raw.sleep) && raw.sleep < 7) {
    const sleepM = defs.find((d) => d.key === "sleep");
    if (sleepM && sleepM.score != null) sleepM.score = Math.max(sleepM.score, 60);
  }
  const available = defs.filter((x) => x.score != null && Number.isFinite(x.score));
  if (available.length < 3) return null;
  const wSum = available.reduce((a, x) => a + x.w, 0);
  const weighted = available.reduce((a, x) => a + x.score * (x.w / wSum), 0);
  return Math.round(ncClamp(weighted, 0, 100));
}

function computeCompositeScores(series, w1Lo, w1Hi, w4Lo, w4Hi) {
  const raw1 = buildCompositeRawMetricsFromSeries(series, w1Lo, w1Hi);
  const raw4 = buildCompositeRawMetricsFromSeries(series, w4Lo, w4Hi);
  return {
    s1: nutricodeHealthScoreV3(raw1),
    s4: nutricodeHealthScoreV3(raw4),
  };
}

/** Matches updateCompositeShiftHeader() delta label. */
function formatCompositeDeltaPoints(s1, s4) {
  const d = s4 - s1;
  const ad = Math.abs(d);
  const deltaCore = d === 0 ? "\u00b10" : d > 0 ? `+${d}` : `\u2212${ad}`;
  const ptWord = ad === 1 ? "point" : "points";
  return `${deltaCore} ${ptWord}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Sleep-mix (W1/W4) averages
// ──────────────────────────────────────────────────────────────────────────

function collectNights(days, k, direction) {
  // direction: "first" or "last"
  const usable = days.filter((d) => stageSumOf(d) != null);
  if (!usable.length) return [];
  if (direction === "first") return usable.slice(0, k);
  return usable.slice(Math.max(0, usable.length - k));
}

function meanOf(values) {
  const vals = values.filter(isNum);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function normalizeToSumTo100(parts) {
  // parts = [rem, deep, light, awake] as float percentages summing ~100
  const safe = parts.map((v) => (isNum(v) ? v : 0));
  const rounded = safe.map((v) => Math.round(v));
  let diff = 100 - rounded.reduce((a, b) => a + b, 0);
  const fracs = safe.map((v, i) => [v - rounded[i], i]);
  while (diff !== 0) {
    // Pick the index whose rounding lost the most (for diff>0) or gained the most (for diff<0)
    if (diff > 0) {
      fracs.sort((a, b) => b[0] - a[0]);
      const [, idx] = fracs[0];
      rounded[idx] += 1;
      fracs[0][0] -= 1;
      diff -= 1;
    } else {
      fracs.sort((a, b) => a[0] - b[0]);
      const [, idx] = fracs[0];
      rounded[idx] -= 1;
      fracs[0][0] += 1;
      diff += 1;
    }
  }
  return rounded;
}

function computeWeekMix(days, direction, k = 7) {
  const nights = collectNights(days, k, direction);
  if (!nights.length) return { rem: 0, deep: 0, light: 0, awake: 0 };
  const remMean = meanOf(nights.map((d) => (d.rem / stageSumOf(d)) * 100));
  const deepMean = meanOf(nights.map((d) => (d.deep / stageSumOf(d)) * 100));
  const lightMean = meanOf(nights.map((d) => (d.light / stageSumOf(d)) * 100));
  const awakeMean = meanOf(nights.map((d) => (d.awake / stageSumOf(d)) * 100));
  const [rem, deep, light, awake] = normalizeToSumTo100([
    remMean || 0,
    deepMean || 0,
    lightMean || 0,
    awakeMean || 0,
  ]);
  return { rem, deep, light, awake };
}

/** Mean sleep-stage mix over extract days in [lo, hi] with valid stage totals (pre-stack or last-7 windows). */
function computeMixForDayRange(days, lo, hi) {
  const nights = days.filter((d) => d.dayN >= lo && d.dayN <= hi && stageSumOf(d) != null);
  if (!nights.length) return { rem: 0, deep: 0, light: 0, awake: 0 };
  const remMean = meanOf(nights.map((d) => (d.rem / stageSumOf(d)) * 100));
  const deepMean = meanOf(nights.map((d) => (d.deep / stageSumOf(d)) * 100));
  const lightMean = meanOf(nights.map((d) => (d.light / stageSumOf(d)) * 100));
  const awakeMean = meanOf(nights.map((d) => (d.awake / stageSumOf(d)) * 100));
  const [rem, deep, light, awake] = normalizeToSumTo100([
    remMean || 0,
    deepMean || 0,
    lightMean || 0,
    awakeMean || 0,
  ]);
  return { rem, deep, light, awake };
}

// ──────────────────────────────────────────────────────────────────────────
// Edits
// ──────────────────────────────────────────────────────────────────────────

function mkReplaceOnce(stateObj) {
  return function replaceOnce(needle, replacement, label) {
    const idx = stateObj.html.indexOf(needle);
    if (idx < 0) {
      throw new Error(`[${label}] anchor not found: ${JSON.stringify(needle.slice(0, 120))}...`);
    }
    const after = stateObj.html.indexOf(needle, idx + needle.length);
    if (after >= 0) {
      throw new Error(`[${label}] anchor is not unique (appears at ${idx} and ${after})`);
    }
    stateObj.html = stateObj.html.slice(0, idx) + replacement + stateObj.html.slice(idx + needle.length);
  };
}

function mkReplaceRegex(stateObj) {
  return function replaceRegex(re, replacement, label) {
    if (!re.global) {
      const m = re.exec(stateObj.html);
      if (!m) throw new Error(`[${label}] regex not matched: ${re}`);
    }
    let count = 0;
    stateObj.html = stateObj.html.replace(re, (...args) => {
      count++;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    if (count === 0) throw new Error(`[${label}] regex not matched: ${re}`);
    if (!re.global && count > 1) {
      throw new Error(`[${label}] regex matched ${count} times (not unique): ${re}`);
    }
    return count;
  };
}

function applyEdits(htmlIn, ctx, series, mix, metricsResearch = {}) {
  const state = { html: htmlIn };
  const replaceOnce = mkReplaceOnce(state);
  const replaceRegex = mkReplaceRegex(state);

  const dateRangeLabel = formatDateRangeLabel(ctx.dateRange.start, ctx.dateRange.end);
  const genderLabel = capFirst(ctx.info.gender || "") || "";
  const ageLabel = `${genderLabel} / Age ${ctx.info.age}`;
  const reviewWindowValue = `${ctx.dateRange.day_count} days`;
  const cohortBand = ageBand(ctx.info.age);
  const HIDE = 'hidden style="display:none"';
  const stackKeys = getStackKeys(ctx);
  const stackValueLabel = `${stackKeys.length} supplement${stackKeys.length === 1 ? "" : "s"}`;
  const stackSubLabel = stackKeys.map(displaySupplementColumnName).join(" / ");

  // Header badges (line ~2509–2510)
  replaceOnce(
    '<span class="report-badge">Mar 3 - Apr 13, 2026</span>',
    `<span class="report-badge">${dateRangeLabel}</span>`,
    "header badge: date range"
  );
  replaceOnce(
    '<span class="report-badge">Male / Age 26</span>',
    `<span class="report-badge">${ageLabel}</span>`,
    "header badge: gender/age"
  );

  // Header stat cards (lines ~2520–2534)
  replaceOnce(
    `<div class="header-stat__label">Review Window</div>
          <div class="header-stat__value mono">30 days</div>
          <div class="header-stat__sub">Week 1 baseline vs week 4 now</div>`,
    `<div class="header-stat__label">Review Window</div>
          <div class="header-stat__value mono">${reviewWindowValue}</div>
          <div class="header-stat__sub">Pre-stack vs last 7 nights</div>`,
    "header-stat: Review Window"
  );
  replaceOnce(
    `<div class="header-stat__label">Stack</div>
          <div class="header-stat__value">4 supplements</div>
          <div class="header-stat__sub">CoQ10 / Probiotics / Omega-3 / Magnesium</div>`,
    `<div class="header-stat__label">Stack</div>
          <div class="header-stat__value">${stackValueLabel}</div>
          <div class="header-stat__sub">${stackSubLabel}</div>`,
    "header-stat: Stack"
  );
  replaceOnce(
    `<div class="header-stat__label">Training Load</div>
          <div class="header-stat__value mono">16 days</div>
          <div class="header-stat__sub">9.0 total hours logged</div>`,
    `<div class="header-stat__label">Training Load</div>
          <div class="header-stat__value mono">${ctx.trainingDays} days</div>
          <div class="header-stat__sub">${ctx.totalActivityHours.toFixed(1)} total hours logged</div>`,
    "header-stat: Training Load"
  );

  // Biometric-panel note cohort band (line ~2704)
  replaceOnce(
    "men aged 26\u201335",
    `men aged ${ageBandLabel(cohortBand)}`,
    "bio-panel-note: cohort band"
  );

  // Footer date range (line ~3629)
  replaceOnce(
    "Generated from Garmin data / Mar 3 - Apr 13, 2026 (30-day slice: extract days 21\u201350 of 50)",
    `Generated from ${capFirst(ctx.meta.device || "device")} data / ${dateRangeLabel} (${
      ctx.dateRange.day_count
    }-day extraction)`,
    "footer: date range"
  );

  // Sleep-architecture: pre-stack vs last 7 nights (lines ~2993–3025)
  replaceOnce(
    '<div class="sleep-card sleep-card--mix card" aria-label="Week 1 vs week 4 sleep stage composition">',
    '<div class="sleep-card sleep-card--mix card" aria-label="Pre-stack vs last 7 nights sleep stage composition">',
    "sleep-mix: card aria"
  );
  replaceOnce(
    '<div class="sleep-track" role="img" aria-label="Week 1 average sleep stages: REM 20 percent, Deep 14 percent, Light 62 percent, Awake 4 percent" style="--sleep-mix-cols: 20% 14% 62% 4%;">',
    `<div class="sleep-track" role="img" aria-label="Pre-stack average sleep stages: REM ${mix.w1.rem} percent, Deep ${mix.w1.deep} percent, Light ${mix.w1.light} percent, Awake ${mix.w1.awake} percent" style="--sleep-mix-cols: ${mix.w1.rem}% ${mix.w1.deep}% ${mix.w1.light}% ${mix.w1.awake}%;">`,
    "sleep-mix: pre-stack track"
  );
  replaceOnce(
    '<div class="sleep-track" role="img" aria-label="Week 4 average sleep stages: REM 16 percent, Deep 12 percent, Light 64 percent, Awake 8 percent" style="--sleep-mix-cols: 16% 12% 64% 8%;">',
    `<div class="sleep-track" role="img" aria-label="Last 7 nights average sleep stages: REM ${mix.w4.rem} percent, Deep ${mix.w4.deep} percent, Light ${mix.w4.light} percent, Awake ${mix.w4.awake} percent" style="--sleep-mix-cols: ${mix.w4.rem}% ${mix.w4.deep}% ${mix.w4.light}% ${mix.w4.awake}%;">`,
    "sleep-mix: last-7 track"
  );
  replaceOnce(
    `<div class="sleep-row__label">Week 1</div>`,
    `<div class="sleep-row__label">Pre-stack</div>`,
    "sleep-mix: row label pre"
  );
  replaceOnce(
    `<div class="sleep-row__label">Week 4</div>`,
    `<div class="sleep-row__label">Last 7 days</div>`,
    "sleep-mix: row label last"
  );
  replaceOnce(
    `                  <div class="sleep-legend__head">Week 1</div>
                  <div class="sleep-legend__head">Week 4</div>`,
    `                  <div class="sleep-legend__head">Pre-stack</div>
                  <div class="sleep-legend__head">Last 7 days</div>`,
    "sleep-mix: legend column heads"
  );

  // Sleep-architecture legend cells (lines ~3027–3041)
  const legendStages = [
    { label: "REM", swatch: "#c084fc", w1: mix.w1.rem, w4: mix.w4.rem },
    { label: "Deep", swatch: "#818cf8", w1: mix.w1.deep, w4: mix.w4.deep },
    { label: "Light", swatch: "#93c5fd", w1: mix.w1.light, w4: mix.w4.light },
    { label: "Awake", swatch: "#475569", w1: mix.w1.awake, w4: mix.w4.awake },
  ];
  for (const s of legendStages) {
    const re = new RegExp(
      `(<div class="sleep-legend__stage"><span class="sleep-legend__swatch" style="background:${s.swatch};"></span>${s.label}</div>\\s*\\n\\s*<div class="sleep-legend__value mono">)[^<]+(</div>\\s*\\n\\s*<div class="sleep-legend__value mono">)[^<]+(</div>)`,
      "m"
    );
    replaceRegex(
      re,
      (_full, a, b, c) => `${a}${s.w1}%${b}${s.w4}%${c}`,
      `sleep-mix: legend ${s.label}`
    );
  }

  // Composite header orbs: all pre-supplement nights vs last 7 nights of this extraction
  const nDays = ctx.days.length;
  const { w1Lo: compositeW1Lo, w1Hi: compositeW1Hi, w4Lo: compositeW4Lo, w4Hi: compositeW4Hi } =
    computeCompositeWindowDays(ctx);
  replaceOnce(
    `      /** Populated by script: pre-stack = extract days 1..hinge (all nights before supplement); recent = last 7 extract days. */
      var COMPOSITE_W1_LO = 21;
      var COMPOSITE_W1_HI = 27;
      var COMPOSITE_W4_LO = 44;
      var COMPOSITE_W4_HI = 50;`,
    `      /** Pre-stack = extract days 1..hinge; recent = last 7 extract days. */
      var COMPOSITE_W1_LO = ${compositeW1Lo};
      var COMPOSITE_W1_HI = ${compositeW1Hi};
      var COMPOSITE_W4_LO = ${compositeW4Lo};
      var COMPOSITE_W4_HI = ${compositeW4Hi};`,
    "script: COMPOSITE_W* day windows"
  );

  const compositeScores = computeCompositeScores(
    series,
    compositeW1Lo,
    compositeW1Hi,
    compositeW4Lo,
    compositeW4Hi
  );
  const compS1 = compositeScores.s1;
  const compS4 = compositeScores.s4;

  if (compS1 == null || compS4 == null) {
    replaceOnce(
      '<div class="score-compare card header-score-compare" aria-labelledby="header-composite-score-label">',
      `<div ${HIDE} class="score-compare card header-score-compare" aria-labelledby="header-composite-score-label">`,
      "hide: composite score (Nutricode v3 needs ≥3 metrics per window)"
    );
  } else {
    replaceOnce(
      "      var COMPOSITE_WEEK1_SCORE_OVERRIDE = 71;",
      "      var COMPOSITE_WEEK1_SCORE_OVERRIDE = null;",
      "script: composite week1 override off (computed)"
    );
    replaceOnce(
      "      var COMPOSITE_WEEK4_SCORE_OVERRIDE = 75;",
      "      var COMPOSITE_WEEK4_SCORE_OVERRIDE = null;",
      "script: composite week4 override off (computed)"
    );
    replaceOnce(
      '<div class="score-orb" id="score-orb-week1" style="--score: 71; --accent: var(--green-accent);">',
      `<div class="score-orb" id="score-orb-week1" style="--score: ${compS1}; --accent: var(--green-accent);">`,
      "composite orb: week 1 --score"
    );
    replaceOnce(
      '<div class="score-orb__value mono" id="score-orb-week1-value">71</div>',
      `<div class="score-orb__value mono" id="score-orb-week1-value">${compS1}</div>`,
      "composite orb: week 1 value"
    );
    replaceOnce(
      '<div class="score-orb" id="score-orb-week4" style="--score: 75; --accent: var(--green-accent);">',
      `<div class="score-orb" id="score-orb-week4" style="--score: ${compS4}; --accent: var(--green-accent);">`,
      "composite orb: week 4 --score"
    );
    replaceOnce(
      '<div class="score-orb__value mono" id="score-orb-week4-value">75</div>',
      `<div class="score-orb__value mono" id="score-orb-week4-value">${compS4}</div>`,
      "composite orb: week 4 value"
    );
    const deltaDown = compS4 - compS1 < 0;
    const deltaLine = formatCompositeDeltaPoints(compS1, compS4);
    replaceOnce(
      `          <div class="score-delta" id="score-delta-box" aria-hidden="true">
            <div class="score-delta__value" id="score-delta-value">+4 points</div>`,
      `          <div class="score-delta${deltaDown ? " score-delta--down" : ""}" id="score-delta-box" aria-hidden="true">
            <div class="score-delta__value" id="score-delta-value">${deltaLine}</div>`,
      "composite delta: points line"
    );
  }

  const recoveryPayload = buildRecoveryCardPayload(ctx);
  const BODY_BATTERY_CARD_TEMPLATE = `      <div class="metric-card metric-card--up metric-card--line card" aria-labelledby="garmin-body-battery-heading">
        <div class="metric-card-line__main">
          <div class="metric-card-line__lead">
            <div class="metric-card-line__title-row">
              <span class="pill pill--up">Improved</span>
              <h3 class="metric-card__name" id="garmin-body-battery-heading">Garmin Body Battery <span class="metric-card-line__paren">Recovery Score</span></h3>
            </div>
          </div>

          <div class="metric-card-line__compare" role="group" aria-label="Recovery score week 1 and week 4">
            <div class="metric-card-line__node">
              <span class="metric-card-line__node-label">Week 1</span>
              <div class="metric-card-line__node-value">
                <span class="mono">69</span><span class="metric-card-line__node-suffix">/100</span>
              </div>
            </div>
            <div class="metric-card-line__bridge" aria-hidden="true">
              <span class="metric-card-line__bridge-line"></span>
              <svg class="metric-card-line__bridge-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 12h12m0 0l-4.5-4.5M17 12l-4.5 4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="metric-card-line__node metric-card-line__node--now">
              <span class="metric-card-line__node-label">Week 4</span>
              <div class="metric-card-line__node-value">
                <span class="mono">73</span><span class="metric-card-line__node-suffix">/100</span>
              </div>
            </div>
          </div>

          <div class="metric-card-line__delta-col">
            <span class="metric-card__delta metric-card-line__delta-pill is-up">+6%</span>
            <span class="metric-card-line__delta-cap">vs baseline</span>
          </div>
        </div>
      </div>`;

  if (recoveryPayload) {
    const matrixBlock = buildExpectedSupportMatrixHtml(metricsResearch, stackKeys);
    replaceOnce(
      BODY_BATTERY_CARD_TEMPLATE,
      `${renderRecoveryMetricCard(recoveryPayload, ctx.meta.device)}\n\n${matrixBlock}`,
      "recovery card + expected support matrix"
    );
  } else {
    replaceOnce(
      '<div class="metric-card metric-card--up metric-card--line card" aria-labelledby="garmin-body-battery-heading">',
      `<div ${HIDE} class="metric-card metric-card--up metric-card--line card" aria-labelledby="garmin-body-battery-heading">`,
      "hide: Garmin Body Battery card"
    );
  }
  replaceOnce(
    '<section class="page-section" aria-labelledby="supplement-alignment-heading">',
    `<section ${HIDE} class="page-section" aria-labelledby="supplement-alignment-heading">`,
    "hide: observed impact + supplement cards section"
  );
  replaceOnce(
    '<section class="page-section" aria-labelledby="next-stack-heading">',
    `<section ${HIDE} class="page-section" aria-labelledby="next-stack-heading">`,
    "hide: month-2 + bottom line section"
  );

  // Piecewise hinge at last day before supplement start (see computeHingeBreakDay).
  replaceOnce(
    "var HINGE_BREAK_DAY = 26;",
    `var HINGE_BREAK_DAY = ${ctx.hingeBreakDay};`,
    "script: HINGE_BREAK_DAY"
  );
  replaceOnce(
    "var xSpanFromData = !!cfg.xSpanFromData && n > 0;",
    "var xSpanFromData = (cfg.xSpanFromData == null ? true : !!cfg.xSpanFromData) && n > 0;",
    "script: xSpanFromData default"
  );
  replaceOnce(
    `var BIO_COHORT_BAND = "26-35";`,
    `var BIO_COHORT_BAND = "${cohortBand}";`,
    "script: BIO_COHORT_BAND"
  );

  // Replace each *_POINTS array (one-liner per array in the template).
  for (const name of Object.keys(series)) {
    const re = new RegExp(`var ${name} = \\[[\\s\\S]*?\\];`);
    replaceRegex(re, `var ${name} = ${JSON.stringify(series[name])};`, `series: ${name}`);
  }

  return state.html;
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataPath = path.resolve(args.data);
  const templatePath = path.resolve(args.template);
  const outPath = path.resolve(args.out);

  const raw = fs.readFileSync(dataPath, "utf8");
  const extraction = JSON.parse(raw);
  const tpl = fs.readFileSync(templatePath, "utf8");

  const ctx = buildContext(extraction);
  const series = buildSeries(ctx.days);
  const nMix = ctx.days.length;
  const hMix = ctx.hingeBreakDay;
  const mix = {
    w1: hMix >= 1 ? computeMixForDayRange(ctx.days, 1, hMix) : { rem: 0, deep: 0, light: 0, awake: 0 },
    w4: computeMixForDayRange(ctx.days, Math.max(1, nMix - 6), nMix),
  };

  let metricsResearch = {};
  const researchPath = path.resolve(path.dirname(templatePath), METRICS_RESEARCH_FILENAME);
  try {
    metricsResearch = JSON.parse(fs.readFileSync(researchPath, "utf8"));
  } catch (e) {
    console.warn(`Could not load ${researchPath}: ${e.message} (expected support matrix will use "Not targeted")`);
  }

  const out = applyEdits(tpl, ctx, series, mix, metricsResearch);
  fs.writeFileSync(outPath, out, "utf8");

  const recoveryLog = buildRecoveryCardPayload(ctx);
  const win = computeCompositeWindowDays(ctx);
  console.log(`Wrote ${outPath}`);
  console.log(`  Days:           ${ctx.days.length}`);
  console.log(`  Hinge break day: ${ctx.hingeBreakDay} (last day before ${ctx.supplementStartIso})`);
  console.log(`  Date range:     ${ctx.dateRange.start} to ${ctx.dateRange.end}`);
  console.log(`  Training days:  ${ctx.trainingDays}`);
  console.log(`  Activity hours: ${ctx.totalActivityHours.toFixed(1)}`);
  console.log(`  Cohort band:    ${ageBand(ctx.info.age)} (${capFirst(ctx.info.gender)}, age ${ctx.info.age})`);
  console.log(
    `  Pre-stack mix:  REM ${mix.w1.rem}% / Deep ${mix.w1.deep}% / Light ${mix.w1.light}% / Awake ${mix.w1.awake}%`
  );
  console.log(
    `  Last-7 mix:     REM ${mix.w4.rem}% / Deep ${mix.w4.deep}% / Light ${mix.w4.light}% / Awake ${mix.w4.awake}%`
  );
  const compLog = computeCompositeScores(series, win.w1Lo, win.w1Hi, win.w4Lo, win.w4Hi);
  if (compLog.s1 != null && compLog.s4 != null) {
    console.log(
      `  Composite:      ${compLog.s1} → ${compLog.s4} (${formatCompositeDeltaPoints(
        compLog.s1,
        compLog.s4
      )})  [pre-stack days ${win.w1Lo}–${win.w1Hi} vs last-7 days ${win.w4Lo}–${win.w4Hi}]`
    );
  } else {
    console.log(
      `  Composite:      (hidden — need pre-stack window (days 1–hinge) and last-7 window, each with ≥3 scored metrics)`
    );
  }
  if (recoveryLog) {
    console.log(
      `  Recovery card:  pre-stack avg ${recoveryLog.r1} → last-7 avg ${recoveryLog.r4} (${recoveryLog.deltaStr} vs pre-stack)  [days ${win.w1Lo}–${win.w1Hi} vs ${win.w4Lo}–${win.w4Hi}]`
    );
  }
}

main();
