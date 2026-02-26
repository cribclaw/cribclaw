import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

export type BabyEventType =
  | 'feed'
  | 'diaper'
  | 'sleep_start'
  | 'sleep_end'
  | 'milestone'
  | 'note'
  | 'pump'
  | 'tummy_time'
  | 'solids'
  | 'growth'
  | 'bath';

export interface BabyEventInput {
  chat_jid: string;
  message_id: string;
  sender: string;
  sender_name: string;
  event_type: BabyEventType;
  logged_at: string;
  occurred_at: string;
  summary: string;
  source_content: string;
  confidence: number;
  attributes: Record<string, string | number | boolean>;
}

export interface BabyEventRow {
  id: number;
  event_type: BabyEventType;
  logged_at?: string;
  occurred_at: string;
  summary: string;
  sender_name: string;
}

export interface BabyEventDetailRow {
  id: number;
  chat_jid?: string;
  message_id?: string;
  sender?: string;
  event_type: BabyEventType;
  logged_at?: string;
  occurred_at: string;
  summary: string;
  sender_name: string;
  source_content?: string;
  confidence?: number;
  created_at?: string;
}

export interface BabyEventAmendmentResult {
  id: number;
  event_type: BabyEventType;
  previous_occurred_at: string;
  occurred_at: string;
}

export interface CribclawReminderRow {
  id: number;
  chat_jid: string;
  sender: string;
  sender_name: string;
  action_text: string;
  due_at: string;
  interval_minutes: number | null;
  status: 'active' | 'completed' | 'canceled';
  last_sent_at: string | null;
  created_at: string;
}

export interface FeedIntakeTotals {
  feedCount: number;
  feedsWithVolume: number;
  feedsMissingVolume: number;
  totalMl: number;
  totalOz: number;
}

