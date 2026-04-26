/**
 * Nutricode — Metric correlation analysis + insight cards
 * Card copy loaded from correlation_cards - correlation_cards-2.csv (default).
 */

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
    if (!obj || typeof obj !== 'object') continue;
    const totals = obj.total != null && typeof obj.total === 'object' ? obj.total : obj;
    if (totals[subkey] !== null && totals[subkey] !== undefined) {
      result[parseInt(key, 10)] = totals[subkey];
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
    awake:       getSeries(metrics["awake_time"]),
    lightSleep:  getSeries(metrics["light_sleep"]),
    intensity:   getActivitySeries(dailyActivity, "average_intensity"),
    trimp:       getActivitySeries(dailyActivity, "total_duration"),
  };
}

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

function percentileLinear(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function bracketStats(predictorDict, outcomeDict, tail) {
  const pKeys = new Set(Object.keys(predictorDict).map(Number));
  const oKeys = new Set(Object.keys(outcomeDict).map(Number));
  const days = [...pKeys].filter(k => oKeys.has(k)).sort((a, b) => a - b);
  const a = days.map(d => predictorDict[d]);
  const b = days.map(d => outcomeDict[d]);
  const n = days.length;
  if (n < 5) return { xRaw: null, yRaw: null, nBracket: 0, n };

  const sorted = [...a].sort((u, v) => u - v);
  const p = tail === "low" ? 0.25 : 0.75;
  const threshold = percentileLinear(sorted, p);
  const mask = tail === "low"
    ? a.map(v => v <= threshold)
    : a.map(v => v >= threshold);
  const yVals = b.filter((_, i) => mask[i]);
  if (yVals.length === 0) return { xRaw: threshold, yRaw: null, nBracket: 0, n };

  const yMean = yVals.reduce((s, v) => s + v, 0) / yVals.length;
  return { xRaw: threshold, yRaw: yMean, nBracket: yVals.length, n };
}

function inferPredictorTailFromCopy(copy) {
  if (!copy) return "high";
  const head = copy.includes(", your ")
    ? copy.split(", your ")[0]
    : (copy.includes(", it ") ? copy.split(", it ")[0] : copy);
  if (/dropped below\s*\[X\]/i.test(head) || /below\s*\[X\]\s*min/i.test(head)) return "low";
  return "high";
}

/** supplements / *Supplements: single tag from correlation_cards CSV column metric_1 (per row key). */
const METRIC_CONFIGS = [

  {
    label: "HRV", seriesKey: "hrv", rollingAfterIndex: 3,
    correlations: [
      { label: "HRV ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.40, supplements: ["recovery"] },
      { label: "HRV ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.35, supplements: ["sleep_disruptions"] },
      { label: "HRV ~ DeepSleep", predictorFn: (s) => s.deepSleep, direction: "positive", threshold: 0.40, supplements: ["deep_sleep"] },
      { label: "HRV ~ REM", predictorFn: (s) => s.remSleep, direction: "positive", threshold: 0.35, supplements: ["rem_sleep"] },
      { label: "HRV ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.30, supplements: ["sleep_quality"] },
    ],
    rollingLabel: "HRV rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.50, rollingSupplements: ["recovery"],
    autocorrLabel: "HRV ~ HRV(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["hrv"],
  },

  {
    label: "RHR", seriesKey: "rhr", rollingAfterIndex: 3,
    correlations: [
      { label: "RHR ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.40, supplements: ["recovery"] },
      { label: "RHR ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "positive", threshold: 0.35, supplements: ["sleep_disruptions"] },
      { label: "RHR ~ DeepSleep", predictorFn: (s) => s.deepSleep, direction: "negative", threshold: -0.40, supplements: ["deep_sleep"] },
      { label: "RHR ~ REM", predictorFn: (s) => s.remSleep, direction: "negative", threshold: -0.35, supplements: ["rem_sleep"] },
      { label: "RHR ~ AwakePhase", predictorFn: (s) => s.awake, direction: "positive", threshold: 0.30, supplements: ["sleep_quality"] },
    ],
    rollingLabel: "RHR rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.50, rollingSupplements: ["recovery"],
    autocorrLabel: "RHR ~ RHR(t-1)",
    autocorrDirection: "positive", autocorrThreshold: 0.60, autocorrSupplements: ["rhr"],
  },

  {
    label: "TotalSleep", seriesKey: "totalSleep", rollingAfterIndex: 2,
    correlations: [
      { label: "TotalSleep ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["sleep_quality"] },
      { label: "TotalSleep ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.40, supplements: ["sleep_disruptions"] },
      { label: "TotalSleep ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.35, supplements: ["sleep_quality"] },
    ],
    rollingLabel: "TotalSleep rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["sleep_quality"],
  },

  {
    label: "Disruptions", seriesKey: "disruptions", rollingAfterIndex: 0,
    correlations: [
      { label: "Disruptions ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.35, supplements: ["sleep_disruptions"] },
    ],
    rollingLabel: "Disruptions rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.45, rollingSupplements: ["sleep_disruptions"],
  },

  {
    label: "REM", seriesKey: "remSleep", rollingAfterIndex: 2,
    correlations: [
      { label: "REM ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["recovery"] },
      { label: "REM ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.40, supplements: ["sleep_disruptions"] },
      { label: "REM ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.35, supplements: ["sleep_quality"] },
    ],
    rollingLabel: "REM rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["rem_sleep"],
  },

  {
    label: "DeepSleep", seriesKey: "deepSleep", rollingAfterIndex: 2,
    correlations: [
      { label: "DeepSleep ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "negative", threshold: -0.35, supplements: ["recovery"] },
      { label: "DeepSleep ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "negative", threshold: -0.45, supplements: ["sleep_disruptions"] },
      { label: "DeepSleep ~ AwakePhase", predictorFn: (s) => s.awake, direction: "negative", threshold: -0.35, supplements: ["sleep_quality"] },
    ],
    rollingLabel: "DeepSleep rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "negative", rollingThreshold: -0.45, rollingSupplements: ["deep_sleep"],
  },

  {
    label: "LightSleep", seriesKey: "lightSleep", rollingAfterIndex: 2,
    correlations: [
      { label: "LightSleep ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.30, supplements: ["recovery"] },
      { label: "LightSleep ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "positive", threshold: 0.40, supplements: ["sleep_disruptions"] },
      { label: "LightSleep ~ AwakePhase", predictorFn: (s) => s.awake, direction: "positive", threshold: 0.35, supplements: ["sleep_quality"] },
    ],
    rollingLabel: "LightSleep rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.40, rollingSupplements: ["sleep_quality"],
  },

  {
    label: "Awake", seriesKey: "awake", rollingAfterIndex: 1,
    correlations: [
      { label: "Awake ~ Training Intensity(t-1)", predictorFn: (s, d) => d.intensityLag1, direction: "positive", threshold: 0.35, supplements: ["recovery"] },
      { label: "Awake ~ Disruptions", predictorFn: (s) => s.disruptions, direction: "positive", threshold: 0.50, supplements: ["sleep_disruptions"] },
    ],
    rollingLabel: "Awake rolling mean ~ Training Intensity rolling mean",
    rollingDirection: "positive", rollingThreshold: 0.45, rollingSupplements: ["sleep_quality"],
  },
];

function isSignificant(r, direction, threshold) {
  if (r === null) return false;
  if (direction === "negative") return r <= threshold;
  if (direction === "positive") return r >= threshold;
  return false;
}

function labelToCsvKey(label) {
  const parts = label.split(" ~ ").map(s => s.trim());
  if (parts.length !== 2) return null;
  const [L, R] = parts;

  const main = L.includes("rolling mean")
    ? `${L.replace(/\s+rolling mean$/, "")} rolling mean (7-day)`
    : `${L}(t)`;

  let corr = R;
  if (R === "Disruptions") corr = "Disruptions(t)";
  else if (R === "AwakePhase") corr = "AwakePhase(t)";
  else if (R === "DeepSleep") corr = "DeepSleep(t)";
  else if (R === "REM") corr = "REM(t)";
  else if (R === "Training Intensity rolling mean") corr = "Training Intensity rolling mean (7-day)";

  return `${main}|${corr}`;
}

function predictorFormatKind(rSide) {
  if (rSide.includes("Training Intensity")) return "intensity";
  if (rSide.includes("Disruptions")) return "disruptions";
  if (rSide.includes("DeepSleep") || rSide.includes("REM")) return "sleep_segment_minutes";
  if (rSide.includes("AwakePhase")) return "awake_minutes";
  if (rSide.includes("HRV(t-1)")) return "hrv_ms";
  if (rSide.includes("RHR(t-1)")) return "rhr_bpm";
  return "raw";
}

function outcomeFormatKind(lSide) {
  const base = lSide.replace(/\s+rolling mean$/, "");
  if (base === "HRV") return "hrv_ms";
  if (base === "RHR") return "rhr_bpm";
  if (["TotalSleep", "REM", "DeepSleep", "LightSleep", "Awake"].includes(base)) return "hours_from_sec";
  if (base === "Disruptions") return "disruptions";
  return "raw";
}

function formatByKind(kind, raw) {
  if (raw === null || raw === undefined || Number.isNaN(raw)) return "—";
  switch (kind) {
    case "intensity": return Number(raw).toFixed(2);
    case "disruptions": return Number(raw).toFixed(1);
    case "sleep_segment_minutes": return String(Math.round(Number(raw) / 60));
    case "awake_minutes": return String(Math.round(Number(raw) / 60));
    case "hrv_ms": return String(Math.round(Number(raw)));
    case "rhr_bpm": return String(Math.round(Number(raw)));
    case "hours_from_sec": return (Number(raw) / 3600).toFixed(1);
    default: return String(Math.round(Number(raw) * 100) / 100);
  }
}

/** Unit text that follows [X] or [Y] in card copy (after optional spaces). Longest match wins. */
function suffixesForFormatKind(kind) {
  switch (kind) {
    case "intensity": return [];
    case "disruptions": return ["per hour"];
    case "sleep_segment_minutes": return ["min"];
    case "awake_minutes": return ["minutes", "min"];
    case "hrv_ms": return ["ms"];
    case "rhr_bpm": return ["bpm"];
    case "hours_from_sec": return ["hours"];
    default: return [];
  }
}

function formatKindsFromAnalysisLabel(analysisLabel) {
  const parts = (analysisLabel || "").split(" ~ ").map(s => s.trim());
  const L = parts[0] || "";
  const R = parts[1] || "";
  return {
    xKind: R ? predictorFormatKind(R) : "raw",
    yKind: L ? outcomeFormatKind(L) : "raw",
  };
}

function extendRangeWithOptionalUnit(body, range, suffixes) {
  const { start, end } = range;
  if (!suffixes.length) return range;
  let j = end;
  while (j < body.length && /\s/.test(body[j])) j++;
  const tail = body.slice(j);
  const tailLower = tail.toLowerCase();
  const ordered = [...suffixes].sort((a, b) => b.length - a.length);
  for (const suf of ordered) {
    const sl = suf.toLowerCase();
    if (tailLower.startsWith(sl)) return { start, end: j + suf.length };
  }
  return range;
}

function findValueOccurrencesWithUnits(body, valueStr, suffixes) {
  const base = findAllOccurrencesExact(body, valueStr);
  return base.map(r => extendRangeWithOptionalUnit(body, r, suffixes));
}

function formatXYForLabel(analysisLabel, xRaw, yRaw) {
  const [L, R] = analysisLabel.split(" ~ ").map(s => s.trim());
  const xStr = formatByKind(predictorFormatKind(R), xRaw);
  const yStr = formatByKind(outcomeFormatKind(L), yRaw);
  return { xStr, yStr };
}

function interpolateCardText(text, xStr, yStr) {
  if (!text) return "";
  let s = text;
  if (s.includes("[X]")) s = s.split("[X]").join(xStr);
  if (s.includes("[Y]")) s = s.split("[Y]").join(yStr);
  return s;
}

function parseCorrelationCardsCsv(content) {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < content.length) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      if (row.some(cell => String(cell).trim() !== "")) rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some(cell => String(cell).trim() !== "")) rows.push(row);
  }

  if (rows.length < 2) return new Map();
  const header = rows[0].map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const iMain = idx("Main metric");
  const iCorr = idx("Correlation metric");
  const iTitle = idx("title");
  const iCopy = idx("copy");
  const iHow = idx("how_it_works");
  const iMetric1 = idx("metric_1");
  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length < 5) continue;
    const key = `${cells[iMain].trim()}|${cells[iCorr].trim()}`;
    map.set(key, {
      mainMetric: cells[iMain].trim(),
      correlationMetric: cells[iCorr].trim(),
      title: cells[iTitle] ?? "",
      copy: (cells[iCopy] ?? "").replace(/\r\n/g, "\n").trim(),
      how_it_works: (cells[iHow] ?? "").replace(/\r\n/g, "\n").trim(),
      metric_1: iMetric1 >= 0 && cells[iMetric1] ? cells[iMetric1].trim() : "",
    });
  }
  return map;
}

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

    if (config.autocorrLabel) {
    const { r: rAuto, n: nAuto } = autocorrelationLag1(targetSeries);
    allResults.push({
      label: config.autocorrLabel, r: rAuto, n: nAuto, direction: config.autocorrDirection, threshold: config.autocorrThreshold, supplements: config.autocorrSupplements,
      significant: isSignificant(rAuto, config.autocorrDirection, config.autocorrThreshold),
    });
    }

    output[config.label] = allResults;
  }

  return output;
}

function buildResolvedCorrelationRows(rawData, cardMap) {
  const series = extractAllSeries(rawData);
  const derived = {
    intensityLag1:  lagSeries(series.intensity, 1),
    intensityRoll7: rollingMean(series.intensity, 7),
  };

  const flat = [];

  function pushRow(meta) {
    const {
      label, r, n, direction, threshold, supplements, significant,
      predictorDict, outcomeDict,
    } = meta;
    if (r === null) return;

    const csvKey = labelToCsvKey(label);
    const card = csvKey ? cardMap.get(csvKey) : null;
    const tail = card ? inferPredictorTailFromCopy(card.copy) : "high";
    const { xRaw, yRaw, nBracket } = bracketStats(predictorDict, outcomeDict, tail);
    const { xStr, yStr } = formatXYForLabel(label, xRaw, yRaw);

    const title = card ? card.title : label;
    const body = card ? interpolateCardText(card.copy, xStr, yStr) : "";
    const how = card ? interpolateCardText(card.how_it_works, xStr, yStr) : "";

    const marginScore = Math.abs(r) - Math.abs(threshold);

    flat.push({
      label,
      targetMetric: meta.targetMetric,
      r,
      n,
      nBracket,
      direction,
      threshold,
      supplements,
      significant,
      marginScore,
      title,
      body,
      how_it_works: how,
      xRaw,
      yRaw,
      xStr,
      yStr,
      csvKey,
    });
  }

  for (const config of METRIC_CONFIGS) {
    const targetSeries = series[config.seriesKey];
    const targetRoll7  = rollingMean(targetSeries, 7);

    for (let i = 0; i < config.correlations.length; i++) {
      const corr = config.correlations[i];
      const predictorSeries = corr.predictorFn(series, derived);
      const { r, n } = computePearsonR(targetSeries, predictorSeries);
      pushRow({
        label: corr.label,
        r, n,
        direction: corr.direction,
        threshold: corr.threshold,
        supplements: corr.supplements,
        significant: isSignificant(r, corr.direction, corr.threshold),
        predictorDict: predictorSeries,
        outcomeDict: targetSeries,
        targetMetric: config.label,
      });

      if (config.rollingAfterIndex === i) {
        const { r: rRoll, n: nRoll } = computePearsonR(targetRoll7, derived.intensityRoll7);
        pushRow({
          label: config.rollingLabel,
          r: rRoll,
          n: nRoll,
          direction: config.rollingDirection,
          threshold: config.rollingThreshold,
          supplements: config.rollingSupplements,
          significant: isSignificant(rRoll, config.rollingDirection, config.rollingThreshold),
          predictorDict: derived.intensityRoll7,
          outcomeDict: targetRoll7,
          targetMetric: config.label,
        });
      }
    }

    if (config.autocorrLabel) {
      const lag1 = lagSeries(targetSeries, 1);
      const { r: rAuto, n: nAuto } = computePearsonR(targetSeries, lag1);
      pushRow({
        label: config.autocorrLabel,
        r: rAuto,
        n: nAuto,
        direction: config.autocorrDirection,
        threshold: config.autocorrThreshold,
        supplements: config.autocorrSupplements,
        significant: isSignificant(rAuto, config.autocorrDirection, config.autocorrThreshold),
        predictorDict: lag1,
        outcomeDict: targetSeries,
        targetMetric: config.label,
      });
    }
  }

  flat.sort((a, b) => b.marginScore - a.marginScore);
  return flat;
}

/**
 * Canonical key for one side of "METRIC_A ~ METRIC_B" so daily vs 7-day rolling
 * and (t)/(t-1) variants dedupe together.
 */
function normalizeMetricSide(side) {
  let s = String(side || "").trim();
  if (!s) return "";
  s = s.replace(/\s+rolling mean\s*$/i, "");
  s = s.replace(/\s*\(t-1\)\s*$/i, "");
  s = s.replace(/\s*\(t\)\s*$/i, "");
  s = s.replace(/\s*\(7-day\)\s*$/i, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.toLowerCase();
}

function parseLabelMetricKeys(label) {
  const parts = (label || "").split(" ~ ").map(x => x.trim());
  if (parts.length !== 2) return { metricAKey: "", metricBKey: "" };
  return {
    metricAKey: normalizeMetricSide(parts[0]),
    metricBKey: normalizeMetricSide(parts[1]),
  };
}

/**
 * Intervention tag from row (CSV metric_1 → supplements[0]): lever for METRIC_A.
 */
function interventionKeyFromRow(row) {
  const s = row && row.supplements;
  if (!Array.isArray(s) || s.length === 0) return "";
  return String(s[0]).trim().toLowerCase();
}

/** Human-readable label for focus card (e.g. sleep_quality → Sleep quality). */
function formatInterventionForDisplay(supplements) {
  const raw = Array.isArray(supplements) && supplements[0] != null ? String(supplements[0]).trim() : "";
  if (!raw) return "—";
  return raw
    .split("_")
    .map(w => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * Greedy top-k: walk sorted-by-marginScore list, skip rows whose METRIC_A or METRIC_B
 * key was already used by an earlier pick (normalized: same outcome/predictor family).
 * Pass rows pre-filtered (e.g. significant-only) if you only want those in the UI.
 */
function pickDiverseTopCorrelations(sortedRows, limit = 3) {
  const usedA = new Set();
  const usedB = new Set();
  const out = [];
  for (const row of sortedRows) {
    if (out.length >= limit) break;
    const { metricAKey, metricBKey } = parseLabelMetricKeys(row.label);
    if (!metricAKey || !metricBKey) continue;
    if (usedA.has(metricAKey) || usedB.has(metricBKey)) continue;
    usedA.add(metricAKey);
    usedB.add(metricBKey);
    out.push(row);
  }
  return out;
}

/** True when this row is a 7-day rolling correlation (label like "… rolling mean ~ …"). */
function rowUsesSevenDayRolling(row) {
  return /\brolling mean\b/i.test((row && row.label) || "");
}

/** Maps resolved row `targetMetric` to `extractAllSeries` key. */
const TARGET_METRIC_TO_SERIES_KEY = {
  HRV: "hrv",
  RHR: "rhr",
  TotalSleep: "totalSleep",
  Disruptions: "disruptions",
  REM: "remSleep",
  DeepSleep: "deepSleep",
  LightSleep: "lightSleep",
  Awake: "awake",
};

function meanOfSeriesValues(seriesDict) {
  const vals = Object.values(seriesDict || {}).filter(
    (v) => v !== null && v !== undefined && !Number.isNaN(Number(v))
  );
  if (vals.length === 0) return null;
  const sum = vals.reduce((a, b) => a + Number(b), 0);
  return sum / vals.length;
}

function visualizationWindowDayCount(rawData) {
  const n =
    rawData?.connect_device_recommendation?.metric_analysis?.visualization?.meta?.num_days;
  return typeof n === "number" && n > 0 ? n : 30;
}

/**
 * HTML fragment: ", which is X% above/below your N-day average" for the outcome metric,
 * comparing bracket mean (yRaw) to the mean of the same series over all days in the file
 * (daily vs 7-day rolling aligned with the correlation row).
 */
function buildOutcomeVsWindowAverageHtml(row, rawData) {
  if (!rawData || !row) return "";
  const sk = TARGET_METRIC_TO_SERIES_KEY[row.targetMetric];
  if (!sk || row.yRaw === null || row.yRaw === undefined || Number.isNaN(Number(row.yRaw))) {
    return "";
  }
  const series = extractAllSeries(rawData);
  const daily = series[sk];
  if (!daily || typeof daily !== "object") return "";

  const useRoll = rowUsesSevenDayRolling(row);
  const outcomeSeries = useRoll ? rollingMean(daily, 7) : daily;
  const baseline = meanOfSeriesValues(outcomeSeries);
  if (baseline === null || baseline === 0) return "";

  const y = Number(row.yRaw);
  const rel = Math.abs(y - baseline) / Math.abs(baseline);
  const nDay = visualizationWindowDayCount(rawData);

  if (rel < 0.01) {
    return `, which is about your ${nDay}-day average`;
  }
  const pct = Math.round(rel * 100);
  const dir = y >= baseline ? "above" : "below";
  return `, which is ${pct}% ${dir} your ${nDay}-day average`;
}

function ageBand(age) {
  if (age < 26) return "18-25";
  if (age < 36) return "26-35";
  if (age < 46) return "36-45";
  if (age < 56) return "46-55";
  if (age < 66) return "56-65";
  return "66+";
}

/** Bracket value from normative_metrics: number, or object with p50 (e.g. rem_sleep percentiles). */
function normativeBracketValue(v) {
  if (v == null) return v;
  if (typeof v === "object" && Number.isFinite(+v.p50)) return +v.p50;
  return v;
}

function meanFromSeriesDict(seriesDict) {
  const vals = Object.values(seriesDict || {}).filter(
    (v) => v !== null && v !== undefined && !Number.isNaN(Number(v))
  );
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + Number(b), 0) / vals.length;
}

function meanSleepStagePercent(metrics, key) {
  let acc = 0;
  let n = 0;
  const rem = metrics?.rem_sleep || {};
  const deep = metrics?.deep_sleep || {};
  const light = metrics?.light_sleep || {};
  const awake = metrics?.awake_time || {};
  const days = new Set([
    ...Object.keys(rem),
    ...Object.keys(deep),
    ...Object.keys(light),
    ...Object.keys(awake),
  ]);
  for (const d of days) {
    const r = rem[d];
    const dp = deep[d];
    const l = light[d];
    const a = awake[d];
    if ([r, dp, l, a].some((v) => v === null || v === undefined || Number.isNaN(Number(v)))) continue;
    const total = Number(r) + Number(dp) + Number(l) + Number(a);
    if (!(total > 0)) continue;
    const num =
      key === "rem_sleep" ? Number(r)
      : key === "deep_sleep" ? Number(dp)
      : key === "light_sleep" ? Number(l)
      : Number(a);
    acc += (num / total) * 100;
    n++;
  }
  return n ? acc / n : null;
}

function computeMetricPriorityRows(rawData, normative) {
  const viz = rawData?.connect_device_recommendation?.metric_analysis?.visualization;
  if (!viz) return [];
  const metrics = viz.metrics || {};
  const meta = viz.meta || {};
  const gender = meta.gender === "female" ? "female" : "male";
  const band = ageBand(Number(meta.age) || 30);
  const norm = (k) => normativeBracketValue(normative?.[k]?.[gender]?.[band]);

  const totalSleepSecAvg = meanFromSeriesDict(metrics.sleep_time || {});
  const totalSleepHours = totalSleepSecAvg == null ? null : totalSleepSecAvg / 3600;
  const disruptionsAvg = meanFromSeriesDict(metrics.disturbances || {});
  const disruptionsPerHour =
    disruptionsAvg != null && totalSleepHours != null && totalSleepHours > 0
      ? disruptionsAvg / totalSleepHours
      : null;

  const userByMetric = {
    REM: meanSleepStagePercent(metrics, "rem_sleep"),
    LightSleep: meanSleepStagePercent(metrics, "light_sleep"),
    DeepSleep: meanSleepStagePercent(metrics, "deep_sleep"),
    Awake: meanSleepStagePercent(metrics, "awake_time"),
    SleepEfficiency: meanFromSeriesDict(metrics.sleep_efficiency || {}) != null
      ? meanFromSeriesDict(metrics.sleep_efficiency || {}) * 100
      : null,
    HRV: meanFromSeriesDict(metrics.HRV || {}),
    RHR: meanFromSeriesDict(metrics.RHR || {}),
    Disruptions: disruptionsPerHour,
  };

  const avgByMetric = {
    REM: norm("rem_sleep"),
    LightSleep: norm("light_sleep"),
    DeepSleep: norm("deep_sleep"),
    Awake: norm("awake"),
    SleepEfficiency: norm("sleep_efficiency"),
    HRV: norm("hrv"),
    RHR: norm("rhr"),
    Disruptions: norm("sleep_disruptions"),
  };

  const lowerIsBetter = new Set(["RHR", "Disruptions", "Awake", "LightSleep"]);
  const metricLabel = {
    REM: "REM Sleep",
    LightSleep: "Light Sleep",
    DeepSleep: "Deep Sleep",
    Awake: "Awake",
    SleepEfficiency: "Sleep Efficiency",
    HRV: "HRV",
    RHR: "Resting HR",
    Disruptions: "Sleep Disruptions",
  };
  const skipPriorityMetrics = new Set(["VO2Max", "TotalSleep"]);

  const out = [];
  for (const key of Object.keys(userByMetric)) {
    if (skipPriorityMetrics.has(key)) continue;
    const user = userByMetric[key];
    const avg = avgByMetric[key];
    if (
      user == null || avg == null ||
      Number.isNaN(Number(user)) || Number.isNaN(Number(avg)) ||
      Number(avg) === 0
    ) continue;

    const rel = lowerIsBetter.has(key)
      ? (Number(avg) - Number(user)) / Math.abs(Number(avg))
      : (Number(user) - Number(avg)) / Math.abs(Number(avg));
    out.push({
      targetMetric: key,
      metricDisplay: metricLabel[key] || key,
      user,
      avg,
      relDeficit: rel,
      severity: Math.abs(rel),
      isNegativeDeficit: rel < 0,
      lowerIsBetter: lowerIsBetter.has(key),
    });
  }
  out.sort((a, b) => {
    // Primary: all negative deficits first, furthest negative first.
    if (a.isNegativeDeficit !== b.isNegativeDeficit) return a.isNegativeDeficit ? -1 : 1;
    if (a.isNegativeDeficit && b.isNegativeDeficit) return b.severity - a.severity;
    // Then positive-side metrics (closest to avg first) as backfill candidates.
    return a.relDeficit - b.relDeficit;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Global metric priority: 5-tier cascade
// ---------------------------------------------------------------------------

const CANDIDATE_METRICS = ["HRV", "RHR", "TotalSleep", "Disruptions", "REM", "DeepSleep", "LightSleep", "Awake"];

const METRIC_TO_NORM_KEY = {
  HRV: "hrv", RHR: "rhr", TotalSleep: "total_sleep", Disruptions: "sleep_disruptions",
  REM: "rem_sleep", DeepSleep: "deep_sleep", LightSleep: "light_sleep", Awake: "awake",
};

const DEFAULT_TAG = {
  HRV: "hrv", RHR: "rhr", Disruptions: "sleep_quality", REM: "rem_sleep",
  DeepSleep: "deep_sleep", LightSleep: "sleep_quality", Awake: "sleep_quality",
  TotalSleep: "sleep_quality",
};

const LOWER_IS_BETTER = new Set(["RHR", "Disruptions", "LightSleep", "Awake"]);

const METRIC_TO_SERIES_EXTRACTOR = {
  HRV: (m) => m.HRV,
  RHR: (m) => m.RHR,
  TotalSleep: (m) => m.sleep_time,
  Disruptions: (m) => m.disturbances,
  REM: (m) => m.rem_sleep,
  DeepSleep: (m) => m.deep_sleep,
  LightSleep: (m) => m.light_sleep,
  Awake: (m) => m.awake_time,
};

/**
 * The four distinct Tier 5 graph slots, in priority order.
 * Each carries a unique csvGraph key that maps directly to the `graph` column
 * in main_cards.csv for text resolution (Layer A) and to the supplement-slot
 * key table TIER5_SUPPLEMENT_SLOT_KEY in populate-health-report.mjs (Layer B).
 */
const TIER5_SLOT_ORDER = [
  { csvGraph: "healthspan"   },
  { csvGraph: "systems"      },
  { csvGraph: "energy"       },
  { csvGraph: "inflammation" },
];

/**
 * CSV/text graph key (used in main_cards.csv + report text) → supplement-slot key
 * used for Tier 5 supplement selection. Everything stays by `csvGraph` except
 * `inflammation`, which maps to `oxidative_stress` for supplements only.
 */
const CSV_GRAPH_TO_SUPPLEMENT_SLOT = {
  healthspan: "healthspan",
  systems: "systems",
  energy: "energy",
  inflammation: "oxidative_stress",
};

/**
 * Tier 5 supplement priority lists (order matters — first available wins).
 * A supplement already chosen by Tier 1–4 (or by an earlier Tier 5 card in
 * this run) is skipped; remaining list fills mostResearched then emergingResearch.
 */
const TIER5_SUPPLEMENT_PRIORITY = {
  healthspan: [
    "Magnesium",
    "Vitamin B12",
    "Probiotics",
    "Ashwagandha",
    "CoQ10",
    "Resveratrol",
    "Acetyl L-Carnitine",
    "Omega 3",
    "Vitamin D",
  ],
  oxidative_stress: ["Magnesium", "Ashwagandha", "Omega 3"],
  systems: ["Vitamin B12", "Probiotics", "Vitamin D"],
  energy: ["CoQ10", "Resveratrol", "Acetyl L-Carnitine"],
};

function buildGlobalMetricPriority(rawData, normative, top10) {
  const viz = rawData?.connect_device_recommendation?.metric_analysis?.visualization;
  if (!viz) return [];
  const metrics = viz.metrics || {};
  const meta = viz.meta || {};
  const gender = meta.gender === "female" ? "female" : "male";
  const band = ageBand(Number(meta.age) || 30);
  const norm = (k) => normativeBracketValue(normative?.[k]?.[gender]?.[band]);
  const p90 = (k) => top10?.[k]?.[gender]?.[band];

  const { analyzeSeries: analyzeVar } = require(require("path").join(__dirname, "varianceRules.js"));

  const totalSleepSecAvg = meanFromSeriesDict(metrics.sleep_time || {});
  const totalSleepHours = totalSleepSecAvg == null ? null : totalSleepSecAvg / 3600;
  const disruptionsAvg = meanFromSeriesDict(metrics.disturbances || {});
  const disruptionsPerHour =
    disruptionsAvg != null && totalSleepHours != null && totalSleepHours > 0
      ? disruptionsAvg / totalSleepHours : null;

  const userMeans = {};
  for (const m of CANDIDATE_METRICS) {
    if (m === "TotalSleep") { userMeans[m] = totalSleepHours; continue; }
    if (m === "Disruptions") { userMeans[m] = disruptionsPerHour; continue; }
    if (["REM", "DeepSleep", "LightSleep", "Awake"].includes(m)) {
      const stageKey = METRIC_TO_NORM_KEY[m];
      userMeans[m] = meanSleepStagePercent(metrics, stageKey);
      continue;
    }
    const extractor = METRIC_TO_SERIES_EXTRACTOR[m];
    userMeans[m] = extractor ? meanFromSeriesDict(extractor(metrics) || {}) : null;
  }

  function seriesValuesForMetric(metricId) {
    const extractor = METRIC_TO_SERIES_EXTRACTOR[metricId];
    if (!extractor) return [];
    const raw = extractor(metrics) || {};
    return Object.values(raw).filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  }

  const tier1 = [];
  const remaining1 = [];

  for (const m of CANDIDATE_METRICS) {
    const u = userMeans[m];
    const avg = norm(METRIC_TO_NORM_KEY[m]);
    if (u == null || avg == null || Number.isNaN(Number(u)) || Number.isNaN(Number(avg)) || Number(avg) === 0) {
      remaining1.push(m);
      continue;
    }
    const deficit = LOWER_IS_BETTER.has(m)
      ? (Number(avg) - Number(u)) / Math.abs(Number(avg))
      : (Number(u) - Number(avg)) / Math.abs(Number(avg));
    if (deficit < 0) {
      tier1.push({ metric: m, tier: 1, deficit, severity: Math.abs(deficit) });
    } else {
      remaining1.push(m);
    }
  }
  tier1.sort((a, b) => b.severity - a.severity);

  const tier2 = [];
  const remaining2 = [];
  for (const m of remaining1) {
    const u = userMeans[m];
    const target = p90(METRIC_TO_NORM_KEY[m]);
    if (u == null || target == null || Number.isNaN(Number(u)) || Number.isNaN(Number(target)) || Number(target) === 0) {
      remaining2.push(m);
      continue;
    }
    const gap = LOWER_IS_BETTER.has(m)
      ? (Number(u) - Number(target)) / Math.abs(Number(target))
      : (Number(target) - Number(u)) / Math.abs(Number(target));
    if (gap > 0.05) {
      tier2.push({ metric: m, tier: 2, gap });
    } else {
      remaining2.push(m);
    }
  }
  tier2.sort((a, b) => b.gap - a.gap);

  const tier3 = [];
  const tier4 = [];
  const remaining34 = [];
  for (const m of remaining2) {
    const vals = seriesValuesForMetric(m);
    const analysis = vals.length > 0 ? analyzeVar(vals, m) : null;
    if (!analysis) { remaining34.push(m); continue; }
    if (analysis.tier === "unstable") {
      tier3.push({ metric: m, tier: 3, daysInRangePct: analysis.daysInRangePct });
    } else if (analysis.tier === "variable") {
      tier4.push({ metric: m, tier: 4, daysInRangePct: analysis.daysInRangePct });
    } else {
      remaining34.push(m);
    }
  }
  tier3.sort((a, b) => a.daysInRangePct - b.daysInRangePct);
  tier4.sort((a, b) => a.daysInRangePct - b.daysInRangePct);

  const tier5 = TIER5_SLOT_ORDER.map((slot, i) => ({
    metric: "healthspan",
    tier: 5,
    tag: "healthspan",
    csvGraph: slot.csvGraph,
    healthspanRank: i,
  }));

  return [
    ...tier1.map((e) => ({ ...e, tag: DEFAULT_TAG[e.metric] })),
    ...tier2.map((e) => ({ ...e, tag: DEFAULT_TAG[e.metric] })),
    ...tier3.map((e) => ({ ...e, tag: DEFAULT_TAG[e.metric] })),
    ...tier4.map((e) => ({ ...e, tag: DEFAULT_TAG[e.metric] })),
    ...tier5,
  ];
}

function formatMetricValueForFallback(metric, v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const x = Number(v);
  if (metric === "TotalSleep") return `${x.toFixed(1)}h`;
  if (metric === "Disruptions") return `${x.toFixed(1)}/h`;
  if (metric === "SleepEfficiency") return `${Math.round(x)}%`;
  if (["REM", "LightSleep", "DeepSleep", "Awake"].includes(metric)) return `${Math.round(x)}%`;
  if (metric === "HRV") return `${Math.round(x)} ms`;
  if (metric === "RHR") return `${Math.round(x)} bpm`;
  return `${Math.round(x * 10) / 10}`;
}

function buildPriorityFallbackRow(priority, rank) {
  const fallbackInterventionByMetric = {
    HRV: "hrv",
    RHR: "rhr",
    SleepEfficiency: "sleep_quality",
    Disruptions: "sleep_disruptions",
    REM: "rem_sleep",
    DeepSleep: "deep_sleep",
    LightSleep: "sleep_quality",
    Awake: "sleep_quality",
  };
  const fallbackIntervention = fallbackInterventionByMetric[priority.targetMetric] || null;
  const pct = Math.round(priority.severity * 100);
  const dirWord = Number(priority.user) >= Number(priority.avg) ? "above" : "below";
  let title = `Priority ${rank + 1}: ${priority.metricDisplay}`;
  let howText = "No significant correlation met the threshold for a unique intervention in this priority area.";
  if (priority.targetMetric === "REM") {
    title = "Boost REM Sleep";
    howText = "REM sleep is essential for memory consolidation, emotional regulation, stress resilience, and neural recovery. Persistently low REM can reduce cognitive performance, increase perceived stress, and blunt adaptation to training. Raising REM helps your overnight recovery translate into better next-day readiness.";
  } else if (priority.targetMetric === "LightSleep") {
    title = "Lower Light Sleep";
    howText = "Excess light sleep often means your night is not progressing deeply enough into restorative deep and REM phases. If light sleep stays high, total sleep may look adequate while recovery quality remains suboptimal. Reducing light-sleep share supports better sleep architecture and improves physical and cognitive restoration.";
  }
  return {
    label: `${priority.targetMetric} fallback`,
    targetMetric: priority.targetMetric,
    r: null,
    n: null,
    nBracket: null,
    direction: null,
    threshold: null,
    supplements: fallbackIntervention ? [fallbackIntervention] : [],
    significant: false,
    marginScore: -1e9 + rank,
    title,
    body: `Your ${priority.metricDisplay} is ${pct}% ${dirWord} your demographic average (${formatMetricValueForFallback(priority.targetMetric, priority.user)} vs ${formatMetricValueForFallback(priority.targetMetric, priority.avg)}).`,
    how_it_works: howText,
    xRaw: null,
    yRaw: null,
    xStr: "—",
    yStr: "—",
    csvKey: null,
  };
}

function pickFocusCardsByPriorityDeficit(rawData, resolvedRows, normative, limit = 4) {
  const priority = computeMetricPriorityRows(rawData, normative);
  const significant = resolvedRows.filter((r) => r.significant);
  const usedInterventions = new Set();
  const picks = [];
  let pickedSevenDay = false;

  for (let i = 0; i < priority.length; i++) {
    if (picks.length >= limit) break;
    const p = priority[i];
    const candidates = significant
      .filter((r) => r.targetMetric === p.targetMetric)
      .filter((r) => {
        const iv = interventionKeyFromRow(r);
        return !!iv && !usedInterventions.has(iv);
      })
      .filter((r) => !(rowUsesSevenDayRolling(r) && pickedSevenDay))
      .sort((a, b) => {
        const ma = Number(a.marginScore) || 0;
        const mb = Number(b.marginScore) || 0;
        if (mb !== ma) return mb - ma;
        const ra = Math.abs(Number(a.r) || 0);
        const rb = Math.abs(Number(b.r) || 0);
        return rb - ra;
      });

    if (candidates.length) {
      const best = candidates[0];
      const iv = interventionKeyFromRow(best);
      if (iv) usedInterventions.add(iv);
      if (rowUsesSevenDayRolling(best)) pickedSevenDay = true;
      picks.push(best);
    } else {
      const fb = buildPriorityFallbackRow(p, i);
      const iv = interventionKeyFromRow(fb);
      // If fallback intervention already used, skip this metric and move to next priority.
      if (!iv || usedInterventions.has(iv)) continue;
      usedInterventions.add(iv);
      picks.push(fb);
    }
  }

  return picks.slice(0, limit);
}

/** sleep_disruptions, deep_sleep, rem_sleep may appear together; sleep_quality is subordinate. */
const SLEEP_PREMIUM_INTERVENTIONS = new Set(["sleep_disruptions", "deep_sleep", "rem_sleep"]);
const SLEEP_QUALITY_INTERVENTION = "sleep_quality";

function hasPremiumSleepIntervention(rows) {
  return rows.some(r => SLEEP_PREMIUM_INTERVENTIONS.has(interventionKeyFromRow(r)));
}

/**
 * Significant rows (pre-sorted by marginScore desc): top k with unique intervention
 * (supplements[0]) and at most one 7-day rolling row across the picks.
 */
function pickTopByUniqueIntervention(sortedRows, limit = 3) {
  const usedIntervention = new Set();
  let pickedSevenDay = false;
  const out = [];
  for (const row of sortedRows) {
    if (out.length >= limit) break;
    const iv = interventionKeyFromRow(row);
    if (!iv) continue;
    if (usedIntervention.has(iv)) continue;
    if (rowUsesSevenDayRolling(row) && pickedSevenDay) continue;
    usedIntervention.add(iv);
    if (rowUsesSevenDayRolling(row)) pickedSevenDay = true;
    out.push(row);
  }
  return out;
}

/**
 * Hopcroft–Karp: maximum cardinality matching, |U|=nU, |V|=nV, adj[u] = list of v indices.
 * pairU[u]=v or -1, pairV[v]=u or -1.
 */
function hopcroftKarpMatching(adj, nU, nV) {
  const INF = 1e9;
  const pairU = new Array(nU).fill(-1);
  const pairV = new Array(nV).fill(-1);
  const dist = new Array(nU + 1);

  function bfs() {
    const q = [];
    for (let u = 0; u < nU; u++) {
      if (pairU[u] === -1) {
        dist[u] = 0;
        q.push(u);
      } else {
        dist[u] = INF;
      }
    }
    dist[nU] = INF;
    let qh = 0;
    while (qh < q.length) {
      const u = q[qh++];
      if (dist[u] < dist[nU]) {
        for (const v of adj[u]) {
          const mu = pairV[v];
          if (mu === -1) {
            dist[nU] = dist[u] + 1;
          } else if (dist[mu] === INF) {
            dist[mu] = dist[u] + 1;
            q.push(mu);
          }
        }
      }
    }
    return dist[nU] !== INF;
  }

  function dfs(u) {
    for (const v of adj[u]) {
      const mu = pairV[v];
      if (mu === -1) {
        if (dist[nU] === dist[u] + 1) {
          pairU[u] = v;
          pairV[v] = u;
          return true;
        }
      } else if (dist[mu] === dist[u] + 1 && dfs(mu)) {
        pairU[u] = v;
        pairV[v] = u;
        return true;
      }
    }
    dist[u] = INF;
    return false;
  }

  while (bfs()) {
    for (let u = 0; u < nU; u++) {
      if (pairU[u] === -1) dfs(u);
    }
  }
  return { pairU, pairV };
}

/** Best row per (intervention, targetMetric): higher marginScore; tie → prefer non–7-day rolling. */
function pickRepresentativeRowForPair(rows) {
  return rows.slice().sort((a, b) => {
    if (b.marginScore !== a.marginScore) return b.marginScore - a.marginScore;
    return (rowUsesSevenDayRolling(a) ? 1 : 0) - (rowUsesSevenDayRolling(b) ? 1 : 0);
  })[0];
}

/**
 * Collapse significant rows to one edge per (intervention, METRIC_A / targetMetric).
 */
function buildInterventionTargetMetricEdges(significantRows) {
  const groups = new Map();
  for (const row of significantRows) {
    const iv = interventionKeyFromRow(row);
    const metric = row.targetMetric;
    if (!iv || !metric) continue;
    const k = `${iv}\0${metric}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const edges = [];
  for (const rows of groups.values()) {
    const row = pickRepresentativeRowForPair(rows);
    edges.push({
      iv: interventionKeyFromRow(row),
      metric: row.targetMetric,
      row,
    });
  }
  return edges;
}

function matchingHasPremiumAndSleepQuality(rows) {
  let prem = false;
  let sq = false;
  for (const r of rows) {
    const iv = interventionKeyFromRow(r);
    if (SLEEP_PREMIUM_INTERVENTIONS.has(iv)) prem = true;
    if (iv === SLEEP_QUALITY_INTERVENTION) sq = true;
  }
  return prem && sq;
}

function marginSum(picks) {
  return picks.reduce((s, r) => s + (Number(r.marginScore) || 0), 0);
}

/** Prefer larger cardinality, then higher total |r|-|τ| (margin sum). */
function comparePickSets(a, b) {
  if (a.length !== b.length) return b.length - a.length;
  return marginSum(b) - marginSum(a);
}

/**
 * Maximum-cardinality assignment: each intervention and each target metric (METRIC_A) used at most once.
 * Uses Hopcroft–Karp (not correlation strength ranking). At most one 7-day rolling row in the result.
 * Tie-breaking among same-size matchings: higher sum of marginScore; duplicate (iv, metric) rows use margin + rolling tie-break at collapse.
 * If the matching would include both a premium sleep intervention and sleep_quality, re-run without sleep_quality edges.
 * Final list is ordered by correlation strength (marginScore desc, then |r| desc).
 */
function pickFocusCardsHopcroftKarp(significantRows) {
  let edges = buildInterventionTargetMetricEdges(significantRows);

  function runMatching(edgeList) {
    if (edgeList.length === 0) return [];
    const leftIds = [...new Set(edgeList.map((e) => e.iv))].sort();
    const rightIds = [...new Set(edgeList.map((e) => e.metric))].sort();
    const uIx = new Map(leftIds.map((id, i) => [id, i]));
    const vIx = new Map(rightIds.map((id, i) => [id, i]));
    const nU = leftIds.length;
    const nV = rightIds.length;
    const adj = Array.from({ length: nU }, () => []);
    const rowByPair = new Map();
    for (const e of edgeList) {
      const u = uIx.get(e.iv);
      const v = vIx.get(e.metric);
      adj[u].push(v);
      rowByPair.set(`${e.iv}\0${e.metric}`, e.row);
    }
    const { pairU } = hopcroftKarpMatching(adj, nU, nV);
    const picks = [];
    for (let u = 0; u < nU; u++) {
      const v = pairU[u];
      if (v === -1) continue;
      const iv = leftIds[u];
      const metric = rightIds[v];
      picks.push(rowByPair.get(`${iv}\0${metric}`));
    }
    return picks;
  }

  /**
   * Best Hopcroft–Karp matching using only non-rolling edges, or non-rolling plus exactly one rolling edge.
   */
  function runMatchingAtMostOneRolling(edgeList) {
    const en = edgeList.filter((e) => !rowUsesSevenDayRolling(e.row));
    const er = edgeList.filter((e) => rowUsesSevenDayRolling(e.row));
    const candidates = [runMatching(en)];
    for (const e of er) {
      candidates.push(runMatching([...en, e]));
    }
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (comparePickSets(best, candidates[i]) > 0) best = candidates[i];
    }
    return best;
  }

  let picks = runMatchingAtMostOneRolling(edges);
  if (matchingHasPremiumAndSleepQuality(picks)) {
    edges = edges.filter((e) => e.iv !== SLEEP_QUALITY_INTERVENTION);
    picks = runMatchingAtMostOneRolling(edges);
  }

  picks.sort((a, b) => {
    const ma = Number(a.marginScore) || 0;
    const mb = Number(b.marginScore) || 0;
    if (mb !== ma) return mb - ma;
    const ra = Math.abs(Number(a.r) || 0);
    const rb = Math.abs(Number(b.r) || 0);
    if (rb !== ra) return rb - ra;
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
  return picks;
}

/**
 * If any pick uses a "premium" sleep intervention, remove sleep_quality picks.
 * Backfill from sortedSignificant (margin order) with the same rules as pickTopByUniqueIntervention
 * and never add sleep_quality when a premium sleep intervention is already selected.
 */
function finalizeFocusPicksWithSleepHierarchy(sortedSignificant, preliminaryPicks, limit = 3) {
  let picks = preliminaryPicks.slice();
  if (hasPremiumSleepIntervention(picks)) {
    picks = picks.filter(r => interventionKeyFromRow(r) !== SLEEP_QUALITY_INTERVENTION);
  }

  const pickedLabels = new Set(picks.map(r => r.label));
  const usedIntervention = new Set(picks.map(r => interventionKeyFromRow(r)).filter(Boolean));
  let pickedSevenDay = picks.some(rowUsesSevenDayRolling);

  while (picks.length < limit) {
    let added = false;
    for (const row of sortedSignificant) {
      if (pickedLabels.has(row.label)) continue;
      const iv = interventionKeyFromRow(row);
      if (!iv || usedIntervention.has(iv)) continue;
      if (rowUsesSevenDayRolling(row) && pickedSevenDay) continue;
      if (iv === SLEEP_QUALITY_INTERVENTION && hasPremiumSleepIntervention(picks)) continue;
      picks.push(row);
      pickedLabels.add(row.label);
      usedIntervention.add(iv);
      if (rowUsesSevenDayRolling(row)) pickedSevenDay = true;
      added = true;
      break;
    }
    if (!added) break;
  }
  return picks;
}

// ---------------------------------------------------------------------------
// Kuhn-Munkres (Hungarian) for optimal supplement ↔ metric assignment
// ---------------------------------------------------------------------------

const TARGET_METRIC_TO_RESEARCH_KEY = {
  HRV: "hrv",
  RHR: "rhr",
  SleepEfficiency: "sleep_quality",
  Disruptions: "sleep_disruptions",
  REM: "rem_sleep",
  DeepSleep: "deep_sleep",
  LightSleep: "sleep_quality",
  Awake: "sleep_quality",
  TotalSleep: "sleep_quality",
};

const ELIGIBLE_IMPACTS = new Set(["Moderate", "High", "Very High"]);

/**
 * Resolve which top-level key in metrics_supplement_research to use for a focus card.
 * Prefers the resolved correlation tag (e.g. recovery); falls back to metric-based key if missing.
 *
 * @param {string} [tag]        from focus pick `_tag` / resolveTop4WithCorrelations
 * @param {string} targetMetric card ordering key (HRV, DeepSleep, …)
 * @param {object} researchData parsed metrics_supplement_research JSON
 */
function researchKeyForSupplementLookup(tag, targetMetric, researchData) {
  const t = tag != null ? String(tag).trim() : "";
  if (t && typeof researchData[t] === "object" && researchData[t] !== null && !Array.isArray(researchData[t])) {
    return t;
  }
  const tLower = t.toLowerCase();
  if (
    tLower &&
    tLower !== t &&
    typeof researchData[tLower] === "object" &&
    researchData[tLower] !== null &&
    !Array.isArray(researchData[tLower])
  ) {
    return tLower;
  }
  return TARGET_METRIC_TO_RESEARCH_KEY[targetMetric] || String(targetMetric).toLowerCase();
}

/**
 * O(n^3) Kuhn-Munkres (Hungarian) for an n×n cost matrix (minimisation).
 * Returns an array `col` of length n where col[row] = assigned column index.
 */
function hungarianAssignment(cost) {
  const n = cost.length;
  if (n === 0) return [];
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  const INF = 1e18;

  for (let i = 1; i <= n; i++) {
    const minv = new Float64Array(n + 1).fill(INF);
    const used = new Uint8Array(n + 1);
    p[0] = i;
    let j0 = 0;
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const ans = new Array(n);
  for (let j = 1; j <= n; j++) {
    if (p[j] !== 0) ans[p[j] - 1] = j - 1;
  }
  return ans;
}

/**
 * Run Hungarian once for a single tier (mostResearched or emergingResearch).
 *
 * @param {string[]} cardKeys      targetMetric per column (output keys; card order)
 * @param {string[]} researchKeys  top-level JSON key per column (from resolved tags)
 * @param {object}   researchData  parsed metrics_supplement_research JSON
 * @param {string[]} supplementList supplement names for this tier
 * @returns {Object.<string, {supplement: string, score: number, impact: string}>}
 *          keyed by targetMetric (only entries with a real assignment)
 */
function runHungarianForTier(cardKeys, researchKeys, researchData, supplementList) {
  const metricKeys = researchKeys;

  const eligible = [];
  for (const sup of supplementList) {
    let anyEdge = false;
    for (const mk of metricKeys) {
      const entry = researchData[mk] && researchData[mk][sup];
      if (
        entry &&
        typeof entry.supplement_score === "number" &&
        ELIGIBLE_IMPACTS.has(entry.impact)
      ) {
        anyEdge = true;
        break;
      }
    }
    if (anyEdge) eligible.push(sup);
  }

  const nMetrics = metricKeys.length;
  const nSupp = eligible.length;
  if (nMetrics === 0 || nSupp === 0) return {};

  let sMax = 0;
  const scores = [];
  for (let s = 0; s < nSupp; s++) {
    const row = [];
    for (let m = 0; m < nMetrics; m++) {
      const entry = researchData[metricKeys[m]] && researchData[metricKeys[m]][eligible[s]];
      if (
        entry &&
        typeof entry.supplement_score === "number" &&
        ELIGIBLE_IMPACTS.has(entry.impact)
      ) {
        row.push({ score: entry.supplement_score, impact: entry.impact });
        if (entry.supplement_score > sMax) sMax = entry.supplement_score;
      } else {
        row.push(null);
      }
    }
    scores.push(row);
  }

  const PENALTY = sMax + 1000;
  const dim = Math.max(nSupp, nMetrics);
  const costMatrix = [];
  for (let i = 0; i < dim; i++) {
    const row = [];
    for (let j = 0; j < dim; j++) {
      if (i < nSupp && j < nMetrics && scores[i][j] !== null) {
        row.push(sMax - scores[i][j].score);
      } else if (i >= nSupp || j >= nMetrics) {
        row.push(0);
      } else {
        row.push(PENALTY);
      }
    }
    costMatrix.push(row);
  }

  const assignment = hungarianAssignment(costMatrix);
  const result = {};
  for (let i = 0; i < nSupp; i++) {
    const j = assignment[i];
    if (j < nMetrics && scores[i][j] !== null) {
      const tm = cardKeys[j];
      if (!result[tm] || scores[i][j].score > result[tm].score) {
        result[tm] = {
          supplement: eligible[i],
          score: scores[i][j].score,
          impact: scores[i][j].impact,
        };
      }
    }
  }
  return result;
}

/**
 * Assign one mostResearched and one emergingResearch supplement per focus card
 * via Kuhn-Munkres (maximise supplement_score, impact >= Moderate).
 * Scores use the resolved tag’s research subtree (`_tag`), not the display metric.
 *
 * @param {object[]} focusPicks   focus card rows (each has .targetMetric, ._tag)
 * @param {object}   researchData parsed metrics_supplement_research JSON
 * @param {object}   tiers        parsed supplement_research_tiers.json
 * @returns {{ mostResearched: Object, emergingResearch: Object }}
 */
function assignSupplementsToFocusCards(focusPicks, researchData, tiers) {
  const cardKeys = [];
  const researchKeys = [];
  for (const p of focusPicks) {
    const tm = p.targetMetric;
    if (!tm) continue;
    cardKeys.push(tm);
    researchKeys.push(researchKeyForSupplementLookup(p._tag, tm, researchData));
  }
  return {
    mostResearched: runHungarianForTier(cardKeys, researchKeys, researchData, tiers.mostResearched || []),
    emergingResearch: runHungarianForTier(cardKeys, researchKeys, researchData, tiers.emergingResearch || []),
  };
}

/**
 * Globally-unique supplement assignment across all focus cards.
 *
 * Process:
 * 1. Tier 1–4 cards are assigned first using the existing Hungarian solver
 *    (mostResearched + emergingResearch), keyed by per-pick `targetMetric`.
 * 2. Every supplement picked in step 1 is added to a shared `usedSupplements`
 *    set (guaranteeing it cannot reappear in any Tier 5 slot).
 * 3. Tier 5 cards are then processed in their existing `csvGraph` order.
 *    For each card, the supplement slot is resolved via CSV_GRAPH_TO_SUPPLEMENT_SLOT
 *    (e.g. `inflammation` → `oxidative_stress`) and supplements are drawn from
 *    TIER5_SUPPLEMENT_PRIORITY[slot], skipping any already in `usedSupplements`.
 *    The first available supplement fills `mostResearched`; the second fills
 *    `emergingResearch`. Each chosen supplement is added to `usedSupplements`
 *    immediately so later Tier 5 cards cannot pick it again.
 *
 * Score/impact values for Tier 5 picks are looked up in
 * `researchData.healthspan` (umbrella bucket for longevity cards); if a
 * supplement is missing there, `score` and `impact` are `null`.
 *
 * @param {object[]} focusPicks   focus card rows, each with at least `targetMetric`, `_tag`, `_tier`, `_csvGraph`
 * @param {object}   researchData parsed metrics_supplement_research JSON (may be null)
 * @param {object}   tiers        parsed supplement_research_tiers JSON (may be null)
 * @returns {{mostResearched: (object|null), emergingResearch: (object|null)}[]} one entry per focus pick, index-aligned with input
 */
function assignFocusSupplementsWithUniqueness(focusPicks, researchData, tiers) {
  const results = focusPicks.map(() => ({ mostResearched: null, emergingResearch: null }));
  const usedSupplements = new Set();

  const t14 = [];
  const t5 = [];
  focusPicks.forEach((p, i) => {
    if ((p?._tier ?? null) === 5) t5.push({ p, i });
    else t14.push({ p, i });
  });

  // ── Step 1: Tier 1–4 via Hungarian (existing behaviour) ────────────────────
  if (researchData && tiers && t14.length > 0) {
    const cardKeys = t14.map(({ p }) => p.targetMetric);
    const researchKeys = t14.map(({ p }) =>
      researchKeyForSupplementLookup(p._tag, p.targetMetric, researchData),
    );
    const most = runHungarianForTier(cardKeys, researchKeys, researchData, tiers.mostResearched || []);
    const emer = runHungarianForTier(cardKeys, researchKeys, researchData, tiers.emergingResearch || []);
    for (const { p, i } of t14) {
      const tm = p.targetMetric;
      results[i].mostResearched = most[tm] ?? null;
      results[i].emergingResearch = emer[tm] ?? null;
    }
  }

  // Step 2: seed usedSupplements from every Tier 1–4 assignment.
  for (const r of results) {
    if (r.mostResearched?.supplement) usedSupplements.add(r.mostResearched.supplement);
    if (r.emergingResearch?.supplement) usedSupplements.add(r.emergingResearch.supplement);
  }

  // ── Step 3: Tier 5 in existing csvGraph order, draining priority lists. ────
  function lookupTier5Entry(supplementName) {
    if (!researchData) return { supplement: supplementName, score: null, impact: null };
    const entry = researchData.healthspan?.[supplementName];
    if (entry && typeof entry.supplement_score === "number") {
      return {
        supplement: supplementName,
        score: entry.supplement_score,
        impact: entry.impact ?? null,
      };
    }
    return { supplement: supplementName, score: null, impact: null };
  }

  for (const { p, i } of t5) {
    const csvGraph = p._csvGraph || "healthspan";
    const slot = CSV_GRAPH_TO_SUPPLEMENT_SLOT[csvGraph] || csvGraph;
    const priorityList = TIER5_SUPPLEMENT_PRIORITY[slot] || [];
    const available = priorityList.filter((s) => !usedSupplements.has(s));
    const primary = available[0] ?? null;
    const secondary = available[1] ?? null;
    if (primary) {
      results[i].mostResearched = lookupTier5Entry(primary);
      usedSupplements.add(primary);
    }
    if (secondary) {
      results[i].emergingResearch = lookupTier5Entry(secondary);
      usedSupplements.add(secondary);
    }
  }

  return results;
}

/**
 * Throws an explicit error if any focus card has zero supplements (both
 * `mostResearched.supplement` and `emergingResearch.supplement` null/empty).
 *
 * Applies to every tier. Tier 5 empties are filtered out upstream, so this
 * check primarily guards Tier 1–4 where the Hungarian solver can produce a
 * card with no supplement edges (and there is no backfill for Tier 1–4).
 */
function assertEveryFocusCardHasSupplements(focusMetricsTagsSupplements) {
  focusMetricsTagsSupplements.forEach((row, idx) => {
    const a = row.supplements?.mostResearched?.supplement;
    const b = row.supplements?.emergingResearch?.supplement;
    if (!a && !b) {
      throw new Error(
        `[focus_metrics_tags_supplements] focus card has zero supplements:\n` +
          `  card[${idx}] order=${row.order} tier=${row.tier} metric=${row.metric} ` +
          `graph=${row.graph_type} tag=${row.tag}`,
      );
    }
  });
}

/**
 * Throws an explicit error if any supplement is assigned to more than one card
 * across `focus_metrics_tags_supplements.json`. Checks both mostResearched and
 * emergingResearch slots.
 */
function assertNoDuplicateFocusSupplements(focusMetricsTagsSupplements) {
  const seen = new Map();
  focusMetricsTagsSupplements.forEach((row, idx) => {
    const slots = [
      ["mostResearched", row.supplements?.mostResearched],
      ["emergingResearch", row.supplements?.emergingResearch],
    ];
    for (const [slot, entry] of slots) {
      const name = entry?.supplement;
      if (!name) continue;
      if (seen.has(name)) {
        const prev = seen.get(name);
        throw new Error(
          `[focus_metrics_tags_supplements] duplicate supplement "${name}":\n` +
            `  card[${prev.idx}]: order=${prev.order} tier=${prev.tier} graph=${prev.graph} slot=${prev.slot}\n` +
            `  card[${idx}]: order=${row.order} tier=${row.tier} graph=${row.graph_type} slot=${slot}`,
        );
      }
      seen.set(name, {
        idx,
        order: row.order,
        tier: row.tier,
        graph: row.graph_type,
        slot,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Phase 2 + validation loop: resolve top-4 metrics with correlation matching
// ---------------------------------------------------------------------------

/**
 * Run Hopcroft-Karp on a set of edges and return matched picks.
 * Left = metric names, right = intervention keys.
 */
function runHKOnEdges(edgeList) {
  if (edgeList.length === 0) return [];
  const leftIds = [...new Set(edgeList.map((e) => e.metric))].sort();
  const rightIds = [...new Set(edgeList.map((e) => e.iv))].sort();
  const uIx = new Map(leftIds.map((id, i) => [id, i]));
  const vIx = new Map(rightIds.map((id, i) => [id, i]));
  const nU = leftIds.length;
  const nV = rightIds.length;
  const adj = Array.from({ length: nU }, () => []);
  const rowByPair = new Map();
  for (const e of edgeList) {
    const u = uIx.get(e.metric);
    const v = vIx.get(e.iv);
    adj[u].push(v);
    rowByPair.set(`${e.metric}\0${e.iv}`, e.row);
  }
  const { pairU } = hopcroftKarpMatching(adj, nU, nV);
  const picks = [];
  for (let u = 0; u < nU; u++) {
    const v = pairU[u];
    if (v === -1) continue;
    const metric = leftIds[u];
    const iv = rightIds[v];
    picks.push({ metric, iv, row: rowByPair.get(`${metric}\0${iv}`) });
  }
  return picks;
}

/**
 * Collapse significant rows to one edge per (metric, intervention), keeping
 * the row with highest marginScore (ties broken by preferring non-rolling).
 */
function collapseEdges(rows) {
  const groups = new Map();
  for (const row of rows) {
    const iv = interventionKeyFromRow(row);
    const metric = row.targetMetric;
    if (!iv || !metric) continue;
    const k = `${metric}\0${iv}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const edges = [];
  for (const rws of groups.values()) {
    const row = rws.slice().sort((a, b) => {
      if (b.marginScore !== a.marginScore) return b.marginScore - a.marginScore;
      return (rowUsesSevenDayRolling(a) ? 1 : 0) - (rowUsesSevenDayRolling(b) ? 1 : 0);
    })[0];
    edges.push({ iv: interventionKeyFromRow(row), metric: row.targetMetric, row });
  }
  return edges;
}

function resolveTop4WithCorrelations(globalPriority, resolvedRows, csvCardMap) {
  const MAX_ITERATIONS = 20;
  const allSignificant = resolvedRows.filter((r) => r.significant);

  let excludedMetrics = new Set();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Tier 1–4 candidates (capped at 4). Tier 5 is NOT capped here; the caller
    // decides how many to actually use as backfill after supplement assignment
    // (cards that can't receive any supplement are skipped downstream).
    const realEntries = [];
    for (const entry of globalPriority) {
      if (realEntries.length >= 4) break;
      if (entry.tier === 5) continue;
      if (excludedMetrics.has(entry.metric)) continue;
      realEntries.push(entry);
    }
    const healthspanEntries = globalPriority.filter((e) => e.tier === 5);
    const realMetricNames = new Set(realEntries.map((e) => e.metric));

    if (realEntries.length === 0) {
      const picks = [];
      const seen = new Set();
      for (const entry of healthspanEntries) {
        const dedupeKey = entry.csvGraph || entry.metric;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        picks.push({
          metric: entry.metric,
          tag: entry.tag,
          tier: entry.tier,
          csvGraph: entry.csvGraph,
          matchedRow: null,
        });
      }
      return { picks, tagMap: {} };
    }

    const relevantSig = allSignificant.filter((r) => realMetricNames.has(r.targetMetric));
    const singleDay = relevantSig.filter((r) => !rowUsesSevenDayRolling(r));
    const sevenDay = relevantSig.filter((r) => rowUsesSevenDayRolling(r));

    const sdEdges = collapseEdges(singleDay);
    const s7Edges = collapseEdges(sevenDay);

    // Graph 2: 7-day matching to find surviving 7-day edges
    const surviving7d = runHKOnEdges(s7Edges);

    // Build candidate graphs
    const candidates = [];

    // Candidate A: single-day only
    const matchA = runHKOnEdges(sdEdges);
    candidates.push({ picks: matchA, has7d: false, sevenDayR: 0 });

    // Candidate B_i: single-day + one surviving 7-day edge
    for (const s7 of surviving7d) {
      const s7Edge = s7Edges.find((e) => e.metric === s7.metric && e.iv === s7.iv);
      if (!s7Edge) continue;
      const combined = [s7Edge, ...sdEdges]; // rolling edge first → preferred in HK DFS
      const matchBi = runHKOnEdges(combined);
      const absR = s7Edge.row ? Math.abs(Number(s7Edge.row.r) || 0) : 0;
      candidates.push({ picks: matchBi, has7d: true, sevenDayR: absR });
    }

    // Select winner: max cardinality, then prefer 7d, then highest 7d significance
    candidates.sort((a, b) => {
      if (b.picks.length !== a.picks.length) return b.picks.length - a.picks.length;
      if (a.has7d !== b.has7d) return a.has7d ? -1 : 1;
      return b.sevenDayR - a.sevenDayR;
    });
    const winner = candidates[0];

    // Build matched map: metric -> matched pick
    const matchedByMetric = new Map();
    for (const p of winner.picks) {
      matchedByMetric.set(p.metric, p);
    }

    // Extract tag mapping
    const tagMap = {};
    for (const entry of realEntries) {
      const m = entry.metric;
      const matched = matchedByMetric.get(m);
      if (matched && matched.row) {
        const csvKey = labelToCsvKey(matched.row.label);
        const card = csvKey ? csvCardMap.get(csvKey) : null;
        tagMap[m] = (card && card.metric_1) ? card.metric_1 : DEFAULT_TAG[m] || m.toLowerCase();
      } else {
        tagMap[m] = DEFAULT_TAG[m] || m.toLowerCase();
      }
    }

    // Validation: TotalSleep rule
    let needsRerun = false;
    if (realMetricNames.has("TotalSleep") && !matchedByMetric.has("TotalSleep")) {
      excludedMetrics.add("TotalSleep");
      needsRerun = true;
    }

    if (!needsRerun) {
      // Validation: tag uniqueness
      const tagToMetrics = new Map();
      for (const entry of realEntries) {
        const tag = tagMap[entry.metric];
        if (!tagToMetrics.has(tag)) tagToMetrics.set(tag, []);
        tagToMetrics.get(tag).push(entry);
      }
      for (const [, entriesWithTag] of tagToMetrics) {
        if (entriesWithTag.length <= 1) continue;
        const globalIndices = entriesWithTag.map((e) => globalPriority.indexOf(e));
        const keepIdx = Math.min(...globalIndices);
        for (let i = 0; i < entriesWithTag.length; i++) {
          if (globalPriority.indexOf(entriesWithTag[i]) !== keepIdx) {
            excludedMetrics.add(entriesWithTag[i].metric);
            needsRerun = true;
          }
        }
      }
    }

    if (needsRerun) continue;

    // Build final picks
    const finalPicks = [];
    for (const entry of realEntries) {
      const matched = matchedByMetric.get(entry.metric);
      finalPicks.push({
        metric: entry.metric,
        tag: tagMap[entry.metric],
        tier: entry.tier,
        matchedRow: matched ? matched.row : null,
      });
    }
    const seenTier5Graphs = new Set();
    for (const entry of healthspanEntries) {
      // Dedupe by csvGraph: each tier5 slot type (healthspan/systems/energy/inflammation)
      // maps to a distinct main_cards.csv row (different text), so uniqueness is per graph key.
      const dedupeKey = entry.csvGraph || entry.metric;
      if (seenTier5Graphs.has(dedupeKey)) continue;
      seenTier5Graphs.add(dedupeKey);
      finalPicks.push({
        metric: entry.metric,
        tag: entry.tag,
        tier: entry.tier,
        csvGraph: entry.csvGraph,
        matchedRow: null,
      });
    }

    // No .slice(0, 4): return all valid real picks + all Tier 5 candidates.
    // Caller filters empty Tier 5 cards and caps the final card count.
    return { picks: finalPicks, tagMap };
  }

  // Safety: if we exhaust iterations, return whatever we have.
  const fallback = globalPriority.map((e) => ({
    metric: e.metric,
    tag: e.tag || DEFAULT_TAG[e.metric] || e.metric.toLowerCase(),
    tier: e.tier,
    csvGraph: e.csvGraph,
    matchedRow: null,
  }));
  return { picks: fallback, tagMap: {} };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Phrases to highlight in card copy (METRIC_A / METRIC_B), longest first after dedupe. */
function deriveHighlightPhrasesFromCsvMetric(csvMetric) {
  const bag = new Set();
  const m = (csvMetric || "").trim();
  if (!m) return [];

  bag.add(m);

  const isRoll = /\brolling mean\b/i.test(m) && /\(7-day\)/i.test(m);
  let core = m
    .replace(/\s+rolling mean\s*\(7-day\)\s*$/i, "")
    .replace(/\s*\(7-day\)\s*$/i, "")
    .replace(/\s*\(t-1\)\s*$/i, "")
    .replace(/\s*\(t\)\s*$/i, "")
    .trim();

  const spaced = core.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  bag.add(spaced);
  bag.add(spaced.toLowerCase());

  if (isRoll) {
    bag.add(`7-day average ${spaced}`.replace(/\s+/g, " ").trim());
    bag.add(`average ${spaced}`.replace(/\s+/g, " ").trim());
  }

  const low = spaced.toLowerCase();
  if (low.includes("training") && low.includes("intensity")) {
    bag.add("training intensity");
    bag.add("7-day average training intensity");
    bag.add("average training intensity");
  }
  if (/^hrv$/i.test(spaced) || low.startsWith("hrv ")) {
    bag.add("HRV");
    bag.add("next-day HRV");
    bag.add("7-day average HRV");
    bag.add("average HRV");
  }
  if (/^rhr$/i.test(spaced) || low.startsWith("rhr ")) {
    bag.add("RHR");
    bag.add("next-day RHR");
    bag.add("7-day average RHR");
    bag.add("average RHR");
  }
  if (low.includes("disruption")) {
    bag.add("sleep disruptions");
    bag.add("disruptions");
  }
  if (low.includes("deep") && low.includes("sleep")) {
    bag.add("Deep Sleep");
    bag.add("deep sleep");
  }
  if (low.includes("rem") && !low.includes("prem")) {
    bag.add("REM Sleep");
    bag.add("REM sleep");
    bag.add("rem sleep");
  }
  if (/lightsleep|light sleep/i.test(spaced)) {
    bag.add("Light Sleep");
    bag.add("light sleep");
    bag.add("7-day average Light Sleep");
    bag.add("average Light Sleep");
  }
  if (/totalsleep|total sleep/i.test(spaced)) {
    bag.add("total sleep");
    bag.add("sleep duration");
    bag.add("7-day average sleep duration");
    bag.add("average sleep duration");
  }
  if (low.includes("awake")) {
    bag.add("nightly awake time");
    bag.add("awake time");
    bag.add("Awake time");
    bag.add("awake phases");
  }

  return [...bag].filter((p) => p && p.length >= 2).sort((a, b) => b.length - a.length);
}

function csvKeyToHighlightPhrases(csvKey) {
  if (!csvKey) return [];
  const parts = csvKey.split("|").map((s) => s.trim());
  const out = [];
  for (const p of parts) out.push(...deriveHighlightPhrasesFromCsvMetric(p));
  const seen = new Set();
  const deduped = [];
  for (const ph of out.sort((a, b) => b.length - a.length)) {
    const k = ph.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(ph);
  }
  return deduped;
}

function findAllOccurrencesExact(body, needle) {
  const ranges = [];
  if (needle === undefined || needle === null || needle === "" || needle === "—") return ranges;
  const s = String(needle);
  let i = 0;
  while ((i = body.indexOf(s, i)) !== -1) {
    ranges.push({ start: i, end: i + s.length });
    i += s.length;
  }
  return ranges;
}

function findAllOccurrencesCI(body, needle) {
  const ranges = [];
  if (!needle || String(needle).length < 2) return ranges;
  const lower = body.toLowerCase();
  const n = String(needle).toLowerCase();
  let i = 0;
  while ((i = lower.indexOf(n, i)) !== -1) {
    ranges.push({ start: i, end: i + n.length });
    i += n.length;
  }
  return ranges;
}

function mergeSpanRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ start: cur.start, end: cur.end });
  }
  return out;
}

/**
 * Wraps X, Y (+ units: ms, bpm, hours, min, …) and METRIC_A / METRIC_B phrases in focus-card__metric-em.
 */
function buildHighlightedLead(body, xStr, yStr, csvKey, analysisLabel) {
  if (!body) return "";
  const phrases = csvKeyToHighlightPhrases(csvKey);
  const { xKind, yKind } = formatKindsFromAnalysisLabel(analysisLabel);
  const xSuffixes = suffixesForFormatKind(xKind);
  const ySuffixes = suffixesForFormatKind(yKind);
  const ranges = [];
  for (const r of findValueOccurrencesWithUnits(body, xStr, xSuffixes)) ranges.push(r);
  for (const r of findValueOccurrencesWithUnits(body, yStr, ySuffixes)) ranges.push(r);
  const xS = xStr === undefined || xStr === null ? "" : String(xStr);
  const yS = yStr === undefined || yStr === null ? "" : String(yStr);
  for (const ph of phrases) {
    if (!ph) continue;
    if (ph === xS || ph === yS) continue;
    if (xS && ph.toLowerCase() === xS.toLowerCase()) continue;
    if (yS && ph.toLowerCase() === yS.toLowerCase()) continue;
    for (const r of findAllOccurrencesCI(body, ph)) ranges.push(r);
  }
  const merged = mergeSpanRanges(ranges);
  let html = "";
  let pos = 0;
  for (const span of merged) {
    html += escapeHtml(body.slice(pos, span.start));
    html += `<span class="focus-card__metric-em">${escapeHtml(body.slice(span.start, span.end))}</span>`;
    pos = span.end;
  }
  html += escapeHtml(body.slice(pos));
  return html.replace(/\n/g, "<br />");
}

/** Label + 5-segment patterned bar + |r| as percent (matches design reference). */
function buildCorrelationStrengthHtml(r) {
  if (r === null || r === undefined || Number.isNaN(Number(r))) {
    return "";
  }
  const pct =
    Math.round(Math.abs(Number(r)) * 100);
  const w = Math.min(100, Math.max(0, pct));
  const pctLabel = `${pct}%`;
  const aria = `Correlation strength, ${pct} percent`;
  const lineLabel = `Correlation strength: ${pctLabel}`;
  return `<div class="focus-card__correlation-strength" role="group" aria-label="${escapeHtml(aria)}">
                <span class="focus-card__correlation-strength-label">${escapeHtml(lineLabel)}</span>
                <div class="focus-card__correlation-strength-track" aria-hidden="true">
                  <div class="focus-card__correlation-strength-fill" style="width:${w}%"></div>
                </div>
              </div>`;
}

/** Mini bar SVG for focus-card chart column (decorative; r scales overall height). */
function correlationMiniChartSvg(r) {
  const mag = Math.min(1, Math.abs(r || 0));
  const rects = [];
  for (let i = 0; i < 10; i++) {
    const phase = 0.55 + 0.45 * Math.sin(i * 0.9 + mag * 3);
    const h = Math.round(18 + mag * 42 * phase);
    const y = 62 - h;
    rects.push(`<rect x="${i * 9}" y="${y}" width="7" height="${h}" fill="#f59e0b" opacity="0.85" rx="1"/>`);
  }
  const yLine = Math.round(22 + (1 - mag) * 28);
  const pts = [4, 15, 26, 37, 48, 59, 70, 81, 92].map((x, i) => `${x},${yLine + (i % 3 - 1) * 4}`).join(" ");
  return `<svg width="99" height="62" viewBox="0 0 99 62" fill="none" aria-hidden="true">${rects.join("")}
<polyline points="${pts}" stroke="rgba(255,255,255,0.55)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
}

/** Short label inside `.stage-category-tag__focus` (e.g. HRV, REM). */
const FOCUS_TAG_SHORT = {
  REM: "REM",
  LightSleep: "LIGHT",
  DeepSleep: "DEEP",
  Awake: "AWAKE",
  SleepEfficiency: "SLEEP",
  HRV: "HRV",
  RHR: "RHR",
  Disruptions: "DISRUPT",
  TotalSleep: "TOTAL",
};

function focusTagShort(targetMetric) {
  if (targetMetric && FOCUS_TAG_SHORT[targetMetric]) return FOCUS_TAG_SHORT[targetMetric];
  const s = String(targetMetric || "").replace(/([A-Z])/g, " $1").trim();
  return s ? s.toUpperCase().slice(0, 12) : "FOCUS";
}

const FOCUS_STAGE_CATEGORY_SVG = `<svg class="stage-category-tag__chart" width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 10.5V8M5 10.5V5.5M8 10.5V7M11 10.5V3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"></path></svg>`;

function buildFocusStackHtml(topThree, rawData) {
  return topThree.map((row, idx) => {
    const d = `d${(idx % 3) + 1}`;
    const tagText = focusTagShort(row.targetMetric);
    const sub = (row.how_it_works && row.how_it_works.trim()) ? row.how_it_works : "—";
    const leadRaw = (row.body && row.body.trim()) ? row.body : row.label;
    const leadTrim = leadRaw.trim();
    let vsAvg = buildOutcomeVsWindowAverageHtml(row, rawData);
    const leadForHighlight =
      vsAvg && leadTrim.endsWith(".") ? leadTrim.replace(/\.\s*$/, "") : leadRaw;
    if (vsAvg && !vsAvg.endsWith(".")) {
      vsAvg += ".";
    }
    return `
      <div class="focus-item reveal ${d}">
        <article class="card focus-card">
        <div class="focus-card__inner">
          <div class="focus-card__intro">
            <span class="stage-category-tag">
              ${FOCUS_STAGE_CATEGORY_SVG}
              <span class="stage-category-tag__focus">${escapeHtml(tagText)}</span>
            </span>
            <h3 class="focus-card__title">${escapeHtml(row.title)}</h3>
          </div>
          <div class="focus-card__content-row">
            <div class="focus-card__col focus-card__col--text">
              <div class="focus-card__body focus-card__body--plain">
                <p class="focus-card__plain-lead">${buildHighlightedLead(leadForHighlight, row.xStr, row.yStr, row.csvKey, row.label)}${vsAvg}</p>
                ${buildCorrelationStrengthHtml(row.r)}
                <details class="focus-card__plain-more">
                  <summary class="focus-card__plain-more-toggle">
                    <span class="focus-card__plain-more-text focus-card__plain-more-text--more">Why it matters</span>
                    <span class="focus-card__plain-more-text focus-card__plain-more-text--less">Hide</span>
                  </summary>
                  <p class="focus-card__plain-sub">${escapeHtml(sub).replace(/\n/g, "<br />")}</p>
                </details>
              </div>
            </div>
            <div class="focus-card__chart" aria-hidden="true">
              ${correlationMiniChartSvg(row.r)}
            </div>
          </div>
        </div>
      </article>
      </div>`;
  }).join("\n");
}

function injectFocusStackHtml(htmlPath, fragment) {
  const fs = require("fs");
  let html = fs.readFileSync(htmlPath, "utf8");
  const start = "<!-- FOCUS_STACK_CORRELATION_START -->";
  const end = "<!-- FOCUS_STACK_CORRELATION_END -->";
  if (html.includes(start) && html.includes(end)) {
    const re = new RegExp(`${start}[\\s\\S]*?${end}`, "m");
    html = html.replace(re, `${start}\n${fragment}\n${end}`);
  } else {
    console.warn("Markers FOCUS_STACK_CORRELATION_START/END not found; no HTML injection.");
    return;
  }
  fs.writeFileSync(htmlPath, html, "utf8");
}

if (typeof module !== "undefined" && require.main === module) {
  const fs   = require("fs");
  const path = require("path");

  /** Same idea as populate-health-report.mjs: inputs relative to this script’s folder. */
  const ROOT = __dirname;
  const DEFAULT_RAW_FILE = "raw_data_c.json";

  const argRaw = process.argv[2];
  let resolvedRaw;
  let baseDir;
  if (!argRaw) {
    resolvedRaw = path.join(ROOT, DEFAULT_RAW_FILE);
    baseDir = ROOT;
  } else if (path.isAbsolute(argRaw)) {
    resolvedRaw = path.resolve(argRaw);
    baseDir = path.dirname(resolvedRaw);
  } else {
    resolvedRaw = path.join(ROOT, argRaw);
    baseDir = ROOT;
  }

  if (!fs.existsSync(resolvedRaw)) {
    console.error(`Raw data not found: ${resolvedRaw}`);
    console.error(
      "Usage: node correlationAnalysis.js [raw_data.json] [correlation_cards_path]\n" +
        `  (default raw file: ${path.join(ROOT, DEFAULT_RAW_FILE)})`,
    );
    process.exit(1);
  }

  console.log(`Using raw data: ${resolvedRaw}`);
  const csvPath = process.argv[3] || path.join(baseDir, "correlation_cards - correlation_cards-2.csv");
  const normativePath = path.join(baseDir, "normative_metrics.json");
  const top10Path = path.join(baseDir, "top10_percent.json");

  const rawData = JSON.parse(fs.readFileSync(resolvedRaw, "utf8"));
  const results = runCorrelationAnalysis(rawData);

  for (const [metricLabel, rows] of Object.entries(results)) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TARGET: ${metricLabel}`);
    console.log("=".repeat(60));

    for (const row of rows) {
      if (row.r === null) continue;
      const sig = row.significant ? " ✓" : "  ";
      const margin = (Math.abs(row.r) - Math.abs(row.threshold)).toFixed(3);
      console.log(`  ${sig}  ${row.r.toFixed(3).padStart(7)}  |r|-|τ|=${margin}  (n=${String(row.n).padStart(2)})  ${row.label}`);
    }
  }

  const outPath = path.join(baseDir, "correlation_results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nJSON written to: ${outPath}`);

  if (fs.existsSync(csvPath)) {
    const cardMap = parseCorrelationCardsCsv(fs.readFileSync(csvPath, "utf8"));
    const resolved = buildResolvedCorrelationRows(rawData, cardMap);
    const rankedPath = path.join(baseDir, "correlation_cards_resolved.json");
    fs.writeFileSync(rankedPath, JSON.stringify(resolved, null, 2), "utf8");
    console.log(`Resolved cards (ranked): ${rankedPath}`);

    const normative = fs.existsSync(normativePath)
      ? JSON.parse(fs.readFileSync(normativePath, "utf8"))
      : null;
    const top10 = fs.existsSync(top10Path)
      ? JSON.parse(fs.readFileSync(top10Path, "utf8"))
      : null;

    const globalPriority = buildGlobalMetricPriority(rawData, normative, top10);
    console.log("\n  Global metric priority:");
    for (let i = 0; i < globalPriority.length; i++) {
      const e = globalPriority[i];
      const detail = e.tier === 1 ? `deficit=${e.deficit.toFixed(3)}`
        : e.tier === 2 ? `gap=${e.gap.toFixed(3)}`
        : e.tier === 3 || e.tier === 4 ? `inRange=${e.daysInRangePct.toFixed(1)}%`
        : `supplement=${e.fixedSupplement}`;
      console.log(`    ${i + 1}. [tier ${e.tier}] ${e.metric}  ${detail}  tag=${e.tag}`);
    }

    const { picks, tagMap } = resolveTop4WithCorrelations(globalPriority, resolved, cardMap);
    console.log("\n  Final top-4 picks:");
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const corrLabel = p.matchedRow ? p.matchedRow.label : "(no correlation)";
      const roll = p.matchedRow && rowUsesSevenDayRolling(p.matchedRow) ? "rolling7" : "daily";
      console.log(`    ${i + 1}. [tier ${p.tier}] ${p.metric} → tag=${p.tag}  ${roll}  ${corrLabel}`);
    }

    const focusPicks = picks.map((p) => {
      if (p.matchedRow) {
        return { ...p.matchedRow, targetMetric: p.metric, _tag: p.tag, _tier: p.tier };
      }
      const fallbackIv = DEFAULT_TAG[p.metric] || p.tag;
      return {
        label: `${p.metric} fallback`,
        targetMetric: p.metric,
        r: null, n: null, nBracket: null,
        direction: null, threshold: null,
        supplements: [fallbackIv],
        significant: false,
        marginScore: -1e9,
        title: `Improve your ${p.metric}`,
        body: "",
        how_it_works: "",
        xRaw: null, yRaw: null, xStr: "—", yStr: "—",
        csvKey: null,
        _tag: p.tag,
        _tier: p.tier,
        _csvGraph: p.csvGraph,
      };
    });

    const researchPath = path.join(baseDir, "metrics_supplement_research copy 5.json");
    const tiersPath = path.join(baseDir, "supplement_research_tiers.json");
    let researchData = null;
    let perPickSupplements = focusPicks.map(() => ({ mostResearched: null, emergingResearch: null }));
    if (fs.existsSync(researchPath) && fs.existsSync(tiersPath)) {
      researchData = JSON.parse(fs.readFileSync(researchPath, "utf8"));
      const tiers = JSON.parse(fs.readFileSync(tiersPath, "utf8"));
      perPickSupplements = assignFocusSupplementsWithUniqueness(focusPicks, researchData, tiers);
    }

    function classifyFocusGraphType(pick) {
      const key = `${pick?.csvKey || ""} ${pick?.label || ""}`.toLowerCase();
      const tier = pick?._tier ?? null;
      // 1) Replace with 7-day average correlation if matched row is rolling
      if (/rolling mean|7-day|rolling/.test(key)) return "7day_average";
      // 2) Replace with single correlation for direct (t)/(t-1) relations
      if (/\(t-1\)|\(t\)/.test(key)) return "single_correlation";
      // 3) Default by tier — Tier 5 uses its specific graph slot key from TIER5_SLOT_ORDER
      if (tier === 3 || tier === 4) return "variance";
      if (tier === 5) return pick._csvGraph || "healthspan";
      return "cohort"; // tiers 1/2 (and fallback)
    }

    // Filter and cap rules (apply before writing JSON):
    //   - A Tier 5 pick with no assignable supplement (both slots null) is dropped
    //     entirely. The next Tier 5 candidate in graph order is used as backfill.
    //   - Final card count is capped at FOCUS_CARD_LIMIT.
    //   - Tier 1–4 picks are never skipped here (validation at the bottom throws
    //     if a Tier 1–4 card ends up with zero supplements).
    const FOCUS_CARD_LIMIT = 4;
    const keptIndices = [];
    for (let i = 0; i < focusPicks.length; i++) {
      if (keptIndices.length >= FOCUS_CARD_LIMIT) break;
      const pick = focusPicks[i];
      const sup = perPickSupplements[i] || {};
      const isTier5 = (pick._tier ?? null) === 5;
      const hasAny = !!(
        sup.mostResearched?.supplement || sup.emergingResearch?.supplement
      );
      if (isTier5 && !hasAny) continue;
      keptIndices.push(i);
    }

    const focusMetricsTagsSupplements = keptIndices.map((srcIdx, newIdx) => {
      const pick = focusPicks[srcIdx];
      const tm = pick.targetMetric;
      const graphType = classifyFocusGraphType(pick);
      return {
        order: newIdx + 1,
        metric: tm,
        tag: pick._tag ?? null,
        tier: pick._tier ?? null,
        graph_type: graphType,
        correlation_source: pick.csvKey || pick.label || null,
        researchKey:
          researchData && tm
            ? researchKeyForSupplementLookup(pick._tag, tm, researchData)
            : null,
        supplements: {
          mostResearched: perPickSupplements[srcIdx]?.mostResearched ?? null,
          emergingResearch: perPickSupplements[srcIdx]?.emergingResearch ?? null,
        },
      };
    });

    // Acceptance checks: every card has ≥1 supplement AND no supplement repeats.
    assertEveryFocusCardHasSupplements(focusMetricsTagsSupplements);
    assertNoDuplicateFocusSupplements(focusMetricsTagsSupplements);

    const focusOutPath = path.join(baseDir, "focus_metrics_tags_supplements.json");
    fs.writeFileSync(focusOutPath, JSON.stringify(focusMetricsTagsSupplements, null, 2), "utf8");
    console.log("\n  Focus picks — metrics, tags, supplements:");
    console.log(JSON.stringify(focusMetricsTagsSupplements, null, 2));
    console.log(`  (also written to ${focusOutPath})`);
  } else {
    console.warn(`CSV not found: ${csvPath} — skip card resolution / HTML.`);
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    runCorrelationAnalysis,
    buildResolvedCorrelationRows,
    parseCorrelationCardsCsv,
    labelToCsvKey,
    bracketStats,
    computePearsonR,
    lagSeries,
    rollingMean,
    autocorrelationLag1,
    getSeries,
    getActivitySeries,
    extractAllSeries,
    isSignificant,
    METRIC_CONFIGS,
    pickDiverseTopCorrelations,
    pickTopByUniqueIntervention,
    finalizeFocusPicksWithSleepHierarchy,
    pickFocusCardsHopcroftKarp,
    pickFocusCardsByPriorityDeficit,
    hopcroftKarpMatching,
    buildInterventionTargetMetricEdges,
    rowUsesSevenDayRolling,
    interventionKeyFromRow,
    formatInterventionForDisplay,
    normalizeMetricSide,
    parseLabelMetricKeys,
    hungarianAssignment,
    assignSupplementsToFocusCards,
    assignFocusSupplementsWithUniqueness,
    assertEveryFocusCardHasSupplements,
    assertNoDuplicateFocusSupplements,
    TIER5_SUPPLEMENT_PRIORITY,
    CSV_GRAPH_TO_SUPPLEMENT_SLOT,
    researchKeyForSupplementLookup,
    TARGET_METRIC_TO_RESEARCH_KEY,
    buildGlobalMetricPriority,
    resolveTop4WithCorrelations,
    CANDIDATE_METRICS,
    DEFAULT_TAG,
    LOWER_IS_BETTER,
  };
}
