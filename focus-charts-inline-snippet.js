/**
 * Focus charts — injected after `const FOCUS_SLOTS = [...]` by populate-health-report.mjs
 */

/** Keeps axis tick labels at a fixed CSS pixel size regardless of viewBox / container width. */
const __nutricodeFocusChartFontPxBindings = new WeakMap();

function nutricodeFocusChartTickFontTargetPx() {
  return window.matchMedia('(min-width: 600px)').matches ? 10 : 8;
}

function nutricodeBindFocusChartAxisFontPx(svg) {
  if (!svg || svg.namespaceURI !== 'http://www.w3.org/2000/svg' || svg.tagName !== 'svg') return;
  const prev = __nutricodeFocusChartFontPxBindings.get(svg);
  if (prev) {
    if (prev.ro) prev.ro.disconnect();
    if (prev.onWin) window.removeEventListener('resize', prev.onWin);
    if (prev.mq && prev.mqCb) {
      if (prev.mq.removeEventListener) prev.mq.removeEventListener('change', prev.mqCb);
      else if (prev.mq.removeListener) prev.mq.removeListener(prev.mqCb);
    }
    if (prev.st && prev.st.raf) cancelAnimationFrame(prev.st.raf);
  }
  const st = { raf: 0 };
  const sync = () => {
    st.raf = 0;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !(vb.width > 0) || !(vb.height > 0)) return;
    /* Chart slot size is fixed in CSS (#focusCarousel --focus-chart-ar-*); flush layout before CTM. */
    void svg.getBoundingClientRect();
    let spuu = null;
    try {
      const m = svg.getScreenCTM();
      if (m) {
        const dx = Math.hypot(m.a, m.b);
        const dy = Math.hypot(m.c, m.d);
        if (dx > 0 && dy > 0 && Number.isFinite(dx) && Number.isFinite(dy)) spuu = (dx + dy) / 2;
      }
    } catch (_) {
      /* ignore */
    }
    if (spuu == null || !(spuu > 0)) {
      const r = svg.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      spuu = Math.min(r.width / vb.width, r.height / vb.height);
    }
    const targetPx = nutricodeFocusChartTickFontTargetPx();
    const fsUser = targetPx / spuu;
    const fsStr = (+fsUser.toFixed(4)).toString();
    svg.querySelectorAll('text').forEach((el) => {
      el.setAttribute('font-size', fsStr);
    });
  };
  const schedule = () => {
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = requestAnimationFrame(sync);
  };
  const onWin = () => schedule();
  window.addEventListener('resize', onWin, { passive: true });
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => schedule());
    ro.observe(svg);
  }
  const mq = window.matchMedia('(min-width: 600px)');
  const mqCb = () => schedule();
  if (mq.addEventListener) mq.addEventListener('change', mqCb);
  else mq.addListener(mqCb);
  __nutricodeFocusChartFontPxBindings.set(svg, { ro, onWin, st, mq, mqCb });
  schedule();
  requestAnimationFrame(() => requestAnimationFrame(sync));
}

