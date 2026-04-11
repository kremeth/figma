/**
 * Builds supplement_hungarian_cost_matrix.json for Hungarian (min-cost) assignment.
 * Rows: mostResearched supplements + dummy rows to square the matrix.
 * Cols: metrics from metrics_supplement_research*.json (excluding non-metric root keys).
 */

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const RESEARCH_FILE = path.join(DIR, "metrics_supplement_research copy 5.json");
const TIERS_FILE = path.join(DIR, "supplement_research_tiers.json");
const OUT_FILE = path.join(DIR, "supplement_hungarian_cost_matrix.json");

function isMetricBlock(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function main() {
  const data = JSON.parse(fs.readFileSync(RESEARCH_FILE, "utf8"));
  const tiers = JSON.parse(fs.readFileSync(TIERS_FILE, "utf8"));
  const supplements = tiers.mostResearched;

  const metrics = Object.keys(data).filter((k) => isMetricBlock(data[k]));

  let maxS = 0;
  for (const m of metrics) {
    const o = data[m];
    for (const s of Object.keys(o)) {
      const sc = o[s] && o[s].supplement_score;
      if (typeof sc === "number" && !Number.isNaN(sc)) maxS = Math.max(maxS, sc);
    }
  }
  const S_MAX = Math.ceil(maxS * 100) / 100;
  const K = S_MAX + 1000;

  function cell(s, m) {
    const entry = data[m] && data[m][s];
    const sc = entry && entry.supplement_score;
    if (typeof sc === "number" && !Number.isNaN(sc)) return +(S_MAX - sc).toFixed(4);
    return K;
  }

  const matReal = supplements.map((s) => metrics.map((m) => cell(s, m)));
  const nPad = metrics.length - supplements.length;
  if (nPad < 0) {
    throw new Error(
      `more mostResearched supplements (${supplements.length}) than metrics (${metrics.length})`
    );
  }
  const dummyRow = metrics.map(() => 0);
  const costMatrix = [...matReal];
  for (let i = 0; i < nPad; i++) costMatrix.push([...dummyRow]);

  const out = {
    description:
      "Hungarian minimizes total cost. Real cost = S_MAX - supplement_score; missing/null = K. Dummy rows (all 0) absorb metrics left unpaired with a real supplement.",
    S_MAX,
    K,
    missingCost: K,
    rowLabels: [
      ...supplements,
      ...Array.from({ length: nPad }, (_, i) => `__dummy_${i + 1}`),
    ],
    colLabels: metrics,
    costMatrix,
    supplementScoreMatrix: supplements.map((s) =>
      metrics.map((m) => {
        const entry = data[m] && data[m][s];
        const sc = entry && entry.supplement_score;
        return typeof sc === "number" && !Number.isNaN(sc) ? sc : null;
      })
    ),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE} (${costMatrix.length}x${metrics.length}), S_MAX=${S_MAX}`);
}

main();
