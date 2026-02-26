import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CRIBCLAW_BABY_NAME, STORE_DIR, TIMEZONE } from './config.js';
import { BabyEventDetailRow, getBabyEventsInRange } from './db.js';

const EVENT_TYPES = [
  'feed',
  'diaper',
  'sleep_start',
  'sleep_end',
  'milestone',
  'note',
  'pump',
  'tummy_time',
  'solids',
  'growth',
  'bath',
];

// Maximally divergent, vivid colors for instant recognition
const EVENT_COLORS: Record<string, string> = {
  feed: '#FF6B35',        // vivid orange
  diaper: '#006FFF',      // strong blue
  sleep_start: '#7B2D8E', // deep purple
  sleep_end: '#B54FDB',   // bright violet
  milestone: '#E63946',   // vivid red
  note: '#6C757D',        // slate gray
  pump: '#00B4D8',        // bright cyan
  tummy_time: '#FF006E',  // hot pink
  solids: '#2DC653',      // vivid green
  growth: '#FFB800',      // golden yellow
  bath: '#00CFC1',        // teal
};
const EVENT_LABELS: Record<string, string> = {
  feed: 'Feed',
  diaper: 'Diaper',
  sleep_start: 'Sleep Start',
  sleep_end: 'Wake Up',
  milestone: 'Milestone',
  note: 'Note',
  pump: 'Pump',
  tummy_time: 'Tummy Time',
  solids: 'Solids',
  growth: 'Growth',
  bath: 'Bath',
};
const EVENT_ICONS: Record<string, string> = {
  feed: '\u{1F37C}',
  diaper: '\u{1FA75}',
  sleep_start: '\u{1F634}',
  sleep_end: '\u2600\uFE0F',
  milestone: '\u2B50',
  note: '\u{1F4DD}',
  pump: '\u{1F95B}',
  tummy_time: '\u{1F4AA}',
  solids: '\u{1F951}',
  growth: '\u{1F4CF}',
  bath: '\u{1F6C1}',
};

type SummaryView = 'day' | 'week' | 'list';

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

export function detectView(text: string): SummaryView {
  if (/\bweek|weekly|7 ?day\b/.test(text)) return 'week';
  if (/\blist\b/.test(text)) return 'list';
  return 'day';
}