function nutricodeDrawFocusRem(svg, data, slotIdx) {
    const FONT = "'JetBrains Mono', ui-monospace, monospace";
    const TICK_SOFT = '#b7bcc6';
    const TICK = '#9ca3af';
    const AVG_LINE = '#9ca3af';

    const vbMinX = 14;
    const vbMinY = 38;
    const vbW = 269;
    const vbH = 140;
    const plotLeft = 42;
    const plotRight = 279;
    const plotTop = 42;
    const plotBottom = 158;
    const yLabelX = 30;
    const xDayLabelY = 170;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    const ageToRemBracket = age => {
      if (age == null || !Number.isFinite(+age)) return '26-35';
      const a = +age;
      if (a <= 25) return '18-25';
      if (a <= 35) return '26-35';
      if (a <= 45) return '36-45';
      if (a <= 55) return '46-55';
      if (a <= 65) return '56-65';
      return '66+';
    };

    const deriveRemPercentilesFromP50 = p50 => {
      const p50n = +p50;
      if (!Number.isFinite(p50n)) return { p50: 21, p30: 18.2, p60: 22.2, p90: 26.0 };
      return {
        p50: p50n,
        p30: Math.max(5, Math.round((p50n - 2.8) * 10) / 10),
        p60: Math.min(50, Math.round((p50n + 1.2) * 10) / 10),
        p90: Math.min(50, Math.round((p50n + 5.0) * 10) / 10),
      };
    };

    const remFillForCohortPct = (pct, p30, p60, p90, lowerIsBetter) => {
      if (lowerIsBetter) {
        if (pct <= p30) return '#5da9c8';
        if (pct <= p60) return '#34c759';
        if (pct <= p90) return '#ff9f0a';
        return '#ff0000';
      }
      if (pct < p30) return '#ff0000';
      if (pct < p60) return '#ff9f0a';
      if (pct < p90) return '#34c759';
      return '#5da9c8';
    };

    const remBandDesc = (pct, p30, p60, p90, lowerIsBetter) => {
      if (lowerIsBetter) {
        if (pct <= p30) return 'top cohort range';
        if (pct <= p60) return 'good cohort range';
        if (pct <= p90) return 'below median cohort range';
        return 'lowest cohort range';
      }
      if (pct < p30) return '0–30th percentile vs cohort';
      if (pct < p60) return '30–60th percentile vs cohort';
      if (pct < p90) return '60–90th percentile vs cohort';
      return '90th percentile or above vs cohort';
    };

    const niceStepPercent = (range, targetTicks) => {
      const rough = Math.max(range, 0.0001) / Math.max(1, targetTicks - 1);
      const pow = 10 ** Math.floor(Math.log10(rough));
      const err = rough / pow;
      const f = err <= 1 ? 1 : err <= 2 ? 2 : err <= 2.5 ? 2.5 : err <= 5 ? 5 : 10;
      return f * pow;
    };

    const seed = s => {
      let x = s;
      return () => {
        x = Math.sin(x) * 10000;
        return x - Math.floor(x);
      };
    };

    const _fc1 = data;
    const metricLabel = String(_fc1.metricLabel || 'REM sleep');
    const baselineLabel = String(_fc1.baselineLabel || 'demographic average');
    const unitLabel = String(_fc1.unitLabel || '%');
    const lowerIsBetter = Boolean(_fc1.lowerIsBetter);
    let numDays = Math.max(1, Math.min(31, +_fc1.numDays || 30));
    let dailyPct = Array.isArray(_fc1.dailyPct) ? _fc1.dailyPct.slice() : [];
    let remPctiles = _fc1.remPctiles && typeof _fc1.remPctiles === 'object'
      ? { ...deriveRemPercentilesFromP50(21), ..._fc1.remPctiles }
      : deriveRemPercentilesFromP50(21);
    let demographicPct = +_fc1.demographicPct || remPctiles.p50;
    let metaGender = _fc1.metaGender === 'female' ? 'female' : 'male';
    let metaAge = +_fc1.metaAge;
    if (!Number.isFinite(metaAge)) metaAge = 30;

    let validPct = dailyPct.filter(v => v != null && Number.isFinite(v));
    if (validPct.length < 2) {
      const rng = seed(19);
      numDays = 28;
      dailyPct = Array.from({ length: numDays }, () => +(16 + rng() * 14).toFixed(2));
      validPct = dailyPct.slice();
      remPctiles = deriveRemPercentilesFromP50(21);
      demographicPct = remPctiles.p50;
    }

    // Only use actual data + cohort median for the axis range — percentile thresholds (p30/p90)
    // only control bar colors and should not inflate the scale.
    let yMin = Math.min(...validPct, demographicPct);
    let yMax = Math.max(...validPct, demographicPct);
    const pad = Math.max(1.5, (yMax - yMin) * 0.15);
    yMin = Math.max(0, yMin - pad);
    yMax = unitLabel === '%' ? Math.min(100, yMax + pad) : yMax + pad;
    if (yMax - yMin < 6) {
      const mid = (yMax + yMin) / 2;
      yMin = Math.max(0, mid - 3);
      yMax = unitLabel === '%' ? Math.min(100, mid + 3) : mid + 3;
    }
    if (yMax - yMin < 1e-6) {
      yMin = Math.max(0, yMin - 2);
      yMax = yMax + 2;
    }

    let step = niceStepPercent(yMax - yMin, 5);
    let yTickStart = Math.floor(yMin / step) * step;
    let yTickEnd = Math.ceil(yMax / step) * step;
    while (step > 0 && (yTickEnd - yTickStart) / step > 9) {
      step *= 2;
      yTickStart = Math.floor(yMin / step) * step;
      yTickEnd = Math.ceil(yMax / step) * step;
    }

    const yTicks = [];
    for (let v = yTickEnd; v >= yTickStart - step * 0.25; v -= step) {
      yTicks.push(+v.toFixed(6));
      if (yTicks.length > 14) break;
    }

    const ySpan = Math.max(1e-6, yMax - yMin);
    const scaleY = pct => plotBottom - ((pct - yMin) / ySpan) * plotH;
    const demoY = scaleY(demographicPct);

    const topTickY = yTicks.length > 0 ? scaleY(yTicks[0]) : plotTop;
    const dynVbMinY = Math.min(vbMinY, Math.floor(topTickY) - 10);
    const dynVbH = (xDayLabelY + 6) - dynVbMinY;

    const slotW = plotW / numDays;
    const barW = Math.max(2, slotW * 0.7);
    const { p30: rp30, p60: rp60, p90: rp90 } = remPctiles;
    const bars = dailyPct
      .map((pct, i) => {
        if (pct == null || !Number.isFinite(pct)) return '';
        const x = plotLeft + i * slotW + (slotW - barW) / 2;
        const yTop = scaleY(pct);
        const h = Math.max(0, plotBottom - yTop);
        if (h < 0.5) return '';
        const fill = remFillForCohortPct(pct, rp30, rp60, rp90, lowerIsBetter);
        const band = remBandDesc(pct, rp30, rp60, rp90, lowerIsBetter);
        return `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1.2" fill="${fill}"><title>Day ${i + 1} · ${(+pct).toFixed(1)}${unitLabel} ${metricLabel} · ${band}</title></rect>`;
      })
      .join('');

    const yLabels = yTicks
      .map(v => {
        const y = scaleY(v);
        const label = unitLabel === '%' || unitLabel === 'ms' || unitLabel === 'bpm' ? Math.round(v) : (+v).toFixed(1);
        return `<text x="${yLabelX}" y="${(y + 3).toFixed(2)}" font-size="8" fill="${TICK_SOFT}" text-anchor="end" font-family="${FONT}">${label}${unitLabel}</text>`;
      })
      .join('');

    const tickStep = Math.max(1, Math.ceil(numDays / 10));
    const xDayIndices = [];
    for (let d = 1; d <= numDays; d += tickStep) xDayIndices.push(d);
    if (xDayIndices[xDayIndices.length - 1] !== numDays) xDayIndices.push(numDays);

    const xLabels = xDayIndices
      .map(d => {
        const i = d - 1;
        const cx = plotLeft + (i + 0.5) * slotW;
        return `<text x="${cx.toFixed(2)}" y="${xDayLabelY}" font-size="8" fill="${TICK}" text-anchor="middle" font-family="${FONT}">${String(d).padStart(2, '0')}</text>`;
      })
      .join('');

    const avgLine = `<line x1="${plotLeft}" y1="${demoY.toFixed(2)}" x2="${plotRight}" y2="${demoY.toFixed(2)}" stroke="${AVG_LINE}" stroke-width="0.5" stroke-dasharray="4 3" stroke-linecap="round" opacity="0.95" vector-effect="non-scaling-stroke"/>`;

    svg.setAttribute(
      'aria-label',
      `Daily ${metricLabel} over ${numDays} days; bars colored by cohort percentile band (red 0–30, yellow 30–60, green 60–90, blue 90+). Reference near ${Math.round(demographicPct)}${unitLabel}`,
    );

    svg.innerHTML = `
      <title>Daily ${metricLabel} versus ${baselineLabel}</title>
      <desc>Bars: nightly ${metricLabel}. Fill by approximate cohort percentile for age ${metaAge} (${metaGender}): red below ${rp30}${unitLabel}, yellow ${rp30}${unitLabel}–${rp60}${unitLabel}, green ${rp60}${unitLabel}–${rp90}${unitLabel}, blue at or above ${rp90}${unitLabel} (normative_metrics.json). Dashed line: ${baselineLabel} near ${demographicPct.toFixed(1)}${unitLabel}.</desc>
      ${yLabels}
      ${bars}
      ${avgLine}
      ${xLabels}
    `;

    svg.setAttribute('viewBox', `${vbMinX} ${dynVbMinY} ${vbW} ${dynVbH}`);
    nutricodeBindFocusChartAxisFontPx(svg);
    if (typeof scheduleEqualizeFocusCorrelationSections === 'function') scheduleEqualizeFocusCorrelationSections();
}

