import fs from 'fs';
import path from 'path';

import { CRIBCLAW_BABY_NAME, STORE_DIR, TIMEZONE } from './config.js';
import { renderPngFromHtml } from './cribclaw-visual-summary.js';
import { BabyEventWithAttrs, getBabyEventsWithAttrs } from './db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChartSpec {
  type: 'line' | 'bar';
  title: string;
  metric:
    | 'feed_volume_ml'
    | 'feed_volume_oz'
    | 'event_count'
    | 'sleep_duration_minutes'
    | 'tummy_time_minutes';
  eventTypes?: string[]; // filter to these event types (e.g. ['feed'] or ['diaper']). If omitted, all types.
  days: number; // how many days of data (default 7)
  groupBy?: 'day' | 'hour'; // default 'day'
}

interface DataPoint {
  label: string;
  value: number;
}

// ---------------------------------------------------------------------------
// Color palette (matches visual summary)
// ---------------------------------------------------------------------------

const METRIC_COLORS: Record<string, string> = {
  feed_volume_ml: '#FF6B35', // vivid orange
  feed_volume_oz: '#FF6B35',
  event_count: '#006FFF', // strong blue (default; overridden by event type)
  sleep_duration_minutes: '#7B2D8E', // deep purple
  tummy_time_minutes: '#FF006E', // hot pink
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  feed: '#FF6B35',
  diaper: '#006FFF',
  sleep_start: '#7B2D8E',
  sleep_end: '#B54FDB',
  pump: '#00B4D8',
  tummy_time: '#FF006E',
  solids: '#2DC653',
  growth: '#FFB800',
  bath: '#00CFC1',
  milestone: '#E63946',
  note: '#6C757D',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getZonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);

  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value || '0';

  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    weekday: pick('weekday'),
  };
}

