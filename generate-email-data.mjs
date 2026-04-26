import { readFileSync, writeFileSync } from 'fs';

const inputPath  = process.argv[2] ?? 'report_data.json';
const outputPath = process.argv[3] ?? 'email_data.json';

const data = JSON.parse(readFileSync(inputPath, 'utf8'));
const { meta, health_score, limiting_metrics } = data;

// ─── helpers ──────────────────────────────────────────────────────────────────

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

function parseReportMonth(dateRange) {
  // e.g. "Mar 14–Apr 12, 2026 · Whoop · Men · 26–35"
  // Take everything after the first en-dash, then before the first " · "
  const dashIdx = dateRange.indexOf('\u2013');
  const afterDash = dashIdx === -1 ? dateRange : dateRange.slice(dashIdx + 1);
  const endDateStr = afterDash.split(' \u00b7 ')[0].trim(); // "Apr 12, 2026"
  const date = new Date(endDateStr);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const DEVICE_NAMES = {
  whoop:       'Whoop',
  oura:        'Oura',
  apple_watch: 'Apple Watch',
  garmin:      'Garmin',
  fitbit:      'Fitbit',
};

function deviceDisplayName(device) {
  return DEVICE_NAMES[device]
    ?? device.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const TONE_MAP = {
  '95-100': 'an exceptional baseline',
  '90-94':  'a strong profile',
  '85-89':  'a solid profile',
  '80-84':  'a strong base',
  '70-79':  'good progress',
  '60-69':  'a promising base',
  '50-59':  'early momentum',
  'below-50': 'a starting point',
};

const DOT_HEX = {
  red:    '#ef4444',
  amber:  '#f59e0b',
  yellow: '#f59e0b',
  orange: '#f97316',
  green:  '#22c55e',
};

function dotColor(dot) {
  return DOT_HEX[dot] ?? '#6b7280';
}

function recipientFromTitle(title) {
  const stripped = title.replace(/[\u2019']s Report$/, '');
  return stripped === 'Your' ? 'there' : stripped;
}

// ─── derived values ────────────────────────────────────────────────────────────

const scoreBefore = health_score.score;

/**
 * Email merge: optimistic "points to unlock" from current health score (not limiting flags).
 * <30: +20; 30–60: +15; 61–79: +10; 80–90: +min(10, max(0, 95−score)); >90 & <99: set to 99; ≥99: +0.
 */
function emailScoreBoost(s) {
  const score = Number(s);
  if (!Number.isFinite(score)) return { scoreAfter: s, pointsGained: 0 };
  if (score < 30) return { scoreAfter: score + 20, pointsGained: 20 };
  if (score <= 60) return { scoreAfter: score + 15, pointsGained: 15 };
  if (score <= 79) return { scoreAfter: score + 10, pointsGained: 10 };
  if (score <= 90) {
    const delta = Math.min(10, Math.max(0, 95 - score));
    return { scoreAfter: score + delta, pointsGained: delta };
  }
  if (score < 99) {
    const delta = 99 - score;
    return { scoreAfter: 99, pointsGained: delta };
  }
  return { scoreAfter: score, pointsGained: 0 };
}

const { scoreAfter, pointsGained } = emailScoreBoost(scoreBefore);

const flag = (i, key) => limiting_metrics[i]?.[key] ?? '';

// ─── output ───────────────────────────────────────────────────────────────────

const output = {
  MERGE27: scoreBefore,
  MERGE28: parseReportMonth(meta.date_range),
  MERGE29: scoreAfter,
  MERGE30: pointsGained > 0 ? `+${pointsGained}` : `${pointsGained}`,
  MERGE31: deviceDisplayName(meta.device),
  MERGE32: ordinal(health_score.health_metrics_percentile),
  MERGE33: meta.cohort_label,
  MERGE34: TONE_MAP[health_score.score_band_id] ?? 'good progress',
  MERGE35: scoreAfter,
  MERGE36: flag(0, 'name'),
  MERGE37: flag(1, 'name'),
  MERGE38: flag(2, 'name'),
  MERGE39: flag(0, 'badge'),
  MERGE40: flag(1, 'badge'),
  MERGE41: flag(2, 'badge'),
  MERGE42: dotColor(flag(0, 'dot')),
  MERGE43: dotColor(flag(1, 'dot')),
  MERGE44: dotColor(flag(2, 'dot')),
  MERGE45: '30-day money-back guarantee',
  MERGE46: recipientFromTitle(meta.report_title),
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`Written to ${outputPath}`);
console.log(JSON.stringify(output, null, 2));
