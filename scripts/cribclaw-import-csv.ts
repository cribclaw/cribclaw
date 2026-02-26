/**
 * Import baby tracking data from CSV exports (Huckleberry, Glow, Baby Tracker, etc.)
 *
 * Usage:
 *   npx tsx scripts/cribclaw-import-csv.ts <csv-file> [--chat-jid <jid>] [--sender <name>] [--dry-run]
 *
 * Imports by default. Use --dry-run to preview without writing.
 *
 * Supported formats (auto-detected from column headers):
 *   - Huckleberry (Type, Start Time, End Time, Duration, ...)
 *   - Glow Baby (Activity, Start, End, Duration, Notes, ...)
 *   - Baby Tracker (Type/Activity, Time/Date, Duration, Amount, ...)
 *   - BabyBuddy (separate CSVs per type)
 *   - Generic (any CSV with recognizable date + event columns)
 *
 * The importer auto-detects the format from column headers and maps rows
 * to CribClaw event types (feed, diaper, sleep_start, sleep_end, etc.).
 */

import fs from 'fs';
import path from 'path';

import { initDatabase, insertBabyEvent, getAllChats, BabyEventInput } from '../src/db.js';

// ---------------------------------------------------------------------------
// CSV parser (no deps)
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

type DetectedFormat =
  | 'huckleberry'
  | 'glow'
  | 'baby_tracker'
  | 'babybuddy'
  | 'generic';

function detectFormat(headers: string[]): DetectedFormat {
  const lower = new Set(headers.map((h) => h.toLowerCase().trim()));

  // Huckleberry: "Type", "Start Time"/"Start", "End Time"/"End", "Duration", "Start Condition", "End Condition"
  if (lower.has('type') && (lower.has('start time') || (lower.has('start') && lower.has('start condition')))) {
    return 'huckleberry';
  }

  // Glow Baby: "Activity", "Start", "End", "Duration", "Notes"
  if (lower.has('activity') && (lower.has('start') || lower.has('start date'))) {
    return 'glow';
  }

  // BabyBuddy: "Date", "Type" or specific column names like "Wet", "Solid"
  if (lower.has('date') && (lower.has('wet') || lower.has('solid') || lower.has('type'))) {
    return 'babybuddy';
  }

  // Baby Tracker app: usually "Time" + type keywords
  if (lower.has('time') && (lower.has('type') || lower.has('activity'))) {
    return 'baby_tracker';
  }

  return 'generic';
}

// ---------------------------------------------------------------------------
// Column mapping per format
// ---------------------------------------------------------------------------

interface MappedEvent {
  eventType: string;
  occurredAt: string;
  endAt?: string;
  summary: string;
  attributes: Record<string, string | number | boolean>;
}

function findColumn(row: Record<string, string>, ...candidates: string[]): string {
  for (const candidate of candidates) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase().trim() === candidate.toLowerCase()) {
        return row[key] || '';
      }
    }
  }
  return '';
}

function parseFlexibleDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();

  // Try MM/DD/YYYY HH:MM AM/PM
  const usMatch = raw.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (usMatch) {
    let [, month, day, year, hours, minutes, seconds, meridian] = usMatch;
    if (year.length === 2) year = `20${year}`;
    let h = parseInt(hours, 10);
    if (meridian?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (meridian?.toLowerCase() === 'am' && h === 12) h = 0;
    const d2 = new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      h,
      parseInt(minutes, 10),
      parseInt(seconds || '0', 10),
    );
    if (!isNaN(d2.getTime())) return d2.toISOString();
  }

  return null;
}