const ML_PER_OZ = 29.5735;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS baby_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_content TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_jid, message_id, event_type)
    );
    CREATE INDEX IF NOT EXISTS idx_baby_events_chat_time ON baby_events(chat_jid, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_baby_events_chat_type_time ON baby_events(chat_jid, event_type, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS baby_event_attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      attribute_key TEXT NOT NULL,
      value_text TEXT NOT NULL,
      value_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(event_id) REFERENCES baby_events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_baby_event_attributes_event ON baby_event_attributes(event_id);

    CREATE TABLE IF NOT EXISTS baby_attribute_registry (
      attribute_key TEXT PRIMARY KEY,
      inferred_type TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS baby_sleep_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      start_event_id INTEGER NOT NULL UNIQUE,
      end_event_id INTEGER UNIQUE,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(start_event_id) REFERENCES baby_events(id),
      FOREIGN KEY(end_event_id) REFERENCES baby_events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_baby_sleep_sessions_chat_started ON baby_sleep_sessions(chat_jid, started_at DESC);

    CREATE TABLE IF NOT EXISTS baby_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      event_id INTEGER,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(event_id) REFERENCES baby_events(id)
    );

    CREATE TABLE IF NOT EXISTS cribclaw_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      action_text TEXT NOT NULL,
      due_at TEXT NOT NULL,
      interval_minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      last_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cribclaw_reminders_due ON cribclaw_reminders(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_cribclaw_reminders_chat_status ON cribclaw_reminders(chat_jid, status);

    CREATE TABLE IF NOT EXISTS baby_growth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      measured_at TEXT NOT NULL,
      weight_kg REAL,
      weight_lb REAL,
      height_cm REAL,
      height_in REAL,
      head_cm REAL,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_baby_growth_chat_time ON baby_growth(chat_jid, measured_at);

    CREATE TABLE IF NOT EXISTS baby_pump_stash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      amount_oz REAL NOT NULL DEFAULT 0,
      amount_ml REAL NOT NULL DEFAULT 0,
      location TEXT DEFAULT 'freezer',
      expires_at TEXT,
      used_at TEXT,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_baby_pump_stash_chat ON baby_pump_stash(chat_jid, used_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN channel TEXT`,
    );
    database.exec(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from JID patterns
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }

  // Add logged_at column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE baby_events ADD COLUMN logged_at TEXT`);
  } catch {
    /* column already exists */
  }

  // Backfill logged_at from message timestamp when available.
  database.exec(`
    UPDATE baby_events
    SET logged_at = COALESCE(
      (
        SELECT m.timestamp
        FROM messages m
        WHERE m.id = baby_events.message_id
          AND m.chat_jid = baby_events.chat_jid
        LIMIT 1
      ),
      occurred_at,
      created_at
    )
    WHERE logged_at IS NULL OR logged_at = ''
  `);

  // Create logged_at index after migration so existing DBs don't fail startup.
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_baby_events_chat_logged_time ON baby_events(chat_jid, logged_at DESC)`,
  );
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

function closeOpenBabySleepSession(
  chatJid: string,
  endEventId: number,
  endedAt: string,
): void {
  const openSession = db
    .prepare(
      `
      SELECT id, started_at
      FROM baby_sleep_sessions
      WHERE chat_jid = ? AND end_event_id IS NULL AND started_at <= ?
      ORDER BY started_at DESC
      LIMIT 1
    `,
    )
    .get(chatJid, endedAt) as { id: number; started_at: string } | undefined;

  if (!openSession) {
    return;
  }

  const durationMinutes = Math.max(
    0,
    (Date.parse(endedAt) - Date.parse(openSession.started_at)) / 60000,
  );

  db.prepare(
    `
    UPDATE baby_sleep_sessions
    SET end_event_id = ?, ended_at = ?, duration_minutes = ?
    WHERE id = ?
  `,
  ).run(endEventId, endedAt, durationMinutes, openSession.id);
}

function rebuildSleepSessions(chatJid: string): void {
  db.prepare(`DELETE FROM baby_sleep_sessions WHERE chat_jid = ?`).run(chatJid);
  const rows = db
    .prepare(
      `
      SELECT id, event_type, occurred_at
      FROM baby_events
      WHERE chat_jid = ? AND event_type IN ('sleep_start', 'sleep_end')
      ORDER BY occurred_at ASC, id ASC
    `,
    )
    .all(chatJid) as Array<{
    id: number;
    event_type: BabyEventType;
    occurred_at: string;
  }>;

  const insertClosed = db.prepare(
    `
    INSERT INTO baby_sleep_sessions (chat_jid, start_event_id, end_event_id, started_at, ended_at, duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  );
  const insertOpen = db.prepare(
    `
    INSERT INTO baby_sleep_sessions (chat_jid, start_event_id, started_at)
    VALUES (?, ?, ?)
  `,
  );

  let openStart:
    | {
        id: number;
        occurred_at: string;
      }
    | undefined;

  for (const row of rows) {
    if (row.event_type === 'sleep_start') {
      if (!openStart) {
        openStart = {
          id: row.id,
          occurred_at: row.occurred_at,
        };
      }
      continue;
    }

    if (row.event_type === 'sleep_end' && openStart) {
      const durationMinutes = Math.max(
        0,
        (Date.parse(row.occurred_at) - Date.parse(openStart.occurred_at)) / 60000,
      );
      insertClosed.run(
        chatJid,
        openStart.id,
        row.id,
        openStart.occurred_at,
        row.occurred_at,
        durationMinutes,
      );
      openStart = undefined;
    }
  }

  if (openStart) {
    insertOpen.run(chatJid, openStart.id, openStart.occurred_at);
  }
}

function recordBabyAttribute(attributeKey: string, inferredType: string): void {
  db.prepare(
    `
    INSERT INTO baby_attribute_registry (attribute_key, inferred_type, first_seen_at, last_seen_at, seen_count)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(attribute_key) DO UPDATE SET
      inferred_type = excluded.inferred_type,
      last_seen_at = CURRENT_TIMESTAMP,
      seen_count = baby_attribute_registry.seen_count + 1
  `,
  ).run(attributeKey, inferredType);
}

function logBabyAudit(
  action: string,
  chatJid: string,
  sender: string | null,
  eventId: number | null,
  details: string,
): void {
  db.prepare(
    `
    INSERT INTO baby_audit_log (action, chat_jid, sender, event_id, details)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(action, chatJid, sender, eventId, details);
}

function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  if (!/[",\n]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

function chatExportDir(chatJid: string): string {
  const safe = chatJid.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(STORE_DIR, 'exports', safe);
}

function eventTypeToCsvFile(eventType: BabyEventType): string {
  if (eventType === 'sleep_start' || eventType === 'sleep_end') {
    return 'sleep';
  }
  return eventType;
}

function writeCsv(
  filePath: string,
  columns: string[],
  rows: Array<Record<string, string>>,
): void {
  const lines = [
    columns.map(csvEscape).join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] || '')).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

export function exportBabyCsvSnapshots(chatJid: string): void {
  const events = db
    .prepare(
      `
      SELECT id, event_type, logged_at, occurred_at, sender, sender_name, summary, source_content, confidence
      FROM baby_events
      WHERE chat_jid = ?
      ORDER BY occurred_at ASC, id ASC
    `,
    )
    .all(chatJid) as Array<{
    id: number;
    event_type: BabyEventType;
    logged_at: string;
    occurred_at: string;
    sender: string;
    sender_name: string;
    summary: string;
    source_content: string;
    confidence: number;
  }>;

  const attrs = db
    .prepare(
      `
      SELECT event_id, attribute_key, value_text
      FROM baby_event_attributes
      WHERE event_id IN (
        SELECT id FROM baby_events WHERE chat_jid = ?
      )
    `,
    )
    .all(chatJid) as Array<{
    event_id: number;
    attribute_key: string;
    value_text: string;
  }>;

  const attrsByEvent = new Map<number, Record<string, string>>();
  for (const attr of attrs) {
    const record = attrsByEvent.get(attr.event_id) || {};
    record[attr.attribute_key] = attr.value_text;
    attrsByEvent.set(attr.event_id, record);
  }

  type CsvBucket = {
    dynamicColumns: Set<string>;
    rows: Array<Record<string, string>>;
  };

  const buckets = new Map<string, CsvBucket>();
  const pushRow = (bucketName: string, row: Record<string, string>) => {
    const bucket = buckets.get(bucketName) || {
      dynamicColumns: new Set<string>(),
      rows: [],
    };
    for (const key of Object.keys(row)) {
      if (
        key !== 'event_id' &&
        key !== 'logged_at' &&
        key !== 'occurred_at' &&
        key !== 'event_type' &&
        key !== 'sender' &&
        key !== 'sender_name' &&
        key !== 'summary' &&
        key !== 'source_content' &&
        key !== 'confidence'
      ) {
        bucket.dynamicColumns.add(key);
      }
    }
    bucket.rows.push(row);
    buckets.set(bucketName, bucket);
  };

  for (const event of events) {
    const attrMap = attrsByEvent.get(event.id) || {};
    const row: Record<string, string> = {
      event_id: String(event.id),
      logged_at: event.logged_at || event.occurred_at,
      occurred_at: event.occurred_at,
      event_type: event.event_type,
      sender: event.sender,
      sender_name: event.sender_name,
      summary: event.summary,
      source_content: event.source_content,
      confidence: String(event.confidence),
      ...attrMap,
    };

    pushRow('all-events', row);
    pushRow(eventTypeToCsvFile(event.event_type), row);
  }

  const baseColumns = [
    'event_id',
    'logged_at',
    'occurred_at',
    'event_type',
    'sender',
    'sender_name',
    'summary',
    'source_content',
    'confidence',
  ];

  const outputDir = chatExportDir(chatJid);
  fs.mkdirSync(outputDir, { recursive: true });

  for (const [bucketName, bucket] of buckets.entries()) {
    const dynamic = [...bucket.dynamicColumns].sort((a, b) => a.localeCompare(b));
    const columns = [...baseColumns, ...dynamic];
    const outFile = path.join(outputDir, `${bucketName}.csv`);
    writeCsv(outFile, columns, bucket.rows);
  }
}

export function exportAllBabyCsvSnapshots(): void {
  const rows = db
    .prepare(
      `
      SELECT DISTINCT chat_jid
      FROM baby_events
      ORDER BY chat_jid
    `,
    )
    .all() as Array<{ chat_jid: string }>;

  for (const row of rows) {
    exportBabyCsvSnapshots(row.chat_jid);
  }
}

export function insertBabyEvent(event: BabyEventInput): number {
  const tx = db.transaction((eventData: BabyEventInput) => {
    const result = db
      .prepare(
        `
        INSERT OR IGNORE INTO baby_events (
          chat_jid, message_id, sender, sender_name, event_type, logged_at, occurred_at, summary, source_content, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        eventData.chat_jid,
        eventData.message_id,
        eventData.sender,
        eventData.sender_name,
        eventData.event_type,
        eventData.logged_at || eventData.occurred_at,
        eventData.occurred_at,
        eventData.summary,
        eventData.source_content,
        eventData.confidence,
      );

    let eventId = Number(result.lastInsertRowid);
    if (!eventId) {
      const existing = db
        .prepare(
          `
          SELECT id
          FROM baby_events
          WHERE chat_jid = ? AND message_id = ? AND event_type = ?
        `,
        )
        .get(
          eventData.chat_jid,
          eventData.message_id,
          eventData.event_type,
        ) as { id: number } | undefined;
      if (!existing) {
        throw new Error('Failed to insert or fetch existing baby event');
      }
      eventId = existing.id;
      return eventId;
    }

    const insertAttr = db.prepare(
      `
      INSERT INTO baby_event_attributes (event_id, attribute_key, value_text, value_type)
      VALUES (?, ?, ?, ?)
    `,
    );

    for (const [attributeKey, value] of Object.entries(eventData.attributes)) {
      const valueType =
        typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean'
            ? 'boolean'
            : 'string';
      insertAttr.run(eventId, attributeKey, String(value), valueType);
      recordBabyAttribute(attributeKey, valueType);
    }

    if (eventData.event_type === 'sleep_start') {
      db.prepare(
        `
        INSERT INTO baby_sleep_sessions (chat_jid, start_event_id, started_at)
        VALUES (?, ?, ?)
      `,
      ).run(eventData.chat_jid, eventId, eventData.occurred_at);
    }

    if (eventData.event_type === 'sleep_end') {
      closeOpenBabySleepSession(eventData.chat_jid, eventId, eventData.occurred_at);
    }

    logBabyAudit(
      'event_created',
      eventData.chat_jid,
      eventData.sender,
      eventId,
      JSON.stringify({
        summary: eventData.summary,
        event_type: eventData.event_type,
        confidence: eventData.confidence,
      }),
    );

    return eventId;
  });

  const eventId = tx(event);
  try {
    exportBabyCsvSnapshots(event.chat_jid);
  } catch (error) {
    console.warn('[cribclaw] CSV export failed:', error);
  }
  return eventId;
}

