/**
 * CribClaw Smoke Test
 *
 * Populates an in-memory DB with realistic baby data (2 weeks of history),
 * then exercises every CribClaw feature: logging, queries, predictions,
 * daily summary, pattern alerts, growth, pump stash, tummy time, norms, etc.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  insertBabyEvent,
  getBabyDailySummary,
  getBabyEventTimes,
  getLastBabyEvent,
  getRecentBabySleepSessions,
  insertBabyGrowth,
  getLatestBabyGrowth,
  getRecentBabyGrowth,
  insertPumpStash,
  getPumpStashTotal,
  usePumpStash,
  getTummyTimeTotal,
  getWeekComparison,
  getFeedIntakeTotals,
  BabyEventInput,
} from './db.js';
import { CribclawService } from './cribclaw.js';
import {
  extractBabyEvent,
  extractBabyEvents,
  classifyCribclawIntent,
} from './cribclaw-extractor.js';

const CHAT_JID = 'tg:-100testfamily';
const SENDER = 'tg:15551234567';
const SENDER_NAME = 'Mom';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number, hour = 12): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function makeEvent(
  type: string,
  occurredAt: string,
  summary: string,
  attrs: Record<string, string | number | boolean> = {},
  msgId?: string,
): BabyEventInput {
  return {
    chat_jid: CHAT_JID,
    message_id: msgId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sender: SENDER,
    sender_name: SENDER_NAME,
    event_type: type as any,
    logged_at: occurredAt,
    occurred_at: occurredAt,
    summary,
    source_content: summary,
    confidence: 0.9,
    attributes: attrs,
  };
}

/**
 * Seed 14 days of realistic baby data:
 * - 7-8 feeds/day at ~3 hour intervals, 3-5oz each
 * - 6-8 diapers/day
 * - 2-3 naps/day (30-120 min each)
 * - Daily tummy time (5-15 min)
 * - Bath every other day
 * - Weekly growth measurement
 * - Pump sessions 2x/day
 * - Occasional solids (last 3 days if baby >4 months)
 */