function dateKeyFromParts(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function shortDateLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** Pick the chart color based on metric + optional event type filter. */
function resolveColor(spec: ChartSpec): string {
  if (
    spec.metric === 'event_count' &&
    spec.eventTypes &&
    spec.eventTypes.length === 1
  ) {
    return EVENT_TYPE_COLORS[spec.eventTypes[0]] || METRIC_COLORS.event_count;
  }
  return METRIC_COLORS[spec.metric] || '#006FFF';
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

function aggregateData(
  events: BabyEventWithAttrs[],
  spec: ChartSpec,
  timeZone: string,
  startDate: Date,
): DataPoint[] {
  // Filter by event types if specified
  let filtered = events;
  if (spec.eventTypes && spec.eventTypes.length > 0) {
    const types = new Set(spec.eventTypes);
    filtered = events.filter((e) => types.has(e.event_type));
  }

  const groupBy = spec.groupBy || 'day';

  if (groupBy === 'hour') {
    return aggregateByHour(filtered, spec, timeZone);
  }
  return aggregateByDay(filtered, spec, timeZone, startDate);
}

function aggregateByDay(
  events: BabyEventWithAttrs[],
  spec: ChartSpec,
  timeZone: string,
  startDate: Date,
): DataPoint[] {
  // Pre-fill all days in range so we get 0-value entries for days with no data
  const buckets = new Map<string, number>();
  const labelMap = new Map<string, string>();

  for (let i = 0; i < spec.days; i++) {
    const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
    const parts = getZonedParts(d, timeZone);
    const key = dateKeyFromParts(parts);
    buckets.set(key, 0);
    labelMap.set(key, shortDateLabel(d, timeZone));
  }

  if (spec.metric === 'sleep_duration_minutes') {
    aggregateSleepDuration(events, buckets, timeZone);
  } else {
    for (const event of events) {
      const parts = getZonedParts(new Date(event.occurred_at), timeZone);
      const key = dateKeyFromParts(parts);
      if (!buckets.has(key)) continue;

      const val = extractMetricValue(event, spec);
      buckets.set(key, (buckets.get(key) || 0) + val);
    }
  }

  // Sort by date key, build data points
  const sortedKeys = [...buckets.keys()].sort();
  return sortedKeys.map((key) => ({
    label: labelMap.get(key) || key,
    value: Math.round((buckets.get(key) || 0) * 100) / 100,
  }));
}

function aggregateByHour(
  events: BabyEventWithAttrs[],
  spec: ChartSpec,
  timeZone: string,
): DataPoint[] {
  // 24 hour buckets
  const buckets = new Map<number, number>();
  for (let h = 0; h < 24; h++) {
    buckets.set(h, 0);
  }

  for (const event of events) {
    const parts = getZonedParts(new Date(event.occurred_at), timeZone);
    const val = extractMetricValue(event, spec);
    buckets.set(parts.hour, (buckets.get(parts.hour) || 0) + val);
  }

  return Array.from({ length: 24 }, (_, h) => ({
    label: formatHourLabel(h),
    value: Math.round((buckets.get(h) || 0) * 100) / 100,
  }));
}

function extractMetricValue(event: BabyEventWithAttrs, spec: ChartSpec): number {
  switch (spec.metric) {
    case 'feed_volume_ml': {
      const ml = Number(event.attributes.amount_ml);
      if (Number.isFinite(ml) && ml > 0) return ml;
      const oz = Number(event.attributes.amount_oz);
      if (Number.isFinite(oz) && oz > 0) return oz * 29.5735;
      return 0;
    }
    case 'feed_volume_oz': {
      const oz = Number(event.attributes.amount_oz);
      if (Number.isFinite(oz) && oz > 0) return oz;
      const ml = Number(event.attributes.amount_ml);
      if (Number.isFinite(ml) && ml > 0) return ml / 29.5735;
      return 0;
    }
    case 'event_count':
      return 1;
    case 'tummy_time_minutes': {
      const dur = Number(event.attributes.duration_minutes);
      return Number.isFinite(dur) && dur > 0 ? dur : 0;
    }
    case 'sleep_duration_minutes':
      // Handled separately in aggregateSleepDuration
      return 0;
    default:
      return 0;
  }
}

/**
 * Matches sleep_start / sleep_end pairs and assigns duration to the day the sleep ended.
 */
function aggregateSleepDuration(
  events: BabyEventWithAttrs[],
  buckets: Map<string, number>,
  timeZone: string,
): void {
  // Collect all sleep events ordered by occurred_at
  const sleepEvents = events
    .filter((e) => e.event_type === 'sleep_start' || e.event_type === 'sleep_end')
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

  let pendingStart: Date | null = null;

  for (const event of sleepEvents) {
    if (event.event_type === 'sleep_start') {
      pendingStart = new Date(event.occurred_at);
    } else if (event.event_type === 'sleep_end' && pendingStart) {
      const endDate = new Date(event.occurred_at);
      const durationMin = (endDate.getTime() - pendingStart.getTime()) / (1000 * 60);
      if (durationMin > 0 && durationMin < 24 * 60) {
        // Assign to the day the sleep ended
        const parts = getZonedParts(endDate, timeZone);
        const key = dateKeyFromParts(parts);
        if (buckets.has(key)) {
          buckets.set(key, (buckets.get(key) || 0) + durationMin);
        }
      }
      pendingStart = null;
    }
  }
}

function formatHourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return '12a';
  if (hour === 12) return '12p';
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

// ---------------------------------------------------------------------------
// Y-axis nice scale
// ---------------------------------------------------------------------------

function niceScale(maxVal: number): { max: number; step: number; ticks: number[] } {
  if (maxVal <= 0) maxVal = 1;

  // Find a nice round number for the max
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxVal)));
  const normalized = maxVal / magnitude;

  let niceMax: number;
  if (normalized <= 1) niceMax = 1 * magnitude;
  else if (normalized <= 1.5) niceMax = 1.5 * magnitude;
  else if (normalized <= 2) niceMax = 2 * magnitude;
  else if (normalized <= 3) niceMax = 3 * magnitude;
  else if (normalized <= 5) niceMax = 5 * magnitude;
  else if (normalized <= 7) niceMax = 7 * magnitude;
  else niceMax = 10 * magnitude;

  // Aim for ~5 ticks
  let step = niceMax / 5;
  // Round the step to a nice number
  const stepMag = Math.pow(10, Math.floor(Math.log10(step)));
  const stepNorm = step / stepMag;
  if (stepNorm <= 1) step = 1 * stepMag;
  else if (stepNorm <= 2) step = 2 * stepMag;
  else if (stepNorm <= 5) step = 5 * stepMag;
  else step = 10 * stepMag;

  // Ensure niceMax is a multiple of step
  niceMax = Math.ceil(maxVal / step) * step;
  if (niceMax === 0) niceMax = step;

  const ticks: number[] = [];
  for (let v = 0; v <= niceMax; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }

  return { max: niceMax, step, ticks };
}

