#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { spawnSync } from 'child_process';

import Database from 'better-sqlite3';

const PROJECT_ROOT = process.cwd();
const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');
const DEFAULT_WINDOW_WIDTH = 1600;
const DEFAULT_WINDOW_HEIGHT = 980;
const PHONE_WINDOW_WIDTH = 1080;
const PHONE_WINDOW_HEIGHT = 1920;
const EVENT_TYPES = ['feed', 'diaper', 'sleep_start', 'sleep_end', 'milestone', 'note', 'pump', 'tummy_time', 'solids', 'growth', 'bath'];
const EVENT_COLORS = {
  feed: '#16a34a',
  diaper: '#0ea5e9',
  sleep_start: '#6366f1',
  sleep_end: '#a855f7',
  milestone: '#f59e0b',
  note: '#64748b',
  pump: '#0d9488',
  tummy_time: '#ea580c',
  solids: '#65a30d',
  growth: '#1d4ed8',
  bath: '#06b6d4',
};

function sanitizePathPart(input) {
  return String(input).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + 1);
  return d;
}

function formatIso(date) {
  return date.toISOString();
}

function formatDateForFile(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatEventDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    if (found.status === 0 && found.stdout.trim()) {
      return candidate;
    }
  }
  return null;
}

function run() {
  const { values } = parseArgs({
    options: {
      chat: { type: 'string' },
      view: { type: 'string', default: 'day' },
      date: { type: 'string' },
      out: { type: 'string' },
      png: { type: 'boolean', default: false },
      phone: { type: 'boolean', default: false },
      listChats: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      [
        'CribClaw event report',
        '',
        'Usage:',
        '  npm run cribclaw:report -- --listChats',
        '  npm run cribclaw:report -- --chat tg:123456 --view day',
        '  npm run cribclaw:report -- --chat tg:123456 --view week --date 2026-02-24',
        '  npm run cribclaw:report -- --chat tg:123456 --view summary --png',
        '  npm run cribclaw:report -- --chat tg:123456 --view day --png --phone',
        '',
        'Options:',
        '  --chat <jid>       Chat JID (required unless --listChats)',
        '  --view <mode>      day | week | list | summary (default: day)',
        '  --date <YYYY-MM-DD or ISO> Anchor date (default: today, local time)',
        '  --out <file>       Output HTML path',
        '  --png              Also render PNG screenshot beside HTML',
        '  --phone            Use 9:16 mobile screenshot dimensions',
        '  --listChats        Print chats with baby events',
      ].join('\n'),
    );
    return;
  }

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}. Run CribClaw first to create logs.`);
  }

  const db = new Database(DB_PATH, { readonly: true });

  if (values.listChats) {
    const rows = db
      .prepare(
        `
        SELECT e.chat_jid, COALESCE(c.name, e.chat_jid) AS name, COUNT(*) AS event_count
        FROM baby_events e
        LEFT JOIN chats c ON c.jid = e.chat_jid
        GROUP BY e.chat_jid, c.name
        ORDER BY event_count DESC, e.chat_jid ASC
      `,
      )
      .all();
    if (rows.length === 0) {
      console.log('No baby event chats found yet.');
      return;
    }
    for (const row of rows) {
      console.log(`${row.chat_jid} | ${row.name} | events=${row.event_count}`);
    }
    return;
  }

  const chatJid = values.chat;
  if (!chatJid) {
    throw new Error('Missing --chat. Run with --listChats to find available chat IDs.');
  }

  const view = String(values.view || 'day').toLowerCase();
  if (!['day', 'week', 'list', 'summary'].includes(view)) {
    throw new Error(`Unsupported --view ${view}. Use day | week | list | summary.`);
  }

  const anchor = values.date ? parseDate(values.date) : new Date();
  let rangeStart = startOfDay(anchor);
  let rangeEnd = endOfDay(anchor);
  if (view === 'week') {
    rangeEnd = endOfDay(anchor);
    rangeStart = new Date(rangeEnd);
    rangeStart.setDate(rangeStart.getDate() - 7);
  }
  if (view === 'list' || view === 'summary') {
    rangeEnd = endOfDay(anchor);
    rangeStart = new Date(rangeEnd);
    rangeStart.setDate(rangeStart.getDate() - 7);
  }

  const events = db
    .prepare(
      `
      SELECT id, event_type, logged_at, occurred_at, sender_name, summary
      FROM baby_events
      WHERE chat_jid = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at ASC, id ASC
    `,
    )
    .all(chatJid, formatIso(rangeStart), formatIso(rangeEnd));

  const counts = {};
  for (const type of EVENT_TYPES) {
    counts[type] = 0;
  }
  for (const event of events) {
    counts[event.event_type] = (counts[event.event_type] || 0) + 1;
  }

  const reportDir = path.join(STORE_DIR, 'reports', sanitizePathPart(chatJid));
  fs.mkdirSync(reportDir, { recursive: true });
  const datePart = formatDateForFile(anchor);
  const defaultHtml = path.join(reportDir, `event-${view}-${datePart}.html`);
  const outHtml = values.out ? path.resolve(PROJECT_ROOT, values.out) : defaultHtml;
  fs.mkdirSync(path.dirname(outHtml), { recursive: true });
  const outSvg = outHtml.replace(/\.html?$/i, '.svg');

  const isPhone = Boolean(values.phone);
  const timelineSvg = buildTimelineSvg({
    events,
    view,
    rangeStart,
    rangeEnd,
    width: isPhone ? 960 : 1500,
    height: 520,
  });

  const cards = EVENT_TYPES.map(
    (type) =>
      `<div class="card"><div class="label">${escapeHtml(type)}</div><div class="value">${counts[type] || 0}</div></div>`,
  ).join('\n');

  const tableRows = events
    .map(
      (event) => `
    <tr>
      <td>${escapeHtml(formatEventDateTime(event.logged_at || event.occurred_at))}</td>
      <td>${escapeHtml(formatEventDateTime(event.occurred_at))}</td>
      <td><span class="dot" style="background:${EVENT_COLORS[event.event_type] || '#64748b'}"></span>${escapeHtml(event.event_type)}</td>
      <td>${escapeHtml(event.sender_name)}</td>
      <td>${escapeHtml(event.summary)}</td>
    </tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CribClaw Event Report</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; background: #f7fafc; color: #0f172a; }
    .wrap { max-width: 1560px; margin: 0 auto; padding: 22px; }
    .header { display: grid; gap: 4px; margin-bottom: 16px; }
    .title { font-size: 26px; font-weight: 800; }
    .sub { font-size: 14px; color: #475569; }
    .cards { display: grid; grid-template-columns: repeat(7, minmax(120px, 1fr)); gap: 10px; margin: 14px 0 18px; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; }
    .card .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
    .panel { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; margin-bottom: 16px; overflow: auto; }
    .panel h2 { margin: 4px 0 10px; font-size: 17px; }
    .timeline svg { width: 100%; height: auto; display: block; }
    table { width: 100%; border-collapse: collapse; background: white; }
    th, td { border-bottom: 1px solid #e2e8f0; text-align: left; padding: 9px 8px; font-size: 13px; vertical-align: top; }
    th { color: #334155; background: #f8fafc; position: sticky; top: 0; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
    @media (max-width: 780px) {
      .wrap { padding: 12px; }
      .title { font-size: 22px; line-height: 1.2; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .panel { padding: 10px; }
      th, td { font-size: 12px; padding: 7px 6px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="title">CribClaw.com Event Report (${escapeHtml(view)})</div>
      <div class="sub">Chat: ${escapeHtml(chatJid)}</div>
      <div class="sub">Range: ${escapeHtml(rangeStart.toISOString())} to ${escapeHtml(rangeEnd.toISOString())}</div>
      <div class="sub">Total events: ${events.length}</div>
    </div>
    <div class="cards">${cards}</div>
    <div class="panel timeline">
      <h2>Timeline</h2>
      ${timelineSvg}
    </div>
    <div class="panel">
      <h2>Event List</h2>
      <table>
        <thead><tr><th>Logged At</th><th>Event At</th><th>Type</th><th>Logged by</th><th>Summary</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="5">No events in this range.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
  <p style="text-align:center;font-size:12px;color:#94a3b8;margin:24px 0 12px;">Not a medical device. For informational purposes only.</p>
</body>
</html>`;

  fs.writeFileSync(outHtml, html, 'utf8');
  fs.writeFileSync(outSvg, timelineSvg, 'utf8');
  console.log(`HTML report: ${outHtml}`);
  console.log(`SVG chart: ${outSvg}`);

  if (values.png) {
    const outPng = outHtml.replace(/\.html?$/i, '.png');
    const chrome = findChromeBinary();
    if (!chrome) {
      console.warn('PNG skipped: Chrome/Chromium not found. Set CHROME_BIN to your browser path.');
      return;
    }

    const fileUrl = `file://${outHtml}`;
    const windowWidth = isPhone ? PHONE_WINDOW_WIDTH : DEFAULT_WINDOW_WIDTH;
    const windowHeight = isPhone ? PHONE_WINDOW_HEIGHT : DEFAULT_WINDOW_HEIGHT;
    const attempts = [
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        `--window-size=${windowWidth},${windowHeight}`,
        `--screenshot=${outPng}`,
        fileUrl,
      ],
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        `--window-size=${windowWidth},${windowHeight}`,
        `--screenshot=${outPng}`,
        fileUrl,
      ],
    ];

    let rendered = false;
    for (const args of attempts) {
      const shot = spawnSync(chrome, args, { stdio: 'pipe', encoding: 'utf8' });
      if (shot.status === 0) {
        rendered = true;
        break;
      }
      if (shot.stderr?.trim()) {
        console.warn(shot.stderr.trim());
      }
    }

    if (!rendered) {
      console.warn(`PNG render failed via ${chrome}. HTML report is still available.`);
      return;
    }

    console.log(`PNG screenshot: ${outPng}`);
  }
}

function buildTimelineSvg({ events, view, rangeStart, rangeEnd, width, height }) {
  const margin = { top: 36, right: 26, bottom: 44, left: 140 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const laneHeight = plotHeight / EVENT_TYPES.length;
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  const spanMs = Math.max(1, endMs - startMs);

  const yForType = (type) => {
    const idx = EVENT_TYPES.indexOf(type);
    return margin.top + (idx < 0 ? EVENT_TYPES.length - 1 : idx) * laneHeight + laneHeight / 2;
  };
  const xForTime = (iso) => {
    const t = new Date(iso).getTime();
    const ratio = Math.min(1, Math.max(0, (t - startMs) / spanMs));
    return margin.left + ratio * plotWidth;
  };

  const horizontalGrid = EVENT_TYPES.map((type, idx) => {
    const y = margin.top + idx * laneHeight;
    const yLabel = y + laneHeight / 2 + 4;
    return `
      <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e2e8f0" />
      <text x="${margin.left - 10}" y="${yLabel}" text-anchor="end" font-size="12" fill="#334155">${escapeHtml(type)}</text>
    `;
  }).join('\n');

  const ticks = [];
  const tickCount = view === 'day' ? 8 : 7;
  for (let i = 0; i <= tickCount; i += 1) {
    const ratio = i / tickCount;
    const x = margin.left + ratio * plotWidth;
    const tickMs = startMs + ratio * spanMs;
    const date = new Date(tickMs);
    const label =
      view === 'day'
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : `${date.getMonth() + 1}/${date.getDate()}`;
    ticks.push(`
      <line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#f1f5f9" />
      <text x="${x}" y="${height - margin.bottom + 18}" text-anchor="middle" font-size="11" fill="#64748b">${label}</text>
    `);
  }

  const dots = events
    .map((event) => {
      const x = xForTime(event.occurred_at);
      const y = yForType(event.event_type);
      const color = EVENT_COLORS[event.event_type] || '#64748b';
      const title = `logged ${formatEventDateTime(event.logged_at || event.occurred_at)} | event ${formatEventDateTime(event.occurred_at)} | ${event.event_type} | ${event.summary}`;
      return `<circle cx="${x}" cy="${y}" r="5.2" fill="${color}"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join('\n');

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="CribClaw event timeline">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="#fcfdff" stroke="#e2e8f0" />
  ${ticks.join('\n')}
  ${horizontalGrid}
  ${dots}
</svg>
`.trim();
}

run();