function seedRealisticData(): void {
  let eventCounter = 0;

  for (let day = 13; day >= 0; day--) {
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() - day);

    // Feeds: 7-8 per day starting at 6am, every ~3 hours
    const feedCount = 7 + (day % 2);
    for (let f = 0; f < feedCount; f++) {
      const hour = 6 + f * (24 / feedCount);
      baseDate.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
      const oz = 3 + Math.round(Math.random() * 2 * 10) / 10;
      const ml = Math.round(oz * 29.5735);
      insertBabyEvent(
        makeEvent('feed', baseDate.toISOString(), `Fed ${oz}oz bottle`, {
          amount_oz: oz,
          amount_ml: ml,
          feed_method: f % 3 === 0 ? 'breast' : 'bottle',
          event_time_source: 'message_text',
        }, `feed-${day}-${f}-${++eventCounter}`),
      );
    }

    // Diapers: 6-8 per day
    const diaperCount = 6 + (day % 3);
    for (let d = 0; d < diaperCount; d++) {
      const hour = 5 + d * (18 / diaperCount);
      baseDate.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
      const wet = true;
      const dirty = d % 3 === 0;
      insertBabyEvent(
        makeEvent('diaper', baseDate.toISOString(), `Diaper change${dirty ? ' (dirty)' : ' (wet)'}`, {
          wet,
          dirty,
          event_time_source: 'message_timestamp',
        }, `diaper-${day}-${d}-${++eventCounter}`),
      );
    }

    // Naps: 2-3 per day
    const napCount = 2 + (day % 2);
    const napStarts = [9, 13, 16];
    for (let n = 0; n < napCount; n++) {
      const startHour = napStarts[n];
      const durationMin = 30 + Math.round(Math.random() * 90);

      baseDate.setHours(startHour, 0, 0, 0);
      const startId = `sleep-start-${day}-${n}-${++eventCounter}`;
      insertBabyEvent(
        makeEvent('sleep_start', baseDate.toISOString(), 'Fell asleep', {
          event_time_source: 'message_text',
        }, startId),
      );

      const endTime = new Date(baseDate.getTime() + durationMin * 60000);
      const endId = `sleep-end-${day}-${n}-${++eventCounter}`;
      insertBabyEvent(
        makeEvent('sleep_end', endTime.toISOString(), `Woke up after ${durationMin} min`, {
          duration_minutes: durationMin,
          event_time_source: 'message_text',
        }, endId),
      );
    }

    // Tummy time: once per day, 5-15 min
    baseDate.setHours(10, 30, 0, 0);
    const ttMin = 5 + Math.round(Math.random() * 10);
    insertBabyEvent(
      makeEvent('tummy_time', baseDate.toISOString(), `Tummy time ${ttMin} min`, {
        duration_minutes: ttMin,
        event_time_source: 'message_timestamp',
      }, `tt-${day}-${++eventCounter}`),
    );

    // Bath every other day
    if (day % 2 === 0) {
      baseDate.setHours(18, 30, 0, 0);
      insertBabyEvent(
        makeEvent('bath', baseDate.toISOString(), 'Bath time', {
          event_time_source: 'message_timestamp',
        }, `bath-${day}-${++eventCounter}`),
      );
    }

    // Pump sessions 2x/day
    for (const pumpHour of [7, 19]) {
      baseDate.setHours(pumpHour, 0, 0, 0);
      const pumpOz = 2 + Math.round(Math.random() * 3 * 10) / 10;
      insertBabyEvent(
        makeEvent('pump', baseDate.toISOString(), `Pumped ${pumpOz}oz`, {
          amount_oz: pumpOz,
          amount_ml: Math.round(pumpOz * 29.5735),
          side: pumpHour === 7 ? 'left' : 'right',
          event_time_source: 'message_text',
        }, `pump-${day}-${pumpHour}-${++eventCounter}`),
      );

      // Add to pump stash
      insertPumpStash({
        chat_jid: CHAT_JID,
        stored_at: baseDate.toISOString(),
        amount_oz: pumpOz,
        amount_ml: Math.round(pumpOz * 29.5735),
        location: 'freezer',
        sender: SENDER,
        sender_name: SENDER_NAME,
      });
    }

    // Solids (last 3 days)
    if (day <= 3) {
      baseDate.setHours(12, 0, 0, 0);
      const foods = ['avocado', 'banana', 'rice cereal', 'sweet potato'];
      insertBabyEvent(
        makeEvent('solids', baseDate.toISOString(), `Tried ${foods[day % foods.length]}`, {
          food_item: foods[day % foods.length],
          event_time_source: 'message_text',
        }, `solids-${day}-${++eventCounter}`),
      );
    }

    // Growth measurement (weekly)
    if (day % 7 === 0) {
      const weightLb = 8.5 + (14 - day) * 0.3;
      const weightKg = weightLb * 0.453592;
      insertBabyGrowth({
        chat_jid: CHAT_JID,
        measured_at: daysAgo(day, 10),
        weight_lb: Number(weightLb.toFixed(1)),
        weight_kg: Number(weightKg.toFixed(2)),
        height_in: 20 + (14 - day) * 0.1,
        height_cm: (20 + (14 - day) * 0.1) * 2.54,
        sender: SENDER,
        sender_name: SENDER_NAME,
      });
    }
  }
}