function nutricodeDrawFocusDeepInt(svg, data, slotIdx) {
    const FONT = "'JetBrains Mono', ui-monospace, monospace";
    const BLUE = '#0071e3';
    const YELLOW = '#ffd60a';
    const ORANGE = '#ff9500';
    const PT_FILTER_ID = 'fc2DualPtSh' + slotIdx;
    const GRID = 'rgba(0, 0, 0, 0.08)';
    const TICK_X = '#86868b';
    const H = 210;
    /* Side gutters so y-axis labels stay inside viewBox (avoids clipping on narrow viewports). */
    const plotInsetX = 42;
    const plotW = 316; /* same plot width as original 340 - 2*12 */
    const W = plotInsetX * 2 + plotW;
    const leftLabelX = plotInsetX - 6;
    const rightLabelX = W - plotInsetX + 6;
    const padT = 16;
    const padB = 34; /* room for x labels + gap so lines don’t crowd day ticks */
    const ph = H - padT - padB;
    const plotFloorGap = 6; /* inset above nominal bottom: stroke caps + x-axis clearance */
    const yPlotTop = padT;
    const yPlotBottom = padT + ph - plotFloorGap;
    const plotH = yPlotBottom - yPlotTop;

    const seed = s => {
      let x = s;
      return () => {
        x = Math.sin(x) * 10000;
        return x - Math.floor(x);
      };
    };

    const _fc2 = data;
    const metricLabel = String(_fc2.metricLabel || 'Deep Sleep');
    const leftUnit = String(_fc2.leftUnit || '%');
    let deepDaily = Array.isArray(_fc2.metricDaily)
      ? _fc2.metricDaily.map((v) => (v == null ? null : +v))
      : Array.isArray(_fc2.deepDaily)
        ? _fc2.deepDaily.map((v) => (v == null ? null : +v))
        : Array(30).fill(null);
    let intensityDaily = Array.isArray(_fc2.intensityDaily) ? _fc2.intensityDaily.map((v) => (v == null ? null : +v)) : Array(30).fill(null);
    while (deepDaily.length < 30) deepDaily.push(null);
    while (intensityDaily.length < 30) intensityDaily.push(null);
    deepDaily = deepDaily.slice(0, 30);
    intensityDaily = intensityDaily.slice(0, 30);

    const rng = seed(29);
    const hasDeep = deepDaily.some(v => v != null && Number.isFinite(v));
    const hasInt = intensityDaily.some(v => v != null && Number.isFinite(v));
    if (!hasDeep || !hasInt) {
      for (let i = 0; i < 30; i += 1) {
        deepDaily[i] = +(15 + Math.sin(i / 3.5) * 1.4 + (rng() - 0.5) * 0.9).toFixed(2);
        intensityDaily[i] = +(1.32 - i * 0.005 + Math.sin(i / 2.8) * 0.1 + (rng() - 0.5) * 0.035).toFixed(2);
      }
    }

    const validD = deepDaily.filter(v => v != null && Number.isFinite(v));
    const validI = intensityDaily.filter(v => v != null && Number.isFinite(v));

    /* Trim top/bottom 5 % of each series to suppress outlier spikes */
    const trimmedRange = arr => {
      if (arr.length < 4) return [Math.min(...arr), Math.max(...arr)];
      const sorted = [...arr].sort((a, b) => a - b);
      const cut = Math.max(1, Math.floor(sorted.length * 0.05));
      return [sorted[cut], sorted[sorted.length - 1 - cut]];
    };
    const [rawMinD, rawMaxD] = trimmedRange(validD);
    const [rawMinI, rawMaxI] = trimmedRange(validI);

    let minD = rawMinD;
    let maxD = rawMaxD;
    let minI = rawMinI;
    let maxI = rawMaxI;

    const padDy = Math.max(0.25, (maxD - minD) * 0.08);
    const padIy = Math.max(0.02, (maxI - minI) * 0.08);
    minD -= padDy;
    maxD += padDy;
    minI -= padIy;
    maxI += padIy;
    if (maxD - minD < 1e-6) {
      minD -= 1;
      maxD += 1;
    }
    if (maxI - minI < 1e-6) {
      minI -= 0.1;
      maxI += 0.1;
    }

    /* Day 1 → left plot edge, day 30 → right plot edge (inset from SVG edges). */
    const scaleX = i => plotInsetX + (i / 29) * plotW;
    const scaleYd = v => yPlotBottom - ((v - minD) / (maxD - minD)) * plotH;
    const scaleYi = v => yPlotBottom - ((v - minI) / (maxI - minI)) * plotH;
    const clampY = y => Math.min(yPlotBottom, Math.max(yPlotTop, y));

    const ptFilterDefs = `<defs><filter id="${PT_FILTER_ID}" x="-100%" y="-100%" width="300%" height="300%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.12"/><feDropShadow dx="0" dy="0.5" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.08"/></filter></defs>`;

    /* Clip both series to their shared day range (latest first valid, earliest last valid). */
    const firstValid = arr => arr.findIndex(v => v != null && Number.isFinite(v));
    const lastValid = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && Number.isFinite(arr[i])) return i; return -1; };
    const sharedStart = Math.max(firstValid(deepDaily), firstValid(intensityDaily));
    const sharedEnd = Math.min(lastValid(deepDaily), lastValid(intensityDaily));
    const clippedDeep = deepDaily.map((v, i) => (i >= sharedStart && i <= sharedEnd) ? v : null);
    const clippedInt = intensityDaily.map((v, i) => (i >= sharedStart && i <= sharedEnd) ? v : null);

    const ptsDeep = [];
    const ptsInt = [];
    for (let i = 0; i < 30; i += 1) {
      const vd = clippedDeep[i];
      if (vd != null && Number.isFinite(vd)) {
        ptsDeep.push({
          i,
          x: scaleX(i),
          y: clampY(scaleYd(vd)),
          v: vd,
        });
      }
      const vi = clippedInt[i];
      if (vi != null && Number.isFinite(vi)) {
        ptsInt.push({
          i,
          x: scaleX(i),
          y: clampY(scaleYi(vi)),
          v: vi,
        });
      }
    }
    const polyPts = arr => arr.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    const lineDeep =
      ptsDeep.length >= 2
        ? `<polyline class="fc2-connect fc2-connect--deep" points="${polyPts(ptsDeep)}" fill="none" stroke="${BLUE}" stroke-linecap="round" stroke-linejoin="round" stroke-width="1" shape-rendering="geometricPrecision" opacity="0.85"/>`
        : '';
    const lineInt =
      ptsInt.length >= 2
        ? `<polyline class="fc2-connect fc2-connect--int" points="${polyPts(ptsInt)}" fill="none" stroke="${YELLOW}" stroke-linecap="round" stroke-linejoin="round" stroke-width="1" shape-rendering="geometricPrecision" opacity="0.9"/>`
        : '';
    const circlesDeep = ptsDeep
      .map(
        p =>
          `<circle class="fc2-marker-deep" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3" fill="${BLUE}" stroke="#ffffff" stroke-width="2" filter="url(#${PT_FILTER_ID})"><title>Day ${p.i + 1} · ${metricLabel} ${(+p.v).toFixed(leftUnit === '%' ? 1 : 2)}${leftUnit}</title></circle>`,
      )
      .join('');
    const circlesInt = ptsInt
      .map(
        p =>
          `<circle class="fc2-marker-int" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3" fill="${YELLOW}" stroke="#ffffff" stroke-width="2" filter="url(#${PT_FILTER_ID})"><title>Day ${p.i + 1} · Training intensity ${(+p.v).toFixed(2)}</title></circle>`,
      )
      .join('');

    const nLeftTicks = 5;
    const nRightTicks = 5;
    const leftTicks = Array.from({ length: nLeftTicks }, (_, t) => maxD - (t / (nLeftTicks - 1)) * (maxD - minD));
    const rightTicks = Array.from({ length: nRightTicks }, (_, t) => maxI - (t / (nRightTicks - 1)) * (maxI - minI));

    const hLines = leftTicks
      .map(v => {
        const y = Math.round(scaleYd(v) * 2) / 2;
        return `<line class="fc2-hgrid" x1="${plotInsetX}" y1="${y}" x2="${(W - plotInsetX).toFixed(2)}" y2="${y}" stroke="${GRID}"/>`;
      })
      .join('');

    const leftLbl = leftTicks
      .map(v => {
        const y = Math.round(scaleYd(v) * 2) / 2;
        const label = leftUnit === '%' || leftUnit === 'ms' || leftUnit === 'bpm' ? Math.round(v) : (+v).toFixed(1);
        return `<text x="${leftLabelX}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-family="${FONT}" font-size="8" fill="${BLUE}">${label}${leftUnit}</text>`;
      })
      .join('');

    const rightLbl = rightTicks
      .map(v => {
        const y = Math.round(scaleYi(v) * 2) / 2;
        return `<text x="${rightLabelX}" y="${(y + 4).toFixed(2)}" text-anchor="start" font-family="${FONT}" font-size="8" fill="${ORANGE}">${v.toFixed(2)}</text>`;
      })
      .join('');

    const xTickDays = [1, 5, 9, 13, 17, 21, 25, 30];
    const xLbl = xTickDays
      .map(day => {
        const x = scaleX(day - 1);
        const anchor = day === 1 ? 'start' : day === 30 ? 'end' : 'middle';
        return `<text x="${x.toFixed(2)}" y="${(H - 6).toFixed(2)}" text-anchor="${anchor}" font-family="${FONT}" font-size="8" fill="${TICK_X}">${String(day).padStart(2, '0')}</text>`;
      })
      .join('');

    const parts = [
      `<title>Daily ${metricLabel} and training load by day.</title>`,
      `<desc>Blue dots: ${metricLabel}, linked by a thin blue line in day order. Yellow dots: same-day training intensity, linked by a thin yellow line. Dot style matches HRV chart (white ring and soft shadow). Days without a value in the shared range have no marker. Horizontal axis: day labels 01 through 30; y ticks at left (${metricLabel}) and right (intensity).</desc>`,
      ptFilterDefs,
      hLines,
      lineDeep,
      lineInt,
      circlesDeep,
      circlesInt,
      leftLbl,
      rightLbl,
      xLbl,
    ];

    svg.innerHTML = parts.join('');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute(
      'aria-label',
      `Daily ${metricLabel} (blue dots and line) and training intensity (yellow dots and line) over 30 days`,
    );
    nutricodeBindFocusChartAxisFontPx(svg);
    if (typeof scheduleEqualizeFocusCorrelationSections === 'function') scheduleEqualizeFocusCorrelationSections();
}