// ---------------------------------------------------------------------------
// Metric unit labels
// ---------------------------------------------------------------------------

function metricUnitLabel(metric: ChartSpec['metric']): string {
  switch (metric) {
    case 'feed_volume_ml':
      return 'mL';
    case 'feed_volume_oz':
      return 'oz';
    case 'event_count':
      return 'count';
    case 'sleep_duration_minutes':
      return 'min';
    case 'tummy_time_minutes':
      return 'min';
    default:
      return '';
  }
}

function formatValue(val: number, metric: ChartSpec['metric']): string {
  if (metric === 'feed_volume_oz') {
    return val.toFixed(1);
  }
  if (val === Math.floor(val)) {
    return String(val);
  }
  return val.toFixed(1);
}

// ---------------------------------------------------------------------------
// SVG chart rendering
// ---------------------------------------------------------------------------

function renderChartSvg(
  data: DataPoint[],
  spec: ChartSpec,
  color: string,
): string {
  const CHART_WIDTH = 1080;
  const CHART_HEIGHT = 400;
  const MARGIN_LEFT = 70;
  const MARGIN_RIGHT = 40;
  const MARGIN_TOP = 20;
  const MARGIN_BOTTOM = 60;
  const PLOT_WIDTH = CHART_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const PLOT_HEIGHT = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

  const maxVal = Math.max(...data.map((d) => d.value), 0);
  const { max: yMax, ticks } = niceScale(maxVal);
  const unit = metricUnitLabel(spec.metric);

  // Scale helpers
  const xScale = (i: number): number => {
    if (data.length <= 1) return MARGIN_LEFT + PLOT_WIDTH / 2;
    return MARGIN_LEFT + (i / (data.length - 1)) * PLOT_WIDTH;
  };
  const yScale = (v: number): number => {
    return MARGIN_TOP + PLOT_HEIGHT - (v / yMax) * PLOT_HEIGHT;
  };
  // For bar charts, distribute evenly
  const barWidth = data.length > 0 ? Math.min(60, (PLOT_WIDTH / data.length) * 0.7) : 40;
  const barXCenter = (i: number): number => {
    if (data.length <= 1) return MARGIN_LEFT + PLOT_WIDTH / 2;
    return MARGIN_LEFT + ((i + 0.5) / data.length) * PLOT_WIDTH;
  };

  let svgParts: string[] = [];

  // Open SVG
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" style="font-family:'SF Pro Display',ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">`,
  );

  // Defs (gradient for line chart area fill)
  svgParts.push(`<defs>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.03"/>
    </linearGradient>
  </defs>`);

  // Gridlines
  for (const tick of ticks) {
    const y = yScale(tick);
    const dashArray = tick === 0 ? 'none' : '4,3';
    const strokeColor = tick === 0 ? '#cbd5e1' : '#e2e8f0';
    svgParts.push(
      `<line x1="${MARGIN_LEFT}" y1="${y}" x2="${CHART_WIDTH - MARGIN_RIGHT}" y2="${y}" stroke="${strokeColor}" stroke-width="1" stroke-dasharray="${dashArray}"/>`,
    );
  }

  // Y-axis labels
  for (const tick of ticks) {
    const y = yScale(tick);
    const label = formatValue(tick, spec.metric);
    svgParts.push(
      `<text x="${MARGIN_LEFT - 10}" y="${y + 4}" text-anchor="end" font-size="12" font-weight="600" fill="#94a3b8">${escapeHtml(label)}</text>`,
    );
  }

  // Y-axis unit
  svgParts.push(
    `<text x="${MARGIN_LEFT - 10}" y="${MARGIN_TOP - 6}" text-anchor="end" font-size="11" font-weight="700" fill="#94a3b8">${escapeHtml(unit)}</text>`,
  );

  if (spec.type === 'line') {
    // -- Line chart --

    // Area fill path
    if (data.length > 1) {
      let areaPath = `M ${xScale(0)} ${yScale(data[0].value)}`;
      for (let i = 1; i < data.length; i++) {
        areaPath += ` L ${xScale(i)} ${yScale(data[i].value)}`;
      }
      areaPath += ` L ${xScale(data.length - 1)} ${yScale(0)}`;
      areaPath += ` L ${xScale(0)} ${yScale(0)} Z`;
      svgParts.push(
        `<path d="${areaPath}" fill="url(#areaGrad)"/>`,
      );
    }

    // Line path
    if (data.length > 1) {
      let linePath = `M ${xScale(0)} ${yScale(data[0].value)}`;
      for (let i = 1; i < data.length; i++) {
        linePath += ` L ${xScale(i)} ${yScale(data[i].value)}`;
      }
      svgParts.push(
        `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }

    // Data point dots
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(i);
      const cy = yScale(data[i].value);
      svgParts.push(
        `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}" stroke="#ffffff" stroke-width="2"/>`,
      );
      // Value label above dot
      svgParts.push(
        `<text x="${cx}" y="${cy - 12}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155">${escapeHtml(formatValue(data[i].value, spec.metric))}</text>`,
      );
    }

    // X-axis labels
    const xLabelInterval = data.length > 14 ? Math.ceil(data.length / 14) : 1;
    for (let i = 0; i < data.length; i++) {
      if (i % xLabelInterval !== 0 && i !== data.length - 1) continue;
      const cx = xScale(i);
      svgParts.push(
        `<text x="${cx}" y="${CHART_HEIGHT - MARGIN_BOTTOM + 20}" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">${escapeHtml(data[i].label)}</text>`,
      );
    }
  } else {
    // -- Bar chart --

    for (let i = 0; i < data.length; i++) {
      const cx = barXCenter(i);
      const barH = (data[i].value / yMax) * PLOT_HEIGHT;
      const barY = yScale(data[i].value);

      // Bar
      svgParts.push(
        `<rect x="${cx - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barH}" rx="4" fill="${color}" opacity="0.85"/>`,
      );

      // Value label on top of bar
      if (data[i].value > 0) {
        svgParts.push(
          `<text x="${cx}" y="${barY - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155">${escapeHtml(formatValue(data[i].value, spec.metric))}</text>`,
        );
      }

      // X-axis label
      const xLabelInterval = data.length > 14 ? Math.ceil(data.length / 14) : 1;
      if (i % xLabelInterval === 0 || i === data.length - 1) {
        svgParts.push(
          `<text x="${cx}" y="${CHART_HEIGHT - MARGIN_BOTTOM + 20}" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">${escapeHtml(data[i].label)}</text>`,
        );
      }
    }
  }

  // Close SVG
  svgParts.push('</svg>');

  return svgParts.join('\n');
}