export function getLastBabyEvent(
  chatJid: string,
  eventTypes: BabyEventType[],
): BabyEventRow | undefined {
  if (eventTypes.length === 0) {
    return undefined;
  }
  const placeholders = eventTypes.map(() => '?').join(',');

  return db
    .prepare(
      `
      SELECT id, event_type, logged_at, occurred_at, summary, sender_name
      FROM baby_events
      WHERE chat_jid = ? AND event_type IN (${placeholders})
      ORDER BY occurred_at DESC
      LIMIT 1
    `,
    )
    .get(chatJid, ...eventTypes) as BabyEventRow | undefined;
}

export function getLastBabyEventAny(chatJid: string): BabyEventRow | undefined {
  return db
    .prepare(
      `
      SELECT id, event_type, logged_at, occurred_at, summary, sender_name
      FROM baby_events
      WHERE chat_jid = ?
      ORDER BY logged_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get(chatJid) as BabyEventRow | undefined;
}

export function amendLatestBabyEventTime(input: {
  chat_jid: string;
  event_type: BabyEventType;
  occurred_at: string;
  logged_at: string;
  sender: string;
  summary: string;
  source_content: string;
  confidence: number;
  attributes: Record<string, string | number | boolean>;
}): BabyEventAmendmentResult | undefined {
  const tx = db.transaction(
    (
      payload: typeof input,
    ): BabyEventAmendmentResult | undefined => {
      const target = db
        .prepare(
          `
          SELECT id, event_type, occurred_at
          FROM baby_events
          WHERE chat_jid = ? AND event_type = ?
          ORDER BY logged_at DESC, id DESC
          LIMIT 1
        `,
        )
        .get(
          payload.chat_jid,
          payload.event_type,
        ) as
        | {
            id: number;
            event_type: BabyEventType;
            occurred_at: string;
          }
        | undefined;

      if (!target) {
        return undefined;
      }

      db.prepare(
        `
        UPDATE baby_events
        SET occurred_at = ?, summary = ?, source_content = ?, confidence = ?
        WHERE id = ?
      `,
      ).run(
        payload.occurred_at,
        `Correction: ${payload.summary}`,
        payload.source_content,
        payload.confidence,
        target.id,
      );

      const insertAttr = db.prepare(
        `
        INSERT INTO baby_event_attributes (event_id, attribute_key, value_text, value_type)
        VALUES (?, ?, ?, ?)
      `,
      );

      const correctionAttrs: Record<string, string | number | boolean> = {
        ...payload.attributes,
        correction: true,
        correction_applied_at: payload.logged_at,
        corrected_from_occurred_at: target.occurred_at,
      };

      for (const [attributeKey, value] of Object.entries(correctionAttrs)) {
        const valueType =
          typeof value === 'number'
            ? 'number'
            : typeof value === 'boolean'
              ? 'boolean'
              : 'string';
        insertAttr.run(target.id, attributeKey, String(value), valueType);
        recordBabyAttribute(attributeKey, valueType);
      }

      if (payload.event_type === 'sleep_start' || payload.event_type === 'sleep_end') {
        rebuildSleepSessions(payload.chat_jid);
      }

      logBabyAudit(
        'event_time_amended',
        payload.chat_jid,
        payload.sender,
        target.id,
        JSON.stringify({
          event_type: payload.event_type,
          from: target.occurred_at,
          to: payload.occurred_at,
        }),
      );

      return {
        id: target.id,
        event_type: payload.event_type,
        previous_occurred_at: target.occurred_at,
        occurred_at: payload.occurred_at,
      };
    },
  );

  return tx(input);
}

export function getBabyEventTimes(
  chatJid: string,
  eventType: BabyEventType,
  limit = 30,
): string[] {
  const rows = db
    .prepare(
      `
      SELECT occurred_at
      FROM baby_events
      WHERE chat_jid = ? AND event_type = ?
      ORDER BY occurred_at DESC
      LIMIT ?
    `,
    )
    .all(chatJid, eventType, limit) as Array<{ occurred_at: string }>;

  return rows.map((row) => row.occurred_at).reverse();
}

export function getRecentBabySleepSessions(
  chatJid: string,
  limit = 20,
): Array<{ started_at: string; ended_at: string; duration_minutes: number }> {
  return db
    .prepare(
      `
      SELECT started_at, ended_at, duration_minutes
      FROM baby_sleep_sessions
      WHERE chat_jid = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT ?
    `,
    )
    .all(chatJid, limit) as Array<{
    started_at: string;
    ended_at: string;
    duration_minutes: number;
  }>;
}

export function getOpenBabySleepSessions(
  chatJid: string,
): Array<{ id: number; started_at: string }> {
  return db
    .prepare(
      `
      SELECT id, started_at
      FROM baby_sleep_sessions
      WHERE chat_jid = ? AND end_event_id IS NULL
      ORDER BY started_at DESC
    `,
    )
    .all(chatJid) as Array<{ id: number; started_at: string }>;
}

export function getBabyDailySummary(
  chatJid: string,
  referenceIso: string,
): {
  feeds: number;
  diapers: number;
  sleepStarts: number;
  sleepEnds: number;
  notes: number;
  pumps: number;
  tummyTimes: number;
  solids: number;
  growths: number;
  baths: number;
} {
  const referenceDate = new Date(referenceIso);
  const start = new Date(referenceDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN event_type = 'feed' THEN 1 ELSE 0 END) AS feeds,
        SUM(CASE WHEN event_type = 'diaper' THEN 1 ELSE 0 END) AS diapers,
        SUM(CASE WHEN event_type = 'sleep_start' THEN 1 ELSE 0 END) AS sleep_starts,
        SUM(CASE WHEN event_type = 'sleep_end' THEN 1 ELSE 0 END) AS sleep_ends,
        SUM(CASE WHEN event_type = 'note' OR event_type = 'milestone' THEN 1 ELSE 0 END) AS notes,
        SUM(CASE WHEN event_type = 'pump' THEN 1 ELSE 0 END) AS pumps,
        SUM(CASE WHEN event_type = 'tummy_time' THEN 1 ELSE 0 END) AS tummy_times,
        SUM(CASE WHEN event_type = 'solids' THEN 1 ELSE 0 END) AS solids,
        SUM(CASE WHEN event_type = 'growth' THEN 1 ELSE 0 END) AS growths,
        SUM(CASE WHEN event_type = 'bath' THEN 1 ELSE 0 END) AS baths
      FROM baby_events
      WHERE chat_jid = ? AND occurred_at >= ? AND occurred_at < ?
    `,
    )
    .get(chatJid, start.toISOString(), end.toISOString()) as
    | {
        feeds: number | null;
        diapers: number | null;
        sleep_starts: number | null;
        sleep_ends: number | null;
        notes: number | null;
        pumps: number | null;
        tummy_times: number | null;
        solids: number | null;
        growths: number | null;
        baths: number | null;
      }
    | undefined;

  return {
    feeds: row?.feeds ?? 0,
    diapers: row?.diapers ?? 0,
    sleepStarts: row?.sleep_starts ?? 0,
    sleepEnds: row?.sleep_ends ?? 0,
    notes: row?.notes ?? 0,
    pumps: row?.pumps ?? 0,
    tummyTimes: row?.tummy_times ?? 0,
    solids: row?.solids ?? 0,
    growths: row?.growths ?? 0,
    baths: row?.baths ?? 0,
  };
}

