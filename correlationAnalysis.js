/**
 * Nutricode — Full Metric Correlation Analysis
 * Covers: HRV, RHR, TotalSleep, SleepEfficiency, Disruptions,
 *         REM, DeepSleep, LightSleep, Awake
 *
 * Output shape: { [targetMetric]: [ { label, r, n, direction, threshold, supplements, significant }, ... ] }
 * — curated pairs only; rolling 7d vs intensity 7d is inserted after `rollingAfterIndex` (see METRIC_CONFIGS).
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — DATA EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function getSeries(sourceDict) {
  const result = {};
  for (const [key, value] of Object.entries(sourceDict)) {
    if (value !== null && value !== undefined) {
      result[parseInt(key, 10)] = value;
    }
  }
  return result;
}

function getActivitySeries(activityDict, subkey) {
  const result = {};
  for (const [key, obj] of Object.entries(activityDict)) {
    if (obj && obj[subkey] !== null && obj[subkey] !== undefined) {
      result[parseInt(key, 10)] = obj[subkey];
    }
  }
  return result;
}

function extractAllSeries(rawData) {
  const metrics = rawData
    .connect_device_recommendation
    .metric_analysis
    .visualization
    .metrics;

  const dailyActivity = rawData
    .connect_device_recommendation
    .metric_analysis
    .visualization
    .daily_activity;

  return {
    hrv:         getSeries(metrics["HRV"]),
    rhr:         getSeries(metrics["RHR"]),
    deepSleep:   getSeries(metrics["deep_sleep"]),
    remSleep:    getSeries(metrics["rem_sleep"]),
    disruptions: getSeries(metrics["disturbances"]),
    totalSleep:  getSeries(metrics["sleep_time"]),
    sleepEff:    getSeries(metrics["sleep_efficiency"]),
    awake:       getSeries(metrics["awake_time"]),
    lightSleep:  getSeries(metrics["light_sleep"]),
    intensity:   getActivitySeries(dailyActivity, "average_intensity"),
    trimp:       getActivitySeries(dailyActivity, "total_duration"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — SERIES TRANSFORMATIONS
// ─────────────────────────────────────────────────────────────────────────────

function lagSeries(seriesDict, lag) {
  const result = {};
  for (const [day, value] of Object.entries(seriesDict)) {
    result[parseInt(day, 10) + lag] = value;
  }
  return result;
}

function rollingMean(seriesDict, window = 7, minValues = 4) {
  const result = {};
  const sortedDays = Object.keys(seriesDict).map(Number).sort((a, b) => a - b);

  for (let i = 0; i < sortedDays.length; i++) {
    const currentDay = sortedDays[i];
    const windowValues = [];
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const d = sortedDays[j];
      if (seriesDict[d] !== undefined) windowValues.push(seriesDict[d]);
    }
    if (windowValues.length >= minValues) {
      result[currentDay] = windowValues.reduce((a, v) => a + v, 0) / windowValues.length;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — PEARSON CORRELATION
// ─────────────────────────────────────────────────────────────────────────────

function computePearsonR(xDict, yDict) {
  const xKeys = new Set(Object.keys(xDict).map(Number));
  const yKeys = new Set(Object.keys(yDict).map(Number));
  const sharedDays = [...xKeys].filter(k => yKeys.has(k)).sort((a, b) => a - b);
  const n = sharedDays.length;

  if (n < 5) return { r: null, n };

  const x = sharedDays.map(d => xDict[d]);
  const y = sharedDays.map(d => yDict[d]);

  const meanX = x.reduce((a, v) => a + v, 0) / n;
  const meanY = y.reduce((a, v) => a + v, 0) / n;

  let numerator = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX    += dx * dx;
    denomY    += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  if (denominator === 0) return { r: null, n };

  return { r: Math.round((numerator / denominator) * 1000) / 1000, n };
}

function autocorrelationLag1(seriesDict) {
  return computePearsonR(seriesDict, lagSeries(seriesDict, 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — METRIC CONFIGS (curated correlation pairs only)
// rollingAfterIndex: insert rolling 7d vs intensity 7d after this pair index (0-based)
// ─────────────────────────────────────────────────────────────────────────────

const METRIC_CONFIGS = [

  {
    label: "HRV", seriesKey: "hrv", rollingAfterIndex: 4,
    correlations: [
      { label: "HRV ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.40, supplements: ["workout_effort", "training_load", "strain"] },
      { label: "HRV ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.35, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
      { label: "HRV ~ DeepSleep", predictorFn: (s) => s.deepSleep, direction: "positive", threshold: 0.40, supplements: ["deep_sleep", "sleep_quality", "recovery"] },
      { label: "HRV ~ REM", predictorFn: (s) => s.remSleep, direction: "positive", threshold: 0.35, supplements: ["rem_sleep", "stress", "sleep_quality"] },
      { label: "HRV ~ TotalSleep", predictorFn: (s) => s.totalSleep, direction: "positive", threshold: 0.40, supplements: ["sleep_quality", "recovery", "deep_sleep"] },
      { label: "HRV ~ SleepEfficiency", predictorFn: (s) => s.sleepEff, direction: "positive", threshold: 0.35, supplements: ["sleep_quality", "sleep_disruptions", "sleep_latency"] },
      { label: "HRV ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.30, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "HRV rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.50, rollingSupplements: ["training_load", "strain", "recovery"],
    autocorrLabel: "HRV ~ HRV(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["hrv", "recovery", "stress"],
  },

  {
    label: "RHR", seriesKey: "rhr", rollingAfterIndex: 4,
    correlations: [
      { label: "RHR ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.40, supplements: ["workout_effort", "training_load", "strain"] },
      { label: "RHR ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "positive", threshold: 0.35, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
      { label: "RHR ~ DeepSleep", predictorFn: (s) => s.deepSleep, direction: "negative", threshold: -0.40, supplements: ["deep_sleep", "sleep_quality", "recovery"] },
      { label: "RHR ~ REM", predictorFn: (s) => s.remSleep, direction: "negative", threshold: -0.35, supplements: ["rem_sleep", "stress", "sleep_quality"] },
      { label: "RHR ~ TotalSleep", predictorFn: (s) => s.totalSleep, direction: "negative", threshold: -0.40, supplements: ["sleep_quality", "recovery", "deep_sleep"] },
      { label: "RHR ~ SleepEfficiency", predictorFn: (s) => s.sleepEff, direction: "negative", threshold: -0.35, supplements: ["sleep_quality", "sleep_disruptions", "sleep_latency"] },
      { label: "RHR ~ AwakePhase", predictorFn: (s) => s.awake, direction: "positive", threshold: 0.30, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "RHR rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.50, rollingSupplements: ["training_load", "strain", "recovery"],
    autocorrLabel: "RHR ~ RHR(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["rhr", "recovery", "stress"],
  },

  {
    label: "TotalSleep", seriesKey: "totalSleep", rollingAfterIndex: 3,
    correlations: [
      { label: "TotalSleep ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["workout_effort", "training_load", "sleep_quality"] },
      { label: "TotalSleep ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.40, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
      { label: "TotalSleep ~ SleepEfficiency", predictorFn: (s) => s.sleepEff, direction: "positive", threshold: 0.35, supplements: ["sleep_quality", "sleep_latency", "sleep_disruptions"] },
      { label: "TotalSleep ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.35, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "TotalSleep rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["training_load", "recovery", "strain"],
    autocorrLabel: "TotalSleep ~ TotalSleep(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["sleep_quality", "recovery", "stress"],
  },

  {
    label: "SleepEfficiency", seriesKey: "sleepEff", rollingAfterIndex: 2,
    correlations: [
      { label: "SleepEfficiency ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["workout_effort", "training_load", "sleep_quality"] },
      { label: "SleepEfficiency ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.50, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
      { label: "SleepEfficiency ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.45, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "SleepEfficiency rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["training_load", "recovery", "strain"],
    autocorrLabel: "SleepEfficiency ~ SleepEfficiency(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["sleep_quality", "recovery", "stress"],
  },

  {
    label: "Disruptions", seriesKey: "disruptions", rollingAfterIndex: 1,
    correlations: [
      { label: "Disruptions ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.35, supplements: ["workout_effort", "training_load", "sleep_quality"] },
      { label: "Disruptions ~ AwakePhase", predictorFn: (s) => s.awake, direction: "positive", threshold: 0.30, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "Disruptions rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.45, rollingSupplements: ["training_load", "recovery", "strain"],
    autocorrLabel: "Disruptions ~ Disruptions(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["sleep_disruptions", "recovery", "stress"],
  },

  {
    label: "REM", seriesKey: "remSleep", rollingAfterIndex: 4,
    correlations: [
      { label: "REM ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["workout_effort", "training_load", "stress"] },
      { label: "REM ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.40, supplements: ["sleep_disruptions", "sleep_quality", "stress"] },
      { label: "REM ~ TotalSleep", predictorFn: (s) => s.totalSleep, direction: "positive", threshold: 0.45, supplements: ["sleep_quality", "rem_sleep", "recovery"] },
      { label: "REM ~ SleepEfficiency", predictorFn: (s) => s.sleepEff, direction: "positive", threshold: 0.35, supplements: ["sleep_quality", "sleep_disruptions", "rem_sleep"] },
      { label: "REM ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.35, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "REM rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["training_load", "recovery", "stress"],
    autocorrLabel: "REM ~ REM(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["rem_sleep", "recovery", "stress"],
  },

  {
    label: "DeepSleep", seriesKey: "deepSleep", rollingAfterIndex: 4,
    correlations: [
      { label: "DeepSleep ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["workout_effort", "training_load", "recovery"] },
      { label: "DeepSleep ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.45, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
      { label: "DeepSleep ~ TotalSleep", predictorFn: (s) => s.totalSleep, direction: "positive", threshold: 0.40, supplements: ["sleep_quality", "deep_sleep", "recovery"] },
      { label: "DeepSleep ~ SleepEfficiency", predictorFn: (s) => s.sleepEff, direction: "positive", threshold: 0.40, supplements: ["sleep_quality", "sleep_disruptions", "deep_sleep"] },
      { label: "DeepSleep ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.35, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "DeepSleep rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["training_load", "recovery", "strain"],
    autocorrLabel: "DeepSleep ~ DeepSleep(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["deep_sleep", "recovery", "stress"],
  },

  {
    label: "LightSleep", seriesKey: "lightSleep", rollingAfterIndex: 3,
    correlations: [
      { label: "LightSleep ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.30, supplements: ["workout_effort", "training_load", "sleep_quality"] },
      { label: "LightSleep ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "positive", threshold: 0.40, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
      { label: "LightSleep ~ SleepEfficiency", predictorFn: (s) => s.sleepEff, direction: "negative", threshold: -0.40, supplements: ["sleep_quality", "sleep_disruptions", "sleep_latency"] },
      { label: "LightSleep ~ AwakePhase", predictorFn: (s) => s.awake, direction: "positive", threshold: 0.35, supplements: ["sleep_latency", "stress", "sleep_quality"] },
    ],
    rollingLabel: "LightSleep rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.40, rollingSupplements: ["training_load", "recovery", "strain"],
    autocorrLabel: "LightSleep ~ LightSleep(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["sleep_quality", "recovery", "stress"],
  },

  {
    label: "Awake", seriesKey: "awake", rollingAfterIndex: 1,
    correlations: [
      { label: "Awake ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.35, supplements: ["workout_effort", "training_load", "sleep_quality"] },
      { label: "Awake ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "positive", threshold: 0.50, supplements: ["sleep_disruptions", "sleep_quality", "deep_sleep"] },
    ],
    rollingLabel: "Awake rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.45, rollingSupplements: ["training_load", "recovery", "strain"],
    autocorrLabel: "Awake ~ Awake(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["sleep_quality", "recovery", "stress"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — SIGNIFICANCE CHECK
// ─────────────────────────────────────────────────────────────────────────────

function isSignificant(r, direction, threshold) {
  if (r === null) return false;
  if (direction === "negative") return r <= threshold;
  if (direction === "positive") return r >= threshold;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — MAIN ANALYSIS FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

function runCorrelationAnalysis(rawData) {
  const series = extractAllSeries(rawData);
  const derived = {
    intensityLag1:  lagSeries(series.intensity, 1),
    intensityRoll7: rollingMean(series.intensity, 7),
  };

  const output = {};

  for (const config of METRIC_CONFIGS) {
    const targetSeries = series[config.seriesKey];
    const targetRoll7  = rollingMean(targetSeries, 7);
    const allResults   = [];

    for (let i = 0; i < config.correlations.length; i++) {
      const corr = config.correlations[i];
      const predictorSeries = corr.predictorFn(series, derived);
      const { r, n }        = computePearsonR(targetSeries, predictorSeries);
      allResults.push({
        label: corr.label, r, n, direction: corr.direction, threshold: corr.threshold, supplements: corr.supplements,
        significant: isSignificant(r, corr.direction, corr.threshold),
      });

      if (config.rollingAfterIndex === i) {
        const { r: rRoll, n: nRoll } = computePearsonR(targetRoll7, derived.intensityRoll7);
        allResults.push({
          label: config.rollingLabel, r: rRoll, n: nRoll, direction: config.rollingDirection, threshold: config.rollingThreshold, supplements: config.rollingSupplements,
          significant: isSignificant(rRoll, config.rollingDirection, config.rollingThreshold),
        });
      }
    }

    const { r: rAuto, n: nAuto } = autocorrelationLag1(targetSeries);
    allResults.push({
      label: config.autocorrLabel, r: rAuto, n: nAuto, direction: config.autocorrDirection, threshold: config.autocorrThreshold, supplements: config.autocorrSupplements,
      significant: isSignificant(rAuto, config.autocorrDirection, config.autocorrThreshold),
    });

    output[config.label] = allResults;
  }

  return output;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== "undefined" && require.main === module) {
  const fs   = require("fs");
  const path = require("path");
  const filePath = process.argv[2];

  if (!filePath) { console.error("Usage: node correlationAnalysis.js <path_to_raw_data.json>"); process.exit(1); }

  const rawData = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  const results = runCorrelationAnalysis(rawData);

  for (const [metricLabel, rows] of Object.entries(results)) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TARGET: ${metricLabel}`);
    console.log("=".repeat(60));

    for (const row of rows) {
      if (row.r === null) continue;
      const sig = row.significant ? " ✓" : "  ";
      console.log(`  ${sig}  ${row.r.toFixed(3).padStart(7)}  (n=${String(row.n).padStart(2)})  ${row.label}`);
    }
  }

  const outPath = path.join(path.dirname(path.resolve(filePath)), "correlation_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nJSON written to: ${outPath}`);
}

if (typeof module !== "undefined") {
  module.exports = { runCorrelationAnalysis, computePearsonR, lagSeries, rollingMean, autocorrelationLag1, getSeries, getActivitySeries, extractAllSeries, isSignificant, METRIC_CONFIGS };
}