function mapEventType(rawType: string): string {
  const lower = rawType.toLowerCase().trim();

  if (/^(feed|feeding|bottle|nurse|nursing|breast|formula)/.test(lower)) return 'feed';
  if (/^(diaper|nappy)/.test(lower)) return 'diaper';
  if (/^(sleep|nap)/.test(lower)) return 'sleep_start'; // will produce sleep_end too
  if (/^(pump|express)/.test(lower)) return 'pump';
  if (/^(tummy|tummy time)/.test(lower)) return 'tummy_time';
  if (/^(bath|wash)/.test(lower)) return 'bath';
  if (/^(solid|puree|cereal|baby food)/.test(lower)) return 'solids';
  if (/^(growth|weight|height|measure)/.test(lower)) return 'growth';
  if (/^(milestone)/.test(lower)) return 'milestone';

  return 'note';
}

function parseDurationMinutes(raw: string): number | null {
  if (!raw) return null;

  // "1h 30m", "1:30", "90 min", "1.5 hours"
  const hmMatch = raw.match(/(\d+)\s*h\w*\s*(\d+)\s*m/i);
  if (hmMatch) return parseInt(hmMatch[1], 10) * 60 + parseInt(hmMatch[2], 10);

  const colonMatch = raw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (colonMatch) return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);

  const minMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:min|minutes?|m)\b/i);
  if (minMatch) return Math.round(parseFloat(minMatch[1]));

  const hrMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
  if (hrMatch) return Math.round(parseFloat(hrMatch[1]) * 60);

  const plain = parseFloat(raw);
  if (!isNaN(plain) && plain > 0 && plain < 1440) return Math.round(plain);

  return null;
}

function parseAmount(raw: string): { amount_oz?: number; amount_ml?: number } {
  const result: { amount_oz?: number; amount_ml?: number } = {};
  const ozMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/i);
  if (ozMatch) {
    result.amount_oz = parseFloat(ozMatch[1]);
    result.amount_ml = Math.round(result.amount_oz * 29.5735);
  }
  const mlMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:ml|milliliters?)\b/i);
  if (mlMatch) {
    result.amount_ml = parseFloat(mlMatch[1]);
    if (!result.amount_oz) result.amount_oz = parseFloat((result.amount_ml / 29.5735).toFixed(2));
  }
  // Plain number — guess oz if < 20, ml otherwise
  if (!result.amount_oz && !result.amount_ml) {
    const plain = parseFloat(raw);
    if (!isNaN(plain) && plain > 0) {
      if (plain < 20) {
        result.amount_oz = plain;
        result.amount_ml = Math.round(plain * 29.5735);
      } else {
        result.amount_ml = plain;
        result.amount_oz = parseFloat((plain / 29.5735).toFixed(2));
      }
    }
  }
  return result;
}

function mapHuckleberry(row: Record<string, string>): MappedEvent[] {
  const type = findColumn(row, 'Type');
  const startTime = findColumn(row, 'Start Time', 'Start');
  const endTime = findColumn(row, 'End Time', 'End');
  const duration = findColumn(row, 'Duration');
  const amount = findColumn(row, 'Amount', 'Oz', 'ML', 'End Condition');
  const notes = findColumn(row, 'Notes', 'Note');
  const side = findColumn(row, 'Side', 'Start Location');
  const condition = findColumn(row, 'Start Condition', 'Condition');

  const occurredAt = parseFlexibleDate(startTime);
  if (!occurredAt) return [];

  const endAtParsed = parseFlexibleDate(endTime);
  const eventType = mapEventType(type);
  const attributes: Record<string, string | number | boolean> = { import_source: 'huckleberry' };

  if (side) attributes.side = side.toLowerCase();
  if (condition) attributes.condition = condition;
  if (notes) attributes.notes = notes;

  const durationMin = parseDurationMinutes(duration);
  if (durationMin) attributes.duration_minutes = durationMin;

  if (eventType === 'feed') {
    if (amount) Object.assign(attributes, parseAmount(amount));
    if (condition) attributes.feed_type = condition.toLowerCase();
    if (side) attributes.feed_method = side.toLowerCase();
  }

  if (eventType === 'diaper') {
    // Parse Huckleberry diaper notes like "Both, pee:medium poo:large"
    const diaperInfo = (notes || amount || '').toLowerCase();
    if (/pee|wet|urine/.test(diaperInfo)) attributes.wet = true;
    if (/poo|dirty|bm|stool/.test(diaperInfo)) attributes.dirty = true;
    if (/both/.test(diaperInfo)) { attributes.wet = true; attributes.dirty = true; }
  }

  // Sleep events produce both start and end
  if (eventType === 'sleep_start' && endAtParsed) {
    return [
      { eventType: 'sleep_start', occurredAt, summary: `Import: ${type}`, attributes },
      {
        eventType: 'sleep_end',
        occurredAt: endAtParsed,
        summary: `Import: ${type} end`,
        attributes: { ...attributes, ...(durationMin ? { duration_minutes: durationMin } : {}) },
      },
    ];
  }

  const summaryParts = [type];
  if (amount) summaryParts.push(amount);
  if (notes) summaryParts.push(notes);

  return [{ eventType, occurredAt, summary: `Import: ${summaryParts.join(' - ')}`, attributes }];
}