export function getBabyEventsInRange(
  chatJid: string,
  startIso: string,
  endIso: string,
  limit = 1000,
): BabyEventDetailRow[] {
  return db
    .prepare(
      `
      SELECT id, event_type, logged_at, occurred_at, summary, sender_name
      FROM baby_events
      WHERE chat_jid = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at ASC, id ASC
      LIMIT ?
    `,
    )
    .all(chatJid, startIso, endIso, limit) as BabyEventDetailRow[];
}

export interface BabyEventWithAttrs extends BabyEventDetailRow {
  attributes: Record<string, string | number | boolean>;
}

export function getBabyEventsWithAttrs(
  chatJid: string,
  startIso: string,
  endIso: string,
  limit = 2000,
): BabyEventWithAttrs[] {
  const events = db
    .prepare(
      `SELECT id, event_type, logged_at, occurred_at, summary, sender_name
       FROM baby_events
       WHERE chat_jid = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC, id ASC
       LIMIT ?`,
    )
    .all(chatJid, startIso, endIso, limit) as BabyEventDetailRow[];

  if (events.length === 0) return [];

  const eventIds = events.map((e) => e.id);
  const placeholders = eventIds.map(() => '?').join(',');
  const attrs = db
    .prepare(
      `SELECT event_id, attribute_key, value_text, value_type
       FROM baby_event_attributes
       WHERE event_id IN (${placeholders})`,
    )
    .all(...eventIds) as Array<{
    event_id: number;
    attribute_key: string;
    value_text: string;
    value_type: string;
  }>;

  const attrMap = new Map<number, Record<string, string | number | boolean>>();
  for (const attr of attrs) {
    const rec = attrMap.get(attr.event_id) || {};
    if (attr.value_type === 'number') {
      rec[attr.attribute_key] = Number(attr.value_text);
    } else if (attr.value_type === 'boolean') {
      rec[attr.attribute_key] = attr.value_text === 'true';
    } else {
      rec[attr.attribute_key] = attr.value_text;
    }
    attrMap.set(attr.event_id, rec);
  }

  return events.map((e) => ({
    ...e,
    attributes: attrMap.get(e.id) || {},
  }));
}