function nutricodeDrawFocusHrv(svg, data, slotIdx) {
    const d = data;
    const metricLabel = String(d.metricLabel || 'HRV');
    const unitLabel = String(d.unitLabel || 'ms');
    const yAxisLabel = String(d.yAxisLabel || metricLabel.toUpperCase());
    const titleLabel = String(d.titleLabel || `Nightly ${metricLabel}`);
    const numDays = Math.max(1, Math.min(31, +d.numDays || 30));
    const seriesByDay = Array.isArray(d.seriesByDay)
      ? d.seriesByDay
      : Array.isArray(d.hrvByDay)
        ? d.hrvByDay
        : [];
    let targetMin = +d.targetMin;
    let targetMax = +d.targetMax;
    if (!Number.isFinite(targetMin)) targetMin = 100;
    if (!Number.isFinite(targetMax)) targetMax = 110;
    if (targetMin > targetMax) {
      const t = targetMin;
      targetMin = targetMax;
      targetMax = t;
    }

    const fmtTick = (v) => {
      const n = +v;
      if (!Number.isFinite(n)) return '—';
      if (unitLabel === 'h') return `${n.toFixed(1)} ${unitLabel}`.trim();
      if (unitLabel === '/h') return `${n.toFixed(2)} ${unitLabel}`.trim();
      return `${Math.round(n)} ${unitLabel}`.trim();
    };

    const fmtPointTitle = (v) => {
      const n = +v;
      if (!Number.isFinite(n)) return '—';
      if (unitLabel === 'h') return `${n.toFixed(1)} ${unitLabel}`.trim();
      if (unitLabel === '/h') return `${n.toFixed(2)} ${unitLabel}`.trim();
      return `${Math.round(n)} ${unitLabel}`.trim();
    };

    const minSpan =
      unitLabel === '/h' ? 0.35 : unitLabel === 'h' ? 1.2 : unitLabel === '%' ? 8 : 12;

    const FONT = "'JetBrains Mono', ui-monospace, monospace";
    /* Inset plot; y labels use text-anchor end — keep yLabelX close to plotLeft so digits stay inside viewBox (panel has overflow:hidden). */
    const plotLeft = 58;
    const plotRight = 265;
    const plotTop = 50;
    const plotBottom = 148;
    const yLabelX = plotLeft - 4;
    const xDayLabelY = 168;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    const vals = seriesByDay.slice(0, numDays).filter((v) => v != null && Number.isFinite(+v)).map((v) => +v);
    let yMin = Math.min(targetMin, ...(vals.length ? vals : [targetMin]));
    let yMax = Math.max(targetMax, ...(vals.length ? vals : [targetMax]));
    const pad = Math.max((yMax - yMin) * 0.12, unitLabel === '/h' ? 0.02 : unitLabel === 'h' ? 0.15 : 1);
    yMin = Math.max(0, yMin - pad);
    yMax = yMax + pad;
    if (yMax - yMin < minSpan) {
      const mid = (yMax + yMin) / 2;
      yMin = mid - minSpan / 2;
      yMax = mid + minSpan / 2;
    }
    const ySpan = Math.max(1e-6, yMax - yMin);
    const scaleY = (ms) => plotBottom - ((ms - yMin) / ySpan) * plotH;

    const gridCount = 6;
    const gridMs = [];
    for (let g = 0; g < gridCount; g++) {
      gridMs.push(yMax - (g / (gridCount - 1)) * (yMax - yMin));
    }

    const bandTop = Math.min(scaleY(targetMin), scaleY(targetMax));
    const bandH = Math.abs(scaleY(targetMax) - scaleY(targetMin));
    const bandY = bandTop;

    const filterId = 'fc3HrvPtSh' + slotIdx;
    let out = `<defs><filter id="${filterId}" x="-100%" y="-100%" width="300%" height="300%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.12"/><feDropShadow dx="0" dy="0.5" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.08"/></filter></defs>`;
    out += `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="#e8e8ed" stroke-width="1"/>`;
    out += `<rect x="${plotLeft}" y="${bandY.toFixed(2)}" width="${plotW}" height="${Math.max(bandH, 1).toFixed(2)}" rx="1.2" fill="rgba(59, 130, 246, 0.18)"/>`;
    gridMs.forEach((ms) => {
      const yy = scaleY(ms);
      out += `<line x1="${plotLeft}" y1="${yy.toFixed(2)}" x2="${plotRight}" y2="${yy.toFixed(2)}" stroke="#f0f0f2" stroke-width="1"/>`;
    });
    gridMs.forEach((ms) => {
      const yy = scaleY(ms);
      out += `<text x="${yLabelX}" y="${yy.toFixed(2)}" font-size="8" fill="#b7bcc6" text-anchor="end" dominant-baseline="middle" font-family="${FONT}">${fmtTick(ms)}</text>`;
    });

    const slotW = plotW / numDays;
    for (let i = 0; i < numDays; i++) {
      const v = seriesByDay[i];
      if (v == null || !Number.isFinite(+v)) continue;
      const yv = +v;
      const cx = plotLeft + i * slotW + slotW / 2;
      const cy = scaleY(yv);
      const inBand = yv >= targetMin && yv <= targetMax;
      const fill = inBand ? '#0071e3' : '#aeaeb2';
      out += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="3" fill="${fill}" stroke="#ffffff" stroke-width="2" filter="url(#${filterId})"><title>Day ${i + 1} · ${metricLabel} ${fmtPointTitle(yv)}</title></circle>`;
    }

    const tickStep = Math.max(1, Math.ceil(numDays / 10));
    const xDayIndices = [];
    for (let day = 1; day <= numDays; day += tickStep) xDayIndices.push(day);
    if (xDayIndices[xDayIndices.length - 1] !== numDays) xDayIndices.push(numDays);
    xDayIndices.forEach((day) => {
      const i = day - 1;
      const cx = plotLeft + (i + 0.5) * slotW;
      out += `<text x="${cx.toFixed(2)}" y="${xDayLabelY}" font-size="8" fill="#9ca3af" text-anchor="middle" dominant-baseline="middle" font-family="${FONT}">${String(day).padStart(2, '0')}</text>`;
    });

    const ariaTarget =
      unitLabel === '/h' || unitLabel === 'h'
        ? `${Number(targetMin).toFixed(unitLabel === 'h' ? 1 : 2)}–${Number(targetMax).toFixed(unitLabel === 'h' ? 1 : 2)} ${unitLabel}`
        : `${Math.round(targetMin)}–${Math.round(targetMax)} ${unitLabel}`;
    svg.setAttribute(
      'aria-label',
      `Nightly ${metricLabel} over ${numDays} nights; target ${ariaTarget}`,
    );
    svg.innerHTML = `<title>${titleLabel}</title><desc>Shaded band: target range for ${metricLabel}. Blue dots are within range.</desc>${out}`;
    /* Wider viewBox on the left so end-anchored y tick labels are not clipped by overflow:hidden on the chart panel. */
    svg.setAttribute('viewBox', '4 38 279 140');
    nutricodeBindFocusChartAxisFontPx(svg);
    if (typeof scheduleEqualizeFocusCorrelationSections === 'function') scheduleEqualizeFocusCorrelationSections();
}

function nutricodeDrawFocusScatter(svg, data, slotIdx) {
  const slotSuf = String(slotIdx);
    const yAxisLabelText = String(data.yAxisLabel || 'NEXT-DAY RHR');
    const xAxisLabelText = String(data.xAxisLabel || 'Training Intensity');
    const yUnit = String(data.yUnit || 'bpm');
    const pointYLabel = String(data.pointYLabel || 'Next-day RHR');
    const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";
    const GRID = '#f0f0f2';
    const TICK = '#9ca3af';
    const TICK_SOFT = '#b7bcc6';
    const BLUE = '#0071e3';

    const seed = s => {
      let x = s;
      return () => {
        x = Math.sin(x) * 10000;
        return x - Math.floor(x);
      };
    };

    const niceStep = (range, ticks) => {
      const rough = Math.max(range, 0.0001) / Math.max(1, ticks - 1);
      const power = 10 ** Math.floor(Math.log10(rough));
      const scaled = rough / power;
      let factor = 1;
      if (scaled <= 1) factor = 1;
      else if (scaled <= 2) factor = 2;
      else if (scaled <= 2.5) factor = 2.5;
      else if (scaled <= 5) factor = 5;
      else factor = 10;
      return factor * power;
    };

    const buildTicks = (min, max, count) => {
      const step = niceStep(max - min, count);
      const start = Math.floor(min / step) * step;
      const end = Math.ceil(max / step) * step;
      const ticks = [];
      for (let value = start; value <= end + step * 0.5; value += step) {
        ticks.push(+value.toFixed(4));
      }
      return ticks;
    };

    const formatIntensity = value => value.toFixed(1);
    const formatYTick = (value) => {
      const v = +value;
      if (!Number.isFinite(v)) return '—';
      if (yUnit === 'h') return v.toFixed(1);
      if (yUnit === '/h') return v.toFixed(2);
      return `${Math.round(v)}`;
    };

    const formatYPointTitle = (y) => {
      const v = +y;
      if (!Number.isFinite(v)) return '—';
      if (yUnit === 'h') return `${v.toFixed(1)} ${yUnit}`.trim();
      if (yUnit === '/h') return `${v.toFixed(2)} ${yUnit}`.trim();
      return `${Math.round(v)} ${yUnit}`.trim();
    };

    const _fc4 = data;
    let pts = Array.isArray(_fc4.points)
      ? _fc4.points
          .filter((p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.y))
          .map((p) => ({ x: +Number(p.x).toFixed(4), y: +Number(p.y).toFixed(2) }))
      : [];

    if (pts.length < 2) {
      const rng = seed(7);
      pts = Array.from({ length: 14 }, () => ({
        x: +(rng() * 1.3 + 1.05).toFixed(2),
        y: Math.round(48 + rng() * 8),
      }));
    }

    const xs = pts.map(p => p.x);
    const ys = pts.map(p => p.y);
    const n = pts.length;
    const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / n;

    let num = 0;
    let dx2 = 0;
    pts.forEach(point => {
      num += (point.x - meanX) * (point.y - meanY);
      dx2 += (point.x - meanX) ** 2;
    });

    const slope = dx2 > 1e-12 ? num / dx2 : 0;
    const intercept = meanY - slope * meanX;
    const predict = x => slope * x + intercept;

    const rawXMin = Math.min(...xs);
    const rawXMax = Math.max(...xs);
    const rawYMin = Math.min(...ys, predict(rawXMin), predict(rawXMax));
    const rawYMax = Math.max(...ys, predict(rawXMin), predict(rawXMax));

    const xPad = Math.max(0.08, (rawXMax - rawXMin || 0.6) * 0.18);
    const yPadBase = yUnit === '/h' ? 0.02 : yUnit === 'h' ? 0.25 : 1.5;
    const yPad = Math.max(yPadBase, (rawYMax - rawYMin || (yUnit === '/h' ? 0.1 : yUnit === 'h' ? 0.5 : 5)) * 0.22);

    const xTicks = buildTicks(rawXMin - xPad, rawXMax + xPad, 6);
    const yTicks = buildTicks(rawYMin - yPad, rawYMax + yPad, 5);

    const domainXMin = xTicks[0];
    const domainXMax = xTicks[xTicks.length - 1];
    const domainYMin = yTicks[0];
    const domainYMax = yTicks[yTicks.length - 1];

    /* Plot area shifted left (extra margin on the right inside the viewBox). */
    const plotShiftX = -14;
    const viewMinX = -60;
    const viewOuterWidth = 320;
    const viewHeight = 156;
    const xTickY = 138;
    const xAxisTitleY = 152;
    const plot = { left: 10 + plotShiftX, right: 260 + plotShiftX, top: 20, bottom: 126 };
    const plotMidX = (plot.left + plot.right) / 2;
    const plotMidY = (plot.top + plot.bottom) / 2;
    const yTickLabelX = 0 + plotShiftX;
    const yAxisTitleX = -23 + plotShiftX;
    const plotWidth = plot.right - plot.left;
    const plotHeight = plot.bottom - plot.top;

    const scaleX = value => plot.left + ((value - domainXMin) / (domainXMax - domainXMin)) * plotWidth;
    const scaleY = value => plot.bottom - ((value - domainYMin) / (domainYMax - domainYMin)) * plotHeight;

    const horizontalGrid = yTicks.slice(1).map(value => {
      const y = scaleY(value).toFixed(2);
      return `<line x1="${plot.left}" y1="${y}" x2="${plot.right}" y2="${y}" stroke="${GRID}" stroke-width="1"></line>`;
    }).join('');

    const xLabels = xTicks.map((value, index) => {
      const x = scaleX(value).toFixed(2);
      const isLast = index === xTicks.length - 1;
      const anchor = index === 0 ? 'start' : isLast ? 'end' : 'middle';
      return `<text x="${x}" y="${xTickY}" text-anchor="${anchor}" font-family="${FONT_MONO}" font-size="8" font-weight="400" fill="${TICK}">${formatIntensity(value)}</text>`;
    }).join('');

    const yLabels = yTicks.map(value => {
      const y = scaleY(value).toFixed(2);
      return `<text x="${yTickLabelX}" y="${(+y + 2.5).toFixed(2)}" text-anchor="end" font-family="${FONT_MONO}" font-size="8" font-weight="400" fill="${TICK_SOFT}">${formatYTick(value)}</text>`;
    }).join('');

    const yAxisTitle = `<text transform="rotate(-90, ${yAxisTitleX}, ${plotMidY})" x="${yAxisTitleX}" y="${plotMidY}" text-anchor="middle" dominant-baseline="middle" font-family="${FONT_MONO}" font-size="8" font-weight="600" letter-spacing="0.14em" fill="${TICK_SOFT}">${yAxisLabelText}</text>`;
    const xAxisTitle = `<text x="${plotMidX}" y="${xAxisTitleY}" text-anchor="middle" font-family="${FONT_MONO}" font-size="8" font-weight="600" letter-spacing="0.1em" fill="${TICK}">${xAxisLabelText}</text>`;

    const regressionLine = `
      <line
        x1="${scaleX(domainXMin).toFixed(2)}"
        y1="${scaleY(predict(domainXMin)).toFixed(2)}"
        x2="${scaleX(domainXMax).toFixed(2)}"
        y2="${scaleY(predict(domainXMax)).toFixed(2)}"
        stroke="${BLUE}"
        stroke-width="1.5"
        stroke-linecap="round"
      ></line>`;

    const pointShadowFilter = `
      <filter id="focusScatterPtSh${slotSuf}" x="-100%" y="-100%" width="300%" height="300%">
        <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.12"/>
        <feDropShadow dx="0" dy="0.5" stdDeviation="0.5" flood-color="#000000" flood-opacity="0.08"/>
      </filter>`;
    const circles = pts.map(point => `
      <circle cx="${scaleX(point.x).toFixed(2)}" cy="${scaleY(point.y).toFixed(2)}" r="3" fill="#aeaeb2" stroke="#ffffff" stroke-width="2" filter="url(#focusScatterPtSh${slotSuf})">
        <title>Intensity ${point.x.toFixed(2)} · ${pointYLabel} ${formatYPointTitle(point.y)}</title>
      </circle>`).join('');

    const plotClipW = plot.right - plot.left;
    const plotClipH = plot.bottom - plot.top;
    const plotClip = `<clipPath id="focusScatterPlotClip${slotSuf}"><rect x="${plot.left}" y="${plot.top}" width="${plotClipW}" height="${plotClipH}"/></clipPath>`;

    svg.innerHTML = `
      <defs>${pointShadowFilter}${plotClip}</defs>
      <title>${pointYLabel} versus same-day training intensity.</title>
      <desc>Scatter of training intensity versus ${pointYLabel}. Y-axis: ${pointYLabel} (${yUnit}). X-axis: training intensity.</desc>
      <g clip-path="url(#focusScatterPlotClip${slotSuf})">
        ${horizontalGrid}
        ${regressionLine}
        ${circles}
      </g>
      ${yAxisTitle}
      ${yLabels}
      ${xLabels}
      ${xAxisTitle}
    `;

    svg.setAttribute('viewBox', `${viewMinX} 0 ${viewOuterWidth} ${viewHeight}`);
    svg.setAttribute('overflow', 'visible');
    nutricodeBindFocusChartAxisFontPx(svg);
    if (typeof scheduleEqualizeFocusCorrelationSections === 'function') scheduleEqualizeFocusCorrelationSections();
}

function nutricodeDrawSleepHoursBars(svg, data, slotIdx, sch) {
  const FONT = "'JetBrains Mono', ui-monospace, monospace";
  const TICK_SOFT = '#b7bcc6';
  const TICK = '#9ca3af';
  const REF_LINE = '#9ca3af';
  const BAR = '#0071e3';
  const vbMinX = 14, vbMinY = 38, vbW = 269, vbH = 140;
  const plotLeft = 42, plotRight = 279, plotTop = 42, plotBottom = 158;
  const yLabelX = 30, xDayLabelY = 170;
  const plotW = plotRight - plotLeft, plotH = plotBottom - plotTop;
  let numDays = Math.max(1, Math.min(31, +data.numDays || 30));
  let daily = Array.isArray(data.dailyHours) ? data.dailyHours.slice() : [];
  const refH = data.refHours != null && Number.isFinite(+data.refHours) ? +data.refHours : null;
  const valid = daily.filter((v) => v != null && Number.isFinite(+v));
  if (valid.length < 2) {
    sch();
    return;
  }
  let yMin = Math.min(...valid);
  let yMax = Math.max(...valid);
  if (refH != null) {
    yMin = Math.min(yMin, refH);
    yMax = Math.max(yMax, refH);
  }
  const pad = Math.max(0.15, (yMax - yMin) * 0.12);
  yMin = Math.max(0, yMin - pad);
  yMax = yMax + pad;
  const ySpan = Math.max(1e-6, yMax - yMin);
  const scaleY = (h) => plotBottom - ((h - yMin) / ySpan) * plotH;
  const slotW = plotW / numDays;
  const barW = Math.max(2, slotW * 0.7);
  const bars = daily
    .map((h, i) => {
      if (h == null || !Number.isFinite(+h)) return '';
      const x = plotLeft + i * slotW + (slotW - barW) / 2;
      const yTop = scaleY(+h);
      const ht = Math.max(0, plotBottom - yTop);
      if (ht < 0.5) return '';
      return `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barW.toFixed(2)}" height="${ht.toFixed(2)}" rx="1.2" fill="${BAR}"><title>Day ${i + 1} · ${(+h).toFixed(1)} h sleep</title></rect>`;
    })
    .join('');
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const yLabels = yTicks
    .map((v) => {
      const y = scaleY(v);
      return `<text x="${yLabelX}" y="${(y + 3).toFixed(2)}" font-size="8" fill="${TICK_SOFT}" text-anchor="end" font-family="${FONT}">${v.toFixed(1)}h</text>`;
    })
    .join('');
  const tickStep = Math.max(1, Math.ceil(numDays / 10));
  const xDayIndices = [];
  for (let d = 1; d <= numDays; d += tickStep) xDayIndices.push(d);
  if (xDayIndices[xDayIndices.length - 1] !== numDays) xDayIndices.push(numDays);
  const xLabels = xDayIndices
    .map((d) => {
      const i = d - 1;
      const cx = plotLeft + (i + 0.5) * slotW;
      return `<text x="${cx.toFixed(2)}" y="${xDayLabelY}" font-size="8" fill="${TICK}" text-anchor="middle" font-family="${FONT}">${String(d).padStart(2, '0')}</text>`;
    })
    .join('');
  let refSvg = '';
  if (refH != null && Number.isFinite(refH)) {
    const ry = scaleY(refH);
    refSvg = `<line x1="${plotLeft}" y1="${ry.toFixed(2)}" x2="${plotRight}" y2="${ry.toFixed(2)}" stroke="${REF_LINE}" stroke-width="1" stroke-dasharray="4 3"/>`;
  }
  svg.setAttribute('aria-label', `Nightly total sleep hours over ${numDays} days`);
  svg.innerHTML = `<title>Total sleep hours per night</title>${yLabels}${refSvg}${bars}${xLabels}`;
  svg.setAttribute('viewBox', `${vbMinX} ${vbMinY} ${vbW} ${vbH}`);
  nutricodeBindFocusChartAxisFontPx(svg);
  sch();
}


