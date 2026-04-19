#!/usr/bin/env node
/**
 * Rewrites daily_activity day rows from flat { total_duration, average_intensity }
 * to { total: { total_duration, average_intensity }, ...rest }.
 * Idempotent: skips days that already have .total with duration/intensity keys.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function nestDailyActivityBlock(da) {
  if (!da || typeof da !== 'object' || Array.isArray(da)) return da;
  const out = {};
  for (const [k, day] of Object.entries(da)) {
    if (!day || typeof day !== 'object' || Array.isArray(day)) {
      out[k] = day;
      continue;
    }
    if (day.total != null && typeof day.total === 'object') {
      const t = day.total;
      if ('total_duration' in t || 'average_intensity' in t) {
        out[k] = day;
        continue;
      }
    }
    if (!('total_duration' in day) && !('average_intensity' in day)) {
      out[k] = day;
      continue;
    }
    const { total_duration, average_intensity, ...rest } = day;
    out[k] = {
      ...rest,
      total: {
        total_duration: total_duration ?? null,
        average_intensity: average_intensity ?? null,
      },
    };
  }
  return out;
}

function walk(o) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) {
    for (const x of o) walk(x);
    return;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'daily_activity' && v && typeof v === 'object' && !Array.isArray(v)) {
      o[k] = nestDailyActivityBlock(v);
    } else {
      walk(v);
    }
  }
}

const files = [
  'raw_data2.json',
  'raw_data.json',
  'extraction_Max_Elbourn_garmin_APR_2026.json',
];

for (const rel of files) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    console.warn('skip (missing):', rel);
    continue;
  }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  walk(j);
  fs.writeFileSync(p, `${JSON.stringify(j, null, 4)}\n`, 'utf8');
  console.log('nested daily_activity in', rel);
}