function getZonedParts(date: Date, timeZone: string): {
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

function dateKeyFromParts(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dayLabelFromDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function shortDayLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function buildRange(view: SummaryView, nowIso: string): { start: Date; end: Date; days: number } {
  const now = new Date(nowIso);
  // End of today (23:59:59.999) so we always include the full current day
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  if (view === 'day') {
    // Start at midnight today
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start, end, days: 1 };
  }
  // Start at midnight, 6 days ago (today + 6 prior days = 7 days)
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  return { start, end, days: 7 };
}

function formatHourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return '12 AM';
  if (hour === 12) return '12 PM';
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function formatClockFromParts(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * Vertical column layout: days as columns, 24h on the Y-axis.
 * Events rendered as large colored blocks with emoji icons.
 */
function renderCalendarHtml(args: {
  events: BabyEventDetailRow[];
  view: SummaryView;
  timeZone: string;
  nowIso: string;
}): string {
  const { events, view, timeZone, nowIso } = args;
  const now = new Date(nowIso);
  const daysCount = view === 'day' ? 1 : 7;

  // Canvas dimensions — 9:16 portrait aspect ratio for mobile
  const CANVAS_WIDTH = 1080;
  const GRID_HEIGHT = daysCount === 1 ? 1200 : 1400;
  const PADDING = 56;

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  if (daysCount === 7) {
    dayStart.setDate(dayStart.getDate() - 6);
  }

  const dayKeys: string[] = [];
  const dayLabels: string[] = [];
  for (let i = 0; i < daysCount; i += 1) {
    const d = new Date(dayStart);
    d.setDate(d.getDate() + i);
    const parts = getZonedParts(d, timeZone);
    dayKeys.push(dateKeyFromParts(parts));
    dayLabels.push(daysCount === 1 ? dayLabelFromDate(d, timeZone) : shortDayLabel(d, timeZone));
  }
  const dayIndexByKey = new Map(dayKeys.map((key, idx) => [key, idx]));

  // Group events by day
  const eventsByDay: BabyEventDetailRow[][] = Array.from({ length: daysCount }, () => []);
  for (const event of events) {
    const date = new Date(event.occurred_at);
    const parts = getZonedParts(date, timeZone);
    const dayKey = dateKeyFromParts(parts);
    const dayIndex = dayIndexByKey.get(dayKey);
    if (dayIndex !== undefined) {
      eventsByDay[dayIndex].push(event);
    }
  }

  // Build stat counts
  const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<string, number>;
  for (const event of events) {
    counts[event.event_type] = (counts[event.event_type] || 0) + 1;
  }

  const statCards = EVENT_TYPES
    .filter((type) => (counts[type] || 0) > 0)
    .map((type) => {
      const label = EVENT_LABELS[type];
      const icon = EVENT_ICONS[type] || '\u{1F4CC}';
      const color = EVENT_COLORS[type] || '#94a3b8';
      return `<div class="stat-card" style="border-left: 4px solid ${color}">
        <div class="stat-icon">${icon}</div>
        <div class="stat-info">
          <div class="stat-value" style="color:${color}">${counts[type] || 0}</div>
          <div class="stat-label">${escapeHtml(label)}</div>
        </div>
      </div>`;
    }).join('\n');

  // Hour gridlines (every 2 hours for better resolution)
  const hourMarks = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
  const hourLines = hourMarks.map((h) => {
    const topPct = (h / 24) * 100;
    return `<div class="hour-line" style="top:${topPct}%"><span class="hour-label">${formatHourLabel(h)}</span></div>`;
  }).join('\n');

  // Night shading (midnight-6am and 9pm-midnight)
  const nightShading = `
    <div class="night-shade" style="top:0;height:${(6 / 24) * 100}%"></div>
    <div class="night-shade" style="top:${(21 / 24) * 100}%;height:${(3 / 24) * 100}%"></div>
  `;

  // Event dot sizes — much bigger
  const dotSize = daysCount === 1 ? 44 : 34;
  const fontSize = daysCount === 1 ? 22 : 16;

  // Day columns with events
  const colWidth = 100 / daysCount;
  const dayColumns = eventsByDay.map((dayEvents, dayIdx) => {
    const leftPct = dayIdx * colWidth;

    // Count events per 20-min slot for horizontal offset
    const slotCounts = new Map<number, number>();
    const slotIndexes = new Map<number, number>();
    for (const event of dayEvents) {
      const date = new Date(event.occurred_at);
      const parts = getZonedParts(date, timeZone);
      const slot = Math.floor((parts.hour * 60 + parts.minute) / 20);
      slotCounts.set(slot, (slotCounts.get(slot) || 0) + 1);
    }

    const dots = dayEvents.map((event) => {
      const date = new Date(event.occurred_at);
      const parts = getZonedParts(date, timeZone);
      const minuteOfDay = parts.hour * 60 + parts.minute;
      const topPct = (minuteOfDay / (24 * 60)) * 100;
      const color = EVENT_COLORS[event.event_type] || '#94a3b8';
      const icon = EVENT_ICONS[event.event_type] || '\u{1F4CC}';
      const label = EVENT_LABELS[event.event_type] || event.event_type;
      const timeStr = formatClockFromParts(parts.hour, parts.minute);

      // Offset overlapping dots horizontally
      const slot = Math.floor(minuteOfDay / 20);
      const count = slotCounts.get(slot) || 1;
      const idx = slotIndexes.get(slot) || 0;
      slotIndexes.set(slot, idx + 1);
      const spacing = dotSize + 4;
      const totalWidth = count * spacing;
      const leftOffset = count <= 1 ? 0 : (idx * spacing) - (totalWidth / 2) + (spacing / 2);

      return `<div class="event-dot" style="top:${topPct}%;left:calc(50% + ${leftOffset}px);width:${dotSize}px;height:${dotSize}px;background:${color};font-size:${fontSize}px" title="${escapeHtml(label)} ${escapeHtml(timeStr)}">
        <span class="dot-icon">${icon}</span>
      </div>`;
    }).join('\n');

    // Day header
    const count = dayEvents.length;
    const isOdd = dayIdx % 2 === 1;

    return `<div class="day-col" style="left:${leftPct}%;width:${colWidth}%">
      <div class="day-col-header">
        <div class="day-col-name">${escapeHtml(dayLabels[dayIdx])}</div>
        <div class="day-col-count">${count} event${count !== 1 ? 's' : ''}</div>
      </div>
      <div class="day-col-track${isOdd ? ' alt' : ''}">
        ${nightShading}
        ${dots}
      </div>
    </div>`;
  }).join('\n');

  // Day dividers
  const dayDividers = Array.from({ length: daysCount + 1 }, (_, idx) => {
    const leftPct = (idx / daysCount) * 100;
    return `<div class="day-divider" style="left:${leftPct}%"></div>`;
  }).join('\n');

  // Legend — bigger, with colored blocks
  const legendItems = EVENT_TYPES
    .filter((type) => (counts[type] || 0) > 0)
    .map((type) => {
      const color = EVENT_COLORS[type] || '#94a3b8';
      const icon = EVENT_ICONS[type] || '\u{1F4CC}';
      const label = EVENT_LABELS[type];
      return `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span><span class="legend-icon">${icon}</span> ${escapeHtml(label)}</div>`;
    }).join('\n');

  const titleText = CRIBCLAW_BABY_NAME
    ? `CribClaw.com \u00B7 ${escapeHtml(CRIBCLAW_BABY_NAME)}`
    : 'CribClaw.com';
  const subtitleText = view === 'day' ? 'Daily Summary' : 'Weekly Summary';
  const dateRange = view === 'day'
    ? dayLabels[0]
    : `${dayLabels[0]} \u2013 ${dayLabels[dayLabels.length - 1]}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CribClaw Summary</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Pro Display', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #faf9f6;
    color: #1e293b;
  }
  .frame {
    width: ${CANVAS_WIDTH}px;
    padding: ${PADDING}px;
    background: #faf9f6;
  }

  /* Header */
  .header { margin-bottom: 32px; }
  .header-top {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-bottom: 6px;
  }
  .logo { font-size: 56px; line-height: 1; position: relative; top: 4px; }
  .title {
    font-size: 56px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #0f172a;
  }
  .subtitle-line {
    font-size: 24px;
    color: #64748b;
    font-weight: 500;
    margin-top: 6px;
  }

  /* Stat cards */
  .stats {
    display: flex;
    gap: 12px;
    margin-bottom: 28px;
    flex-wrap: wrap;
  }
  .stat-card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 130px;
  }
  .stat-icon {
    font-size: 38px;
    flex-shrink: 0;
  }
  .stat-info { flex: 1; }
  .stat-value {
    font-size: 42px;
    font-weight: 800;
    line-height: 1;
  }
  .stat-label {
    font-size: 15px;
    color: #94a3b8;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 3px;
  }

  /* Grid container */
  .grid-container {
    display: flex;
    margin-bottom: 24px;
  }

  /* Hour labels (Y-axis) */
  .hour-axis {
    width: 72px;
    flex-shrink: 0;
    position: relative;
    height: ${GRID_HEIGHT}px;
    margin-top: 56px;
  }
  .hour-line {
    position: absolute;
    left: 0;
    right: 0;
  }
  .hour-label {
    font-size: 16px;
    font-weight: 700;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
    position: absolute;
    right: 10px;
    top: -9px;
    white-space: nowrap;
  }

  /* Grid area */
  .grid-area {
    flex: 1;
    position: relative;
  }

  /* Day columns */
  .day-col {
    position: absolute;
    top: 0;
    bottom: 0;
  }
  .day-col-header {
    height: 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-bottom: 2px solid #cbd5e1;
  }
  .day-col-name {
    font-size: ${daysCount === 1 ? 22 : 18}px;
    font-weight: 800;
    color: #1e293b;
    letter-spacing: 0.01em;
  }
  .day-col-count {
    font-size: 12px;
    color: #94a3b8;
    font-weight: 600;
  }
  .day-col-track {
    position: absolute;
    top: 56px;
    bottom: 0;
    left: 0;
    right: 0;
    background: #ffffff;
  }
  .day-col-track.alt {
    background: #f7f8fa;
  }

  /* Grid lines */
  .grid-lines {
    position: absolute;
    top: 56px;
    left: 0;
    right: 0;
    height: ${GRID_HEIGHT}px;
    pointer-events: none;
  }
  .grid-hline {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid #e2e8f0;
  }
  .grid-hline-major {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid #cbd5e1;
  }

  /* Night shading */
  .night-shade {
    position: absolute;
    left: 0;
    right: 0;
    background: rgba(100, 116, 139, 0.06);
    pointer-events: none;
  }

  /* Day dividers */
  .day-divider {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #cbd5e1;
    pointer-events: none;
    z-index: 1;
  }

  /* Columns container */
  .columns-area {
    position: relative;
    height: ${GRID_HEIGHT + 56}px;
  }

  /* Event dots — larger with emoji inside */
  .event-dot {
    position: absolute;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    z-index: 3;
    box-shadow: 0 2px 6px rgba(0,0,0,0.2), 0 0 0 2px rgba(255,255,255,0.8);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dot-icon {
    filter: brightness(0) invert(1);
    line-height: 1;
  }

  /* Legend */
  .legend {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 20px;
    padding: 16px 20px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 18px;
    color: #334155;
    font-weight: 700;
  }
  .legend-swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }
  .legend-icon {
    font-size: 20px;
  }

  /* Footer */
  .footer {
    text-align: center;
    font-size: 16px;
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
      <div class="subtitle-line">${escapeHtml(subtitleText)} \u00B7 ${escapeHtml(dateRange)} \u00B7 ${escapeHtml(timeZone)} \u00B7 ${events.length} events</div>
    </div>
    <div class="stats">${statCards}</div>
    <div class="grid-container">
      <div class="hour-axis">
        ${hourLines}
      </div>
      <div class="grid-area">
        <div class="columns-area">
          ${dayColumns}
          <div class="grid-lines">
            ${hourMarks.map((h) => {
    const topPct = (h / 24) * 100;
    const cls = h % 6 === 0 ? 'grid-hline-major' : 'grid-hline';
    return `<div class="${cls}" style="top:${topPct}%"></div>`;
  }).join('\n')}
          </div>
          ${dayDividers}
        </div>
      </div>
    </div>
    <div class="legend">${legendItems}</div>
    <div class="footer">CribClaw.com \u00B7 Not a medical device</div>
  </div>
</body>
</html>`;
}

export function renderPngFromHtml(htmlPath: string, pngPath: string, width = 1600, height = 2400): boolean {
  const chromeCandidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ].filter(Boolean) as string[];

  for (const chrome of chromeCandidates) {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=2',
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ];
    const attempt = spawnSync(chrome, args, { stdio: 'pipe' });
    if (attempt.status === 0 && fs.existsSync(pngPath)) {
      return true;
    }
  }

  return false;
}