function mapGlow(row: Record<string, string>): MappedEvent[] {
  const activity = findColumn(row, 'Activity', 'Type');
  const start = findColumn(row, 'Start', 'Start Date', 'Start Time', 'Date');
  const end = findColumn(row, 'End', 'End Date', 'End Time');
  const duration = findColumn(row, 'Duration');
  const amount = findColumn(row, 'Amount', 'Oz', 'ML', 'Volume');
  const notes = findColumn(row, 'Notes', 'Note', 'Details');

  const occurredAt = parseFlexibleDate(start);
  if (!occurredAt) return [];

  const endAtParsed = parseFlexibleDate(end);
  const eventType = mapEventType(activity);
  const attributes: Record<string, string | number | boolean> = { import_source: 'glow' };

  if (notes) attributes.notes = notes;
  const durationMin = parseDurationMinutes(duration);
  if (durationMin) attributes.duration_minutes = durationMin;

  if (eventType === 'feed' && amount) {
    Object.assign(attributes, parseAmount(amount));
  }

  if (eventType === 'sleep_start' && endAtParsed) {
    return [
      { eventType: 'sleep_start', occurredAt, summary: `Import: ${activity}`, attributes },
      {
        eventType: 'sleep_end',
        occurredAt: endAtParsed,
        summary: `Import: ${activity} end`,
        attributes: { ...attributes, ...(durationMin ? { duration_minutes: durationMin } : {}) },
      },
    ];
  }

  return [{ eventType, occurredAt, summary: `Import: ${activity}${amount ? ` ${amount}` : ''}`, attributes }];
}

function mapGeneric(row: Record<string, string>): MappedEvent[] {
  // Try to find any date-like column and any type-like column
  let dateVal = '';
  let typeVal = '';
  let notesVal = '';

  for (const [key, value] of Object.entries(row)) {
    const lower = key.toLowerCase();
    if (/date|time|start|when|occurred/.test(lower) && value && !dateVal) {
      dateVal = value;
    }
    if (/type|activity|event|category|kind/.test(lower) && value && !typeVal) {
      typeVal = value;
    }
    if (/note|comment|detail|description|memo/.test(lower) && value) {
      notesVal = value;
    }
  }

  const occurredAt = parseFlexibleDate(dateVal);
  if (!occurredAt) return [];

  const eventType = typeVal ? mapEventType(typeVal) : 'note';
  const attributes: Record<string, string | number | boolean> = { import_source: 'generic' };
  if (notesVal) attributes.notes = notesVal;

  // Carry over any amount-like columns
  for (const [key, value] of Object.entries(row)) {
    const lower = key.toLowerCase();
    if (/amount|volume|oz|ml|quantity/.test(lower) && value) {
      Object.assign(attributes, parseAmount(value));
    }
    if (/duration|length|minutes/.test(lower) && value) {
      const dur = parseDurationMinutes(value);
      if (dur) attributes.duration_minutes = dur;
    }
    if (/wet|pee/.test(lower) && /true|yes|1|x/i.test(value)) {
      attributes.wet = true;
    }
    if (/dirty|poop|solid|bm/.test(lower) && /true|yes|1|x/i.test(value)) {
      attributes.dirty = true;
    }
  }

  return [{ eventType, occurredAt, summary: `Import: ${typeVal || 'entry'}${notesVal ? ` - ${notesVal}` : ''}`, attributes }];
}

