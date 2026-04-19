#!/usr/bin/env node
/**
 * Writes raw_data3.json — synthetic 30-day metrics targeting health score 90+.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const N = 30;
const keys = Array.from({ length: N }, (_, i) => String(i + 1));

function mapSeries(fn) {
  const o = {};
  for (const k of keys) o[k] = fn(+k);
  return o;
}

const dateStart = new Date('2026-01-01T12:00:00Z');
const date_keys = keys.map((_, i) => {
  const d = new Date(dateStart);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

const SLEEP = 30600;
const AWAKE = 918;
const LIGHT = 13770;
const DEEP = 6732;
const REM = SLEEP - AWAKE - LIGHT - DEEP;

const viz = {
  meta: {
    device: 'garmin',
    user_id: 'synthetic-high-score',
    start_date: date_keys[0],
    end_date: date_keys[N - 1],
    num_days: N,
    day_index_1_is_oldest: true,
    age: 30,
    gender: 'male',
    max_HR_computed: 190,
    date_keys,
    hr_zones_percent_of_max_hr: {
      zone_0: '[0%, 50%)',
      zone_1: '[50%, 60%)',
      zone_2: '[60%, 70%)',
      zone_3: '[70%, 80%)',
      zone_4: '[80%, 90%)',
      zone_5: '[90%, +inf)',
      note: 'Synthetic fixture (raw_data3.json)',
    },
  },
  metrics: {
    recovery: mapSeries(() => 95),
    sleep_score: mapSeries(() => 92),
    rem_sleep: mapSeries(() => REM),
    deep_sleep: mapSeries(() => DEEP),
    awake_time: mapSeries(() => AWAKE),
    light_sleep: mapSeries(() => LIGHT),
    disturbances: mapSeries(() => 1),
    HRV: mapSeries(() => 105),
    respiratory_rate: mapSeries(() => 15.5),
    sleep_efficiency: mapSeries(() => 0.98),
    sleep_time: mapSeries(() => SLEEP),
    start_time: mapSeries(() => '22:30:00'),
    end_time: mapSeries(() => '07:00:00'),
    spo2_percentage: mapSeries(() => 97),
    RHR: mapSeries(() => 44),
    vo2_max: mapSeries(() => 56),
  },
  daily_activity: Object.fromEntries(
    keys.map((k) => [k, { total: { total_duration: 3600, average_intensity: 1.45 } }]),
  ),
  total_activity: {
    running: {
      total_duration: 54000,
      total: 20,
      time_zone_0: 2000,
      time_zone_1: 3000,
      time_zone_2: 10000,
      time_zone_3: 20000,
      time_zone_4: 15000,
      time_zone_5: 4000,
    },
  },
};

const out = {
  connect_device_recommendation: {
    metric_analysis: {
      device: 'garmin',
      raw_sleep_records_count: N,
      raw_activity_records_count: N,
      raw_dailies_records_count: N,
      window_note: 'Synthetic high-score dataset (raw_data3.json) for Nutricode health report.',
      generated_at: new Date().toISOString(),
      visualization: viz,
    },
    supplement_recommendation: {
      items: [],
      rationale: 'Stub; report metrics are under metric_analysis.visualization.',
      version: 1,
      based_on: {
        device: 'garmin',
        generated_at: new Date().toISOString(),
      },
    },
  },
  info: {
    device: 'garmin',
    user_id: 'synthetic-high-score',
    email: null,
    height_cm: null,
    weight_kg: null,
    body_measurement_source: null,
  },
};

fs.writeFileSync(path.join(__dirname, 'raw_data3.json'), JSON.stringify(out, null, 4), 'utf8');
console.log('Wrote raw_data3.json');