export function getFeedIntakeTotals(
  chatJid: string,
  startIso: string,
  endIso: string,
): FeedIntakeTotals {
  const rows = db
    .prepare(
      `
      SELECT
        be.id AS event_id,
        MAX(CASE WHEN attr.attribute_key = 'amount_ml' THEN CAST(attr.value_text AS REAL) END) AS amount_ml,
        MAX(CASE WHEN attr.attribute_key = 'amount_oz' THEN CAST(attr.value_text AS REAL) END) AS amount_oz
      FROM baby_events be
      LEFT JOIN baby_event_attributes attr
        ON attr.event_id = be.id
       AND attr.attribute_key IN ('amount_ml', 'amount_oz')
      WHERE
        be.chat_jid = ?
        AND be.event_type = 'feed'
        AND be.occurred_at >= ?
        AND be.occurred_at < ?
      GROUP BY be.id
      ORDER BY be.occurred_at ASC, be.id ASC
    `,
    )
    .all(chatJid, startIso, endIso) as Array<{
    event_id: number;
    amount_ml: number | null;
    amount_oz: number | null;
  }>;

  let totalMl = 0;
  let totalOz = 0;
  let feedsWithVolume = 0;

  for (const row of rows) {
    const hasMl = Number.isFinite(row.amount_ml) && Number(row.amount_ml) > 0;
    const hasOz = Number.isFinite(row.amount_oz) && Number(row.amount_oz) > 0;
    if (!hasMl && !hasOz) {
      continue;
    }
    feedsWithVolume += 1;

    const resolvedMl = hasMl
      ? Number(row.amount_ml)
      : Number(row.amount_oz) * ML_PER_OZ;
    const resolvedOz = hasOz
      ? Number(row.amount_oz)
      : Number(row.amount_ml) / ML_PER_OZ;

    totalMl += resolvedMl;
    totalOz += resolvedOz;
  }

  return {
    feedCount: rows.length,
    feedsWithVolume,
    feedsMissingVolume: rows.length - feedsWithVolume,
    totalMl: Number(totalMl.toFixed(2)),
    totalOz: Number(totalOz.toFixed(2)),
  };
}