function mapRow(format: DetectedFormat, row: Record<string, string>): MappedEvent[] {
  switch (format) {
    case 'huckleberry':
      return mapHuckleberry(row);
    case 'glow':
      return mapGlow(row);
    case 'baby_tracker':
    case 'babybuddy':
    case 'generic':
      return mapGeneric(row);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  csvFile: string;
  chatJid: string;
  sender: string;
  senderName: string;
  dryRun: boolean;
} {
  const dryRun = argv.includes('--dry-run');
  let csvFile = '';
  let chatJid = '';
  let sender = 'import';
  let senderName = 'CSV Import';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chat-jid' && argv[i + 1]) {
      chatJid = argv[++i];
    } else if (argv[i] === '--sender' && argv[i + 1]) {
      senderName = argv[++i];
      sender = `import:${senderName.toLowerCase().replace(/\s+/g, '_')}`;
    } else if (!argv[i].startsWith('--') && !csvFile) {
      csvFile = argv[i];
    }
  }

  return { csvFile, chatJid, sender, senderName, dryRun };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.csvFile) {
    console.error('Usage: npx tsx scripts/cribclaw-import-csv.ts <csv-file> [--chat-jid <jid>] [--sender <name>] [--apply]');
    console.error('');
    console.error('Options:');
    console.error('  --chat-jid <jid>   Target chat JID (default: auto-detect from DB or "tg:import")');
    console.error('  --sender <name>    Sender name for imported events (default: "CSV Import")');
    console.error('  --dry-run          Preview without writing to DB');
    console.error('');
    console.error('Supported formats: Huckleberry, Glow Baby, Baby Tracker, BabyBuddy, generic CSV');
    process.exit(1);
  }

  if (!fs.existsSync(args.csvFile)) {
    console.error(`File not found: ${args.csvFile}`);
    process.exit(1);
  }

  initDatabase();

  const content = fs.readFileSync(args.csvFile, 'utf8');
  const rows = parseCsv(content);

  if (rows.length === 0) {
    console.error('No data rows found in CSV.');
    process.exit(1);
  }

  const headers = Object.keys(rows[0]);
  const format = detectFormat(headers);
  console.log(`Detected format: ${format}`);
  console.log(`Columns: ${headers.join(', ')}`);
  console.log(`Rows: ${rows.length}`);
  console.log('');

  // Auto-detect chat JID from existing data if not provided
  let chatJid = args.chatJid;
  if (!chatJid) {
    const chats = getAllChats();
    if (chats.length === 1) {
      chatJid = chats[0].jid;
      console.log(`Auto-detected chat JID: ${chatJid}`);
    } else if (chats.length > 1) {
      console.log('Multiple chats found. Please specify --chat-jid:');
      for (const chat of chats) {
        console.log(`  ${chat.jid} (${chat.name || 'unnamed'})`);
      }
      process.exit(1);
    } else {
      chatJid = 'tg:import';
      console.log(`No existing chats. Using default: ${chatJid}`);
    }
  }

  const mapped: MappedEvent[] = [];
  let skipped = 0;

  for (const row of rows) {
    const events = mapRow(format, row);
    if (events.length === 0) {
      skipped++;
      continue;
    }
    mapped.push(...events);
  }

  // Show summary by type
  const typeCounts = new Map<string, number>();
  for (const event of mapped) {
    typeCounts.set(event.eventType, (typeCounts.get(event.eventType) || 0) + 1);
  }

  console.log('\nEvent breakdown:');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  (skipped: ${skipped} rows with no parseable date)`);
  console.log(`  Total: ${mapped.length} events`);

  if (args.dryRun) {
    console.log('\nDry run. Remove --dry-run to import.');

    // Show first 5 events as preview
    console.log('\nPreview (first 5):');
    for (const event of mapped.slice(0, 5)) {
      console.log(`  ${event.eventType} @ ${event.occurredAt} — ${event.summary}`);
    }
    return;
  }

  console.log('\nImporting...');
  let imported = 0;
  let errors = 0;

  for (const event of mapped) {
    try {
      const input: BabyEventInput = {
        chat_jid: chatJid,
        message_id: `import-${Date.now()}-${imported}`,
        sender: args.sender,
        sender_name: args.senderName,
        event_type: event.eventType as BabyEventInput['event_type'],
        logged_at: new Date().toISOString(),
        occurred_at: event.occurredAt,
        summary: event.summary,
        source_content: `CSV import from ${path.basename(args.csvFile)}`,
        confidence: 0.95,
        attributes: event.attributes,
      };
      insertBabyEvent(input);
      imported++;
    } catch (err) {
      errors++;
      if (errors <= 3) {
        console.warn(`  Error importing event: ${err}`);
      }
    }
  }

  console.log(`\nDone. Imported: ${imported}, Errors: ${errors}`);
}

/**
 * Programmatic import for use from index.ts (CSV sent via Telegram chat).
 * Returns a human-readable result message.
 */
export function importCsvFile(
  csvFilePath: string,
  chatJid: string,
  senderName = 'CSV Import',
): string {
  if (!fs.existsSync(csvFilePath)) {
    return `File not found: ${csvFilePath}`;
  }

  const content = fs.readFileSync(csvFilePath, 'utf8');
  const rows = parseCsv(content);

  if (rows.length === 0) {
    return 'No data rows found in CSV.';
  }

  const headers = Object.keys(rows[0]);
  const format = detectFormat(headers);

  const mapped: MappedEvent[] = [];
  let skipped = 0;

  for (const row of rows) {
    const events = mapRow(format, row);
    if (events.length === 0) {
      skipped++;
      continue;
    }
    mapped.push(...events);
  }

  if (mapped.length === 0) {
    return `Could not parse any events from CSV (${rows.length} rows, ${skipped} skipped). Format detected: ${format}.`;
  }

  let imported = 0;
  let errors = 0;

  for (const event of mapped) {
    try {
      const input: BabyEventInput = {
        chat_jid: chatJid,
        message_id: `import-${Date.now()}-${imported}`,
        sender: `import:${senderName.toLowerCase().replace(/\s+/g, '_')}`,
        sender_name: senderName,
        event_type: event.eventType as BabyEventInput['event_type'],
        logged_at: new Date().toISOString(),
        occurred_at: event.occurredAt,
        summary: event.summary,
        source_content: `CSV import from ${path.basename(csvFilePath)}`,
        confidence: 0.95,
        attributes: event.attributes,
      };
      insertBabyEvent(input);
      imported++;
    } catch {
      errors++;
    }
  }

  const typeCounts = new Map<string, number>();
  for (const event of mapped) {
    typeCounts.set(event.eventType, (typeCounts.get(event.eventType) || 0) + 1);
  }
  const breakdown = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');

  return `Imported ${imported} events from ${path.basename(csvFilePath)} (${format} format): ${breakdown}.${errors > 0 ? ` ${errors} errors.` : ''}${skipped > 0 ? ` ${skipped} rows skipped.` : ''}`;
}

// Only run CLI main when executed directly
if (process.argv[1]?.endsWith('cribclaw-import-csv.ts') || process.argv[1]?.endsWith('cribclaw-import-csv.js')) {
  main();
}