function nutricodeDrawDisturbBars(svg, data, slotIdx, sch) {
  const FONT = "'JetBrains Mono', ui-monospace, monospace";
  const TICK_SOFT = '#b7bcc6';
  const TICK = '#9ca3af';
  const REF_LINE = '#9ca3af';
  const BAR = '#0071e3';
  const vbMinX = 14, vbMinY = 38, vbW = 269, vbH = 140;
  const plotLeft = 42, plotRight = 279, plotTop = 42, plotBottom = 158;
  const yLabelX = 30, xDayLabelY = 170;
  const plotW = plotRight - plotLeft, plotH = plotBottom - plotTop;
  let numDays = Math.max(1, Math.min(31, +data.numDays || 30));
  let daily = Array.isArray(data.counts) ? data.counts.slice() : [];
  const refC = data.refCount != null && Number.isFinite(+data.refCount) ? +data.refCount : null;
  const valid = daily.filter((v) => v != null && Number.isFinite(+v));
  if (valid.length < 2) {
    sch();
    return;
  }
  let yMin = 0;
  let yMax = Math.max(...valid);
  if (refC != null) yMax = Math.max(yMax, refC);
  const pad = Math.max(0.5, (yMax - yMin) * 0.12);
  yMax = yMax + pad;
  const ySpan = Math.max(1e-6, yMax - yMin);
  const scaleY = (h) => plotBottom - ((h - yMin) / ySpan) * plotH;
  const slotW = plotW / numDays;
  const barW = Math.max(2, slotW * 0.7);
  const bars = daily
    .map((h, i) => {
      if (h == null || !Number.isFinite(+h)) return '';
      const x = plotLeft + i * slotW + (slotW - barW) / 2;
      const yTop = scaleY(+h);
      const ht = Math.max(0, plotBottom - yTop);
      if (ht < 0.5) return '';
      return `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barW.toFixed(2)}" height="${ht.toFixed(2)}" rx="1.2" fill="${BAR}"><title>Day ${i + 1} · ${Math.round(+h)} disruptions</title></rect>`;
    })
    .join('');
  const yTicks = [0, yMax * 0.5, yMax];
  const yLabels = yTicks
    .map((v) => {
      const y = scaleY(v);
      return `<text x="${yLabelX}" y="${(y + 3).toFixed(2)}" font-size="8" fill="${TICK_SOFT}" text-anchor="end" font-family="${FONT}">${Math.round(v)}</text>`;
    })
    .join('');
  const tickStep = Math.max(1, Math.ceil(numDays / 10));
  const xDayIndices = [];
  for (let d = 1; d <= numDays; d += tickStep) xDayIndices.push(d);
  if (xDayIndices[xDayIndices.length - 1] !== numDays) xDayIndices.push(numDays);
  const xLabels = xDayIndices
    .map((d) => {
      const i = d - 1;
      const cx = plotLeft + (i + 0.5) * slotW;
      return `<text x="${cx.toFixed(2)}" y="${xDayLabelY}" font-size="8" fill="${TICK}" text-anchor="middle" font-family="${FONT}">${String(d).padStart(2, '0')}</text>`;
    })
    .join('');
  let refSvg = '';
  if (refC != null && Number.isFinite(refC)) {
    const ry = scaleY(refC);
    refSvg = `<line x1="${plotLeft}" y1="${ry.toFixed(2)}" x2="${plotRight}" y2="${ry.toFixed(2)}" stroke="${REF_LINE}" stroke-width="1" stroke-dasharray="4 3"/>`;
  }
  svg.setAttribute('aria-label', `Nightly sleep disruptions over ${numDays} days`);
  svg.innerHTML = `<title>Disruptions per night</title>${yLabels}${refSvg}${bars}${xLabels}`;
  svg.setAttribute('viewBox', `${vbMinX} ${vbMinY} ${vbW} ${vbH}`);
  nutricodeBindFocusChartAxisFontPx(svg);
  sch();
}

(function nutricodeInitFocusChartSlots() {
  const slots = typeof FOCUS_SLOTS !== 'undefined' && Array.isArray(FOCUS_SLOTS) ? FOCUS_SLOTS : [];
  function sch() {
    if (typeof scheduleEqualizeFocusCorrelationSections === 'function') scheduleEqualizeFocusCorrelationSections();
  }
  slots.forEach((spec, slotIdx) => {
    const svg = document.getElementById('focus-chart-' + (slotIdx + 1));
    if (!svg) return;
    if (!spec || !spec.graph_type) {
      nutricodeBindFocusChartAxisFontPx(svg);
      return;
    }
    const data = spec.data && typeof spec.data === 'object' ? spec.data : {};
    switch (spec.graph_type) {
      case 'cohort':
        nutricodeDrawFocusRem(svg, data, slotIdx);
        break;
      case '7day_average':
        nutricodeDrawFocusDeepInt(svg, data, slotIdx);
        break;
      case 'variance':
        nutricodeDrawFocusHrv(svg, data, slotIdx);
        break;
      case 'single_correlation':
        nutricodeDrawFocusScatter(svg, data, slotIdx);
        break;
      default:
        nutricodeDrawFocusHrv(svg, data, slotIdx);
    }
  });
})();