// ---------------------------------------------------------------------------
// Full HTML wrapper
// ---------------------------------------------------------------------------

function renderChartHtml(
  data: DataPoint[],
  spec: ChartSpec,
  color: string,
  timeZone: string,
  dateRangeLabel: string,
): string {
  const svg = renderChartSvg(data, spec, color);
  const titleText = CRIBCLAW_BABY_NAME
    ? `CribClaw.com \u00B7 ${escapeHtml(CRIBCLAW_BABY_NAME)}`
    : 'CribClaw.com';
  const unit = metricUnitLabel(spec.metric);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(spec.title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Pro Display', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #faf9f6;
    color: #1e293b;
  }
  .frame {
    width: 1200px;
    padding: 48px;
    background: #faf9f6;
  }
  .header { margin-bottom: 28px; }
  .header-top {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-bottom: 4px;
  }
  .logo { font-size: 40px; line-height: 1; position: relative; top: 4px; }
  .title {
    font-size: 40px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #0f172a;
  }
  .subtitle-line {
    font-size: 18px;
    color: #64748b;
    font-weight: 500;
    margin-top: 4px;
  }
  .chart-title {
    font-size: 24px;
    font-weight: 800;
    color: #1e293b;
    margin-bottom: 6px;
  }
  .chart-meta {
    font-size: 14px;
    color: #94a3b8;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .chart-container {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    padding: 24px 16px 16px 16px;
    margin-bottom: 24px;
  }
  .chart-container svg {
    display: block;
    width: 100%;
    height: auto;
  }
  .footer {
    text-align: center;
    font-size: 13px;
    color: #94a3b8;
    font-weight: 500;
    padding-top: 14px;
    border-top: 1px solid #e2e8f0;
  }
</style>
</head>
<body>
  <div class="frame">
    <div class="header">
      <div class="header-top">
        <span class="logo">\u{1F99E}</span>
        <div class="title">${titleText}</div>
      </div>
      <div class="subtitle-line">${escapeHtml(dateRangeLabel)} \u00B7 ${escapeHtml(timeZone)}</div>
    </div>
    <div class="chart-title">${escapeHtml(spec.title)}</div>
    <div class="chart-meta">${escapeHtml(spec.type === 'bar' ? 'Bar' : 'Line')} chart \u00B7 ${data.length} data points \u00B7 ${escapeHtml(unit)}</div>
    <div class="chart-container">
      ${svg}
    </div>
    <div class="footer">CribClaw.com \u00B7 Not a medical device</div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main entry point: generateChart
// ---------------------------------------------------------------------------

export function generateChart(
  chatJid: string,
  spec: ChartSpec,
  nowIso: string,
): { htmlPath: string; pngPath?: string; title: string; dataPoints: number } {
  const timeZone = TIMEZONE;
  const now = new Date(nowIso);
  const startDate = new Date(now.getTime() - spec.days * 24 * 60 * 60 * 1000);

  // Query events for the range
  const events = getBabyEventsWithAttrs(
    chatJid,
    startDate.toISOString(),
    now.toISOString(),
    10000,
  );

  // Filter to relevant event types for the metric if not already set
  let filteredSpec = { ...spec };
  if (!filteredSpec.eventTypes) {
    if (
      filteredSpec.metric === 'feed_volume_ml' ||
      filteredSpec.metric === 'feed_volume_oz'
    ) {
      filteredSpec = { ...filteredSpec, eventTypes: ['feed'] };
    } else if (filteredSpec.metric === 'sleep_duration_minutes') {
      filteredSpec = { ...filteredSpec, eventTypes: ['sleep_start', 'sleep_end'] };
    } else if (filteredSpec.metric === 'tummy_time_minutes') {
      filteredSpec = { ...filteredSpec, eventTypes: ['tummy_time'] };
    }
  }

  // Aggregate
  const data = aggregateData(events, filteredSpec, timeZone, startDate);
  const color = resolveColor(filteredSpec);

  // Date range label
  const startLabel = shortDateLabel(startDate, timeZone);
  const endLabel = shortDateLabel(now, timeZone);
  const dateRangeLabel = `${startLabel} \u2013 ${endLabel}`;

  // Write HTML
  const outDir = path.join(STORE_DIR, 'reports', sanitize(chatJid));
  fs.mkdirSync(outDir, { recursive: true });
  const datePart = nowIso.slice(0, 10);
  const metricSlug = sanitize(spec.metric);
  const baseName = `chart-${metricSlug}-${spec.days}d-${datePart}`;
  const htmlPath = path.join(outDir, `${baseName}.html`);
  const pngPath = path.join(outDir, `${baseName}.png`);

  const html = renderChartHtml(data, filteredSpec, color, timeZone, dateRangeLabel);
  fs.writeFileSync(htmlPath, html, 'utf8');

  // Render to PNG
  const renderedPng = renderPngFromHtml(htmlPath, pngPath, 1200, 700);

  return {
    htmlPath,
    pngPath: renderedPng ? pngPath : undefined,
    title: spec.title,
    dataPoints: data.length,
  };
}

// ---------------------------------------------------------------------------
// Natural language chart request parser
// ---------------------------------------------------------------------------

const CHART_TRIGGER_RE =
  /\b(chart|graph|plot|trend\s+(chart|line|graph|of)|show\s+me\s+a\s+(chart|graph|plot)\s+of|graph\s+of|chart\s+of|plot\s+of)\b/i;

export function parseChartRequest(text: string): ChartSpec | null {
  if (!CHART_TRIGGER_RE.test(text)) {
    return null;
  }

  const lower = text.toLowerCase();

  // --- Detect metric ---
  let metric: ChartSpec['metric'] = 'event_count';
  let eventTypes: string[] | undefined;
  let title = '';

  if (/\b(formula|intake|volume|ml|milliliters?)\b/.test(lower) && !/\boz\b/.test(lower)) {
    metric = 'feed_volume_ml';
    title = 'Formula Intake (mL)';
    eventTypes = ['feed'];
  } else if (/\b(oz|ounces?)\b/.test(lower)) {
    metric = 'feed_volume_oz';
    title = 'Formula Intake (oz)';
    eventTypes = ['feed'];
  } else if (/\btummy\s*time\b/.test(lower)) {
    metric = 'tummy_time_minutes';
    title = 'Tummy Time (minutes)';
    eventTypes = ['tummy_time'];
  } else if (/\bsleep\b/.test(lower)) {
    metric = 'sleep_duration_minutes';
    title = 'Sleep Duration (minutes)';
    eventTypes = ['sleep_start', 'sleep_end'];
  } else if (/\bdiaper(s)?\b/.test(lower)) {
    metric = 'event_count';
    title = 'Diaper Changes per Day';
    eventTypes = ['diaper'];
  } else if (/\bfeed(s|ing)?\b/.test(lower)) {
    metric = 'event_count';
    title = 'Feeds per Day';
    eventTypes = ['feed'];
  } else if (/\bpump(s|ing)?\b/.test(lower)) {
    metric = 'event_count';
    title = 'Pump Sessions per Day';
    eventTypes = ['pump'];
  } else if (/\bbath(s)?\b/.test(lower)) {
    metric = 'event_count';
    title = 'Baths per Day';
    eventTypes = ['bath'];
  } else if (/\bsolids?\b/.test(lower)) {
    metric = 'event_count';
    title = 'Solids Feeds per Day';
    eventTypes = ['solids'];
  } else if (/\bmilestone(s)?\b/.test(lower)) {
    metric = 'event_count';
    title = 'Milestones per Day';
    eventTypes = ['milestone'];
  } else {
    // Generic: count all events
    title = 'All Events per Day';
    eventTypes = undefined;
  }

  // --- Detect time range ---
  let days = 7;
  const daysMatch = lower.match(/(\d+)\s*days?/);
  const weeksMatch = lower.match(/(\d+)\s*weeks?/);

  if (daysMatch) {
    days = parseInt(daysMatch[1], 10);
  } else if (weeksMatch) {
    days = parseInt(weeksMatch[1], 10) * 7;
  } else if (/\bthis\s+month\b|\b30\s*days?\b|\blast\s+month\b/.test(lower)) {
    days = 30;
  } else if (/\blast\s+2\s+weeks?\b|\b(two|2)\s+weeks?\b|\b14\s*days?\b/.test(lower)) {
    days = 14;
  } else if (/\bthis\s+week\b|\blast\s+7\s*days?\b|\blast\s+week\b|\bweekly\b/.test(lower)) {
    days = 7;
  }

  // Clamp to reasonable range
  if (days < 1) days = 1;
  if (days > 90) days = 90;

  // --- Detect chart type ---
  let type: ChartSpec['type'] = 'line';
  if (/\bbar\b/.test(lower)) {
    type = 'bar';
  }

  // --- Detect groupBy ---
  let groupBy: ChartSpec['groupBy'] = 'day';
  if (/\bby\s+hour\b|\bhourly\b|\bper\s+hour\b/.test(lower)) {
    groupBy = 'hour';
  }

  return {
    type,
    title,
    metric,
    eventTypes,
    days,
    groupBy,
  };
}