describe('CribClaw Smoke Test', () => {
  const service = new CribclawService();

  beforeAll(() => {
    _initTestDatabase();
    seedRealisticData();
  });

  // ── Extractor Tests ──────────────────────────────────────────────

  describe('Extractor - new event types', () => {
    const now = new Date().toISOString();

    it('extracts pump event', () => {
      const event = extractBabyEvent('pumped 4oz left side', now);
      expect(event.eventType).toBe('pump');
      expect(event.attributes.amount_oz).toBe(4);
      expect(event.attributes.side).toBe('left');
    });

    it('extracts tummy time event', () => {
      const event = extractBabyEvent('tummy time 10 minutes', now);
      expect(event.eventType).toBe('tummy_time');
      expect(event.attributes.duration_minutes).toBe(10);
    });

    it('extracts solids event', () => {
      const event = extractBabyEvent('tried avocado for first time', now);
      expect(event.eventType).toBe('solids');
      expect(event.attributes.food_item).toBe('avocado');
    });

    it('extracts growth event with weight', () => {
      const event = extractBabyEvent('weighed 12.5 lbs today', now);
      expect(event.eventType).toBe('growth');
      expect(event.attributes.weight_lb).toBe(12.5);
    });

    it('extracts bath event', () => {
      const event = extractBabyEvent('gave baby a bath', now);
      expect(event.eventType).toBe('bath');
    });

    it('extracts sleep range "slept from 7 to 9 pm"', () => {
      const events = extractBabyEvents('slept from 7 to 9 pm', now);
      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('sleep_start');
      expect(events[1].eventType).toBe('sleep_end');
      expect(events[1].attributes.duration_minutes).toBeDefined();
    });

    it('classifies intent correctly', () => {
      expect(classifyCribclawIntent('fed 4oz')).toBe('log_event');
      expect(classifyCribclawIntent('how many feeds today?')).toBe('query_data');
      expect(classifyCribclawIntent('actually it was at 3pm')).toBe('edit_event');
      expect(classifyCribclawIntent('pumped 3oz')).toBe('log_event');
      expect(classifyCribclawIntent('tummy time 5 min')).toBe('log_event');
    });
  });

  // ── Database Tests ───────────────────────────────────────────────

  describe('Database - new functions', () => {
    it('daily summary includes all event types', () => {
      const summary = getBabyDailySummary(CHAT_JID, new Date().toISOString());
      expect(summary.feeds).toBeGreaterThan(0);
      // Verify that at least feeds and some other types were counted
      const totalEvents = summary.feeds + summary.diapers + summary.sleepStarts +
        summary.pumps + summary.tummyTimes + summary.baths;
      expect(totalEvents).toBeGreaterThan(3);
    });

    it('returns feed event times for predictions', () => {
      const times = getBabyEventTimes(CHAT_JID, 'feed', 30);
      expect(times.length).toBeGreaterThan(10);
    });

    it('returns sleep sessions', () => {
      const sessions = getRecentBabySleepSessions(CHAT_JID, 30);
      expect(sessions.length).toBeGreaterThan(5);
      for (const s of sessions) {
        expect(s.duration_minutes).toBeGreaterThan(0);
      }
    });

    it('returns latest growth measurement', () => {
      const growth = getLatestBabyGrowth(CHAT_JID);
      expect(growth).toBeDefined();
      expect(growth!.weight_lb).toBeGreaterThan(0);
      expect(growth!.height_in).toBeGreaterThan(0);
    });

    it('returns growth history', () => {
      const history = getRecentBabyGrowth(CHAT_JID, 10);
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it('pump stash tracking works', () => {
      const stash = getPumpStashTotal(CHAT_JID);
      expect(stash.count).toBeGreaterThan(0);
      expect(stash.totalOz).toBeGreaterThan(0);
    });

    it('pump stash FIFO consumption works', () => {
      const before = getPumpStashTotal(CHAT_JID);
      const used = usePumpStash(CHAT_JID, 3);
      expect(used).toBeGreaterThan(0);
      const after = getPumpStashTotal(CHAT_JID);
      expect(after.totalOz).toBeLessThan(before.totalOz);
    });

    it('tummy time total works', () => {
      const start = daysAgo(1, 0);
      const end = new Date().toISOString();
      const tt = getTummyTimeTotal(CHAT_JID, start, end);
      expect(tt.count).toBeGreaterThan(0);
      expect(tt.totalMinutes).toBeGreaterThan(0);
    });

    it('week comparison returns valid data', () => {
      const comparison = getWeekComparison(CHAT_JID, new Date().toISOString());
      expect(comparison.thisWeek.feeds).toBeGreaterThan(0);
      expect(comparison.lastWeek.feeds).toBeGreaterThan(0);
      expect(comparison.thisWeek.diapers).toBeGreaterThan(0);
    });

    it('feed intake totals work', () => {
      const start = daysAgo(1, 0);
      const end = new Date().toISOString();
      const totals = getFeedIntakeTotals(CHAT_JID, start, end);
      expect(totals.feedCount).toBeGreaterThan(0);
      expect(totals.feedsWithVolume).toBeGreaterThan(0);
      expect(totals.totalOz).toBeGreaterThan(0);
    });
  });

  // ── Service Query Tests ──────────────────────────────────────────

  describe('CribclawService - queries', () => {
    function query(text: string): string {
      const mode = { runtimeMode: 'locked' as const, allowAssistantTasks: false, ownerSenders: new Set<string>() };
      const msg = {
        id: `q-${Date.now()}`,
        chat_jid: CHAT_JID,
        sender: SENDER,
        sender_name: SENDER_NAME,
        content: text,
        timestamp: new Date().toISOString(),
      };
      const result = service.processMessage(CHAT_JID, msg, mode);
      return result.reply;
    }

    it('predicts next feed', () => {
      const reply = query('predict next feed');
      expect(reply).toMatch(/Predicted next feed/);
    });

    it('predicts next diaper', () => {
      const reply = query('predict next diaper change');
      expect(reply).toMatch(/Predicted next diaper/);
    });

    it('shows last feed', () => {
      const reply = query('when was the last feed?');
      expect(reply).toMatch(/Last feed/);
    });

    it('shows last bath', () => {
      const reply = query('when was the last bath?');
      expect(reply).toMatch(/Last bath/);
    });

    it('shows last pump', () => {
      const reply = query('when was the last pump?');
      expect(reply).toMatch(/Last pump/);
    });

    it('shows last tummy time', () => {
      const reply = query('when was the last tummy time?');
      expect(reply).toMatch(/Last tummy time/);
    });

    it('shows daily summary', () => {
      const reply = query('summary today');
      expect(reply).toMatch(/Today:/);
      expect(reply).toMatch(/feeds/);
    });

    it('shows feed intake calculation', () => {
      const reply = query('how much total oz fed today?');
      expect(reply).toMatch(/Feed intake/);
      expect(reply).toMatch(/oz/);
    });

    it('shows tummy time total', () => {
      const reply = query('how much tummy time past 7 days?');
      expect(reply).toMatch(/tummy time/i);
      expect(reply).toMatch(/minutes|sessions|recorded/);
    });

    it('shows growth check', () => {
      const reply = query('last growth measurement?');
      expect(reply).toMatch(/Latest measurement/);
      expect(reply).toMatch(/lb/);
    });

    it('shows pump stash', () => {
      const reply = query('check total pump stash?');
      expect(reply).toMatch(/Pump stash/);
      expect(reply).toMatch(/oz/);
    });

    it('shows week comparison', () => {
      const reply = query('show me week vs week trend alert?');
      expect(reply).toMatch(/Week-over-week comparison/);
      expect(reply).toMatch(/Feeds:/);
    });

    it('shows help menu', () => {
      const reply = query('what can you tell me?');
      expect(reply).toMatch(/I can answer/);
      expect(reply).toMatch(/pump stash/);
    });
  });

  // ── Event Logging Tests ──────────────────────────────────────────

  describe('CribclawService - logging new types', () => {
    function logMessage(text: string) {
      const mode = { runtimeMode: 'locked' as const, allowAssistantTasks: false, ownerSenders: new Set<string>() };
      const msg = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: CHAT_JID,
        sender: SENDER,
        sender_name: SENDER_NAME,
        content: text,
        timestamp: new Date().toISOString(),
      };
      return service.processMessage(CHAT_JID, msg, mode);
    }

    it('logs a pump event', () => {
      const result = logMessage('pumped 3oz both sides');
      expect(result.reply).toMatch(/logged/i);
      expect(result.reply).toMatch(/pump/i);
      expect(result.loggedEventId).toBeDefined();
    });

    it('logs a tummy time event', () => {
      const result = logMessage('tummy time 8 minutes');
      expect(result.reply).toMatch(/logged/i);
      expect(result.reply).toMatch(/tummy time/i);
    });

    it('logs a bath event', () => {
      const result = logMessage('baby bath time');
      expect(result.reply).toMatch(/logged/i);
      expect(result.reply).toMatch(/bath/i);
    });

    it('logs sleep range', () => {
      const result = logMessage('napped from 2 to 3:30 pm');
      expect(result.reply).toMatch(/logged/i);
    });
  });

  // ── Prediction Tests ─────────────────────────────────────────────

  describe('CribclawService - predictions and features', () => {
    it('adaptive feed interval returns a value', () => {
      const interval = service.getAdaptiveFeedInterval(CHAT_JID);
      expect(interval).not.toBeNull();
      expect(interval!).toBeGreaterThan(60); // At least 1 hour
      expect(interval!).toBeLessThan(360); // Less than 6 hours
    });

    it('daily summary is non-empty', () => {
      const summary = service.generateDailySummary(CHAT_JID);
      expect(summary).toMatch(/Daily Summary/);
      expect(summary).toMatch(/Today:/);
    });

    it('auto-escalation returns null when recently fed', () => {
      // We just seeded a feed within the last few hours
      const alert = service.checkAutoEscalation(CHAT_JID);
      expect(alert).toBeNull();
    });
  });
});