export function getAllBabyEventsForBackfill(limit = 50000): BabyEventDetailRow[] {
  return db
    .prepare(
      `
      SELECT
        id,
        chat_jid,
        message_id,
        sender,
        sender_name,
        event_type,
        logged_at,
        occurred_at,
        summary,
        source_content,
        confidence,
        created_at
      FROM baby_events
      ORDER BY chat_jid ASC, message_id ASC, id ASC
      LIMIT ?
    `,
    )
    .all(limit) as BabyEventDetailRow[];
}

export function createCribclawReminder(input: {
  chat_jid: string;
  sender: string;
  sender_name: string;
  action_text: string;
  due_at: string;
  interval_minutes?: number | null;
}): number {
  const result = db
    .prepare(
      `
      INSERT INTO cribclaw_reminders (
        chat_jid, sender, sender_name, action_text, due_at, interval_minutes, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'active')
    `,
    )
    .run(
      input.chat_jid,
      input.sender,
      input.sender_name,
      input.action_text,
      input.due_at,
      input.interval_minutes ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function getDueCribclawReminders(nowIso: string): CribclawReminderRow[] {
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, action_text, due_at, interval_minutes, status, last_sent_at, created_at
      FROM cribclaw_reminders
      WHERE status = 'active' AND due_at <= ?
      ORDER BY due_at ASC, id ASC
    `,
    )
    .all(nowIso) as CribclawReminderRow[];
}

export function completeCribclawReminder(
  id: number,
  sentAtIso: string,
): void {
  db.prepare(
    `
    UPDATE cribclaw_reminders
    SET status = 'completed', last_sent_at = ?
    WHERE id = ?
  `,
  ).run(sentAtIso, id);
}

export function rescheduleCribclawReminder(
  id: number,
  sentAtIso: string,
  nextDueIso: string,
): void {
  db.prepare(
    `
    UPDATE cribclaw_reminders
    SET due_at = ?, last_sent_at = ?, status = 'active'
    WHERE id = ?
  `,
  ).run(nextDueIso, sentAtIso, id);
}

export function listActiveCribclawReminders(chatJid: string): CribclawReminderRow[] {
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, action_text, due_at, interval_minutes, status, last_sent_at, created_at
      FROM cribclaw_reminders
      WHERE chat_jid = ? AND status = 'active'
      ORDER BY due_at ASC, id ASC
      LIMIT 50
    `,
    )
    .all(chatJid) as CribclawReminderRow[];
}

export function cancelAllCribclawReminders(chatJid: string): number {
  const result = db.prepare(
    `
    UPDATE cribclaw_reminders
    SET status = 'canceled'
    WHERE chat_jid = ? AND status = 'active'
  `,
  ).run(chatJid);
  return Number(result.changes || 0);
}

export function cancelActiveCribclawRemindersByPrefix(
  chatJid: string,
  actionPrefix: string,
): number {
  const result = db
    .prepare(
      `
      UPDATE cribclaw_reminders
      SET status = 'canceled'
      WHERE chat_jid = ? AND status = 'active' AND action_text LIKE ?
    `,
    )
    .run(chatJid, `${actionPrefix}%`);
  return Number(result.changes || 0);
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- Baby growth functions ---

export interface BabyGrowthInput {
  chat_jid: string;
  measured_at: string;
  weight_kg?: number;
  weight_lb?: number;
  height_cm?: number;
  height_in?: number;
  head_cm?: number;
  sender: string;
  sender_name: string;
  notes?: string;
}

export function insertBabyGrowth(input: BabyGrowthInput): number {
  const stmt = db.prepare(`
    INSERT INTO baby_growth (chat_jid, measured_at, weight_kg, weight_lb, height_cm, height_in, head_cm, sender, sender_name, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.chat_jid,
    input.measured_at,
    input.weight_kg ?? null,
    input.weight_lb ?? null,
    input.height_cm ?? null,
    input.height_in ?? null,
    input.head_cm ?? null,
    input.sender,
    input.sender_name,
    input.notes || '',
  );
  return Number(result.lastInsertRowid);
}

export interface BabyGrowthRow {
  id: number;
  measured_at: string;
  weight_kg: number | null;
  weight_lb: number | null;
  height_cm: number | null;
  height_in: number | null;
  head_cm: number | null;
  sender_name: string;
  notes: string;
}

export function getRecentBabyGrowth(chatJid: string, limit = 20): BabyGrowthRow[] {
  return db.prepare(`
    SELECT id, measured_at, weight_kg, weight_lb, height_cm, height_in, head_cm, sender_name, notes
    FROM baby_growth WHERE chat_jid = ? ORDER BY measured_at DESC LIMIT ?
  `).all(chatJid, limit) as BabyGrowthRow[];
}

export function getLatestBabyGrowth(chatJid: string): BabyGrowthRow | undefined {
  return db.prepare(`
    SELECT id, measured_at, weight_kg, weight_lb, height_cm, height_in, head_cm, sender_name, notes
    FROM baby_growth WHERE chat_jid = ? ORDER BY measured_at DESC LIMIT 1
  `).get(chatJid) as BabyGrowthRow | undefined;
}

// --- Pump stash functions ---

export interface PumpStashInput {
  chat_jid: string;
  stored_at: string;
  amount_oz: number;
  amount_ml: number;
  location?: string;
  expires_at?: string;
  sender: string;
  sender_name: string;
  notes?: string;
}

export function insertPumpStash(input: PumpStashInput): number {
  const stmt = db.prepare(`
    INSERT INTO baby_pump_stash (chat_jid, stored_at, amount_oz, amount_ml, location, expires_at, sender, sender_name, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.chat_jid,
    input.stored_at,
    input.amount_oz,
    input.amount_ml,
    input.location || 'freezer',
    input.expires_at || null,
    input.sender,
    input.sender_name,
    input.notes || '',
  );
  return Number(result.lastInsertRowid);
}

export function getPumpStashTotal(chatJid: string): { totalOz: number; totalMl: number; count: number } {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_oz), 0) as totalOz, COALESCE(SUM(amount_ml), 0) as totalMl, COUNT(*) as count
    FROM baby_pump_stash WHERE chat_jid = ? AND used_at IS NULL
  `).get(chatJid) as { totalOz: number; totalMl: number; count: number };
  return row;
}

export function usePumpStash(chatJid: string, amountOz: number): number {
  // Use oldest first (FIFO)
  const available = db.prepare(`
    SELECT id, amount_oz FROM baby_pump_stash
    WHERE chat_jid = ? AND used_at IS NULL ORDER BY stored_at ASC
  `).all(chatJid) as Array<{ id: number; amount_oz: number }>;

  let remaining = amountOz;
  let usedCount = 0;
  const now = new Date().toISOString();
  const markUsed = db.prepare(`UPDATE baby_pump_stash SET used_at = ? WHERE id = ?`);

  for (const bag of available) {
    if (remaining <= 0) break;
    markUsed.run(now, bag.id);
    remaining -= bag.amount_oz;
    usedCount++;
  }
  return usedCount;
}

export function getExpiredPumpStash(chatJid: string, nowIso: string): Array<{ id: number; stored_at: string; amount_oz: number; location: string }> {
  return db.prepare(`
    SELECT id, stored_at, amount_oz, location FROM baby_pump_stash
    WHERE chat_jid = ? AND used_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?
    ORDER BY expires_at ASC
  `).all(chatJid, nowIso) as Array<{ id: number; stored_at: string; amount_oz: number; location: string }>;
}

// --- Tummy time functions ---

export function getTummyTimeTotal(chatJid: string, startIso: string, endIso: string): { totalMinutes: number; count: number } {
  const rows = db.prepare(`
    SELECT ea.value_text FROM baby_events be
    JOIN baby_event_attributes ea ON ea.event_id = be.id AND ea.attribute_key = 'duration_minutes'
    WHERE be.chat_jid = ? AND be.event_type = 'tummy_time' AND be.occurred_at >= ? AND be.occurred_at <= ?
  `).all(chatJid, startIso, endIso) as Array<{ value_text: string }>;

  let totalMinutes = 0;
  for (const row of rows) {
    const minutes = Number(row.value_text);
    if (Number.isFinite(minutes)) totalMinutes += minutes;
  }
  return { totalMinutes, count: rows.length };
}

// --- Week comparison (pattern alerts) ---

export interface WeekComparison {
  thisWeek: { feeds: number; diapers: number; sleepStarts: number; totalSleepMinutes: number; tummyTimeMinutes: number };
  lastWeek: { feeds: number; diapers: number; sleepStarts: number; totalSleepMinutes: number; tummyTimeMinutes: number };
}

export function getWeekComparison(chatJid: string, nowIso: string): WeekComparison {
  const now = new Date(nowIso);
  const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  function countInRange(startIso: string, endIso: string): { feeds: number; diapers: number; sleepStarts: number; totalSleepMinutes: number; tummyTimeMinutes: number } {
    const counts = db.prepare(`
      SELECT event_type, COUNT(*) as cnt FROM baby_events
      WHERE chat_jid = ? AND occurred_at >= ? AND occurred_at < ?
      GROUP BY event_type
    `).all(chatJid, startIso, endIso) as Array<{ event_type: string; cnt: number }>;

    const map = Object.fromEntries(counts.map(c => [c.event_type, c.cnt]));

    const sleepSessions = db.prepare(`
      SELECT COALESCE(SUM(duration_minutes), 0) as total FROM baby_sleep_sessions
      WHERE chat_jid = ? AND started_at >= ? AND started_at < ?
    `).get(chatJid, startIso, endIso) as { total: number };

    const tummyTime = getTummyTimeTotal(chatJid, startIso, endIso);

    return {
      feeds: map['feed'] || 0,
      diapers: map['diaper'] || 0,
      sleepStarts: map['sleep_start'] || 0,
      totalSleepMinutes: sleepSessions.total,
      tummyTimeMinutes: tummyTime.totalMinutes,
    };
  }

  return {
    thisWeek: countInRange(thisWeekStart, nowIso),
    lastWeek: countInRange(lastWeekStart, thisWeekStart),
  };
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}

// --- Backfill support ---

export interface BackfillEvent {
  id: number;
  event_type: BabyEventType;
  occurred_at: string;
  source_content: string;
  existing_keys: Set<string>;
}

export function getEventsForBackfill(chatJid?: string): BackfillEvent[] {
  const rows = chatJid
    ? db.prepare('SELECT id, event_type, occurred_at, source_content FROM baby_events WHERE chat_jid = ? ORDER BY id').all(chatJid) as Array<{ id: number; event_type: BabyEventType; occurred_at: string; source_content: string }>
    : db.prepare('SELECT id, event_type, occurred_at, source_content FROM baby_events ORDER BY id').all() as Array<{ id: number; event_type: BabyEventType; occurred_at: string; source_content: string }>;

  return rows.map((row) => {
    const attrRows = db.prepare('SELECT attribute_key FROM baby_event_attributes WHERE event_id = ?').all(row.id) as Array<{ attribute_key: string }>;
    return {
      ...row,
      existing_keys: new Set(attrRows.map((a) => a.attribute_key)),
    };
  });
}

export function addEventAttribute(eventId: number, key: string, value: string | number | boolean): void {
  const valueType = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
  db.prepare('INSERT INTO baby_event_attributes (event_id, attribute_key, value_text, value_type) VALUES (?, ?, ?, ?)').run(eventId, key, String(value), valueType);
  recordBabyAttribute(key, valueType);
}