export function generateVisualSummary(
  chatJid: string,
  queryText: string,
  nowIso: string,
): {
  htmlPath: string;
  pngPath?: string;
  view: SummaryView;
  eventCount: number;
  timeZone: string;
} {
  const view = detectView(queryText);
  const { start, end } = buildRange(view, nowIso);
  const events = getBabyEventsInRange(chatJid, start.toISOString(), end.toISOString(), 2500);
  const timeZone = TIMEZONE;

  const outDir = path.join(STORE_DIR, 'reports', sanitize(chatJid));
  fs.mkdirSync(outDir, { recursive: true });
  const datePart = nowIso.slice(0, 10);
  const baseName = `auto-${view}-${datePart}`;
  const htmlPath = path.join(outDir, `${baseName}.html`);
  const pngPath = path.join(outDir, `${baseName}.png`);

  const html = renderCalendarHtml({
    events,
    view,
    timeZone,
    nowIso,
  });
  fs.writeFileSync(htmlPath, html, 'utf8');

  // 9:16 portrait aspect ratio for mobile viewing
  const canvasWidth = 1080;
  const canvasHeight = 1920;
  const renderedPng = renderPngFromHtml(htmlPath, pngPath, canvasWidth, canvasHeight);
  return {
    htmlPath,
    pngPath: renderedPng ? pngPath : undefined,
    view,
    eventCount: events.length,
    timeZone,
  };
}
