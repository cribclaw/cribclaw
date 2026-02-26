import { NewMessage } from './types.js';
import {
  amendLatestBabyEventTime,
  cancelActiveCribclawRemindersByPrefix,
  BabyEventInput,
  BabyEventRow,
  cancelAllCribclawReminders,
  createCribclawReminder,
  FeedIntakeTotals,
  getRouterState,
  getBabyDailySummary,
  getBabyEventTimes,
  getFeedIntakeTotals,
  getLastBabyEvent,
  getLastBabyEventAny,
  getRecentBabySleepSessions,
  insertBabyEvent,
  insertBabyGrowth,
  getLatestBabyGrowth,
  getRecentBabyGrowth,
  getPumpStashTotal,
  insertPumpStash,
  getTummyTimeTotal,
  getWeekComparison,
  listActiveCribclawReminders,
  setRouterState,
} from './db.js';
import {
  CRIBCLAW_PARSER_FALLBACK,
  CRIBCLAW_ADAPTIVE_REMINDERS,
  CRIBCLAW_PATTERN_ALERTS_ENABLED,
  CRIBCLAW_AUTO_ESCALATION_MINUTES,
  CRIBCLAW_BABY_DOB,
  CRIBCLAW_BABY_NAME,
  TIMEZONE,
} from './config.js';
import {
  classifyCribclawIntent,
  EVENT_KEYWORD_PATTERN,
  extractBabyEvent,
  extractBabyEvents,
} from './cribclaw-extractor.js';
import { CribclawIntent, CribclawResult, ExtractedBabyEvent, LlmAction, LlmConfigUpdate } from './cribclaw-types.js';
import { generateVisualSummary } from './cribclaw-visual-summary.js';
import { formatAgeInsights, getAgeBasedInsights } from './cribclaw-norms.js';
import { parseChartRequest, generateChart } from './cribclaw-charts.js';

interface CribclawMode {
  runtimeMode: 'locked' | 'builder';
  allowAssistantTasks: boolean;
  ownerSenders: Set<string>;
}

interface Prediction {
  label: string;
  predictedAtIso: string;
  minutesFromNow: number;
  confidence: 'low' | 'medium' | 'high';
}

interface QueryWindow {
  startIso: string;
  endIso: string;
  label: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatRelativeMinutes(minutesFromNow: number): string {
  if (minutesFromNow === 0) {
    return 'now';
  }

  if (minutesFromNow > 0) {
    return `in about ${minutesFromNow} min`;
  }

  return `${Math.abs(minutesFromNow)} min ago`;
}

function formatEventAndLoggedTime(occurredAtIso: string, loggedAtIso: string): string {
  const occurred = Date.parse(occurredAtIso);
  const logged = Date.parse(loggedAtIso);
  if (!Number.isFinite(occurred) || !Number.isFinite(logged)) {
    return `event ${formatTime(occurredAtIso)}`;
  }
  const deltaMinutes = Math.round((logged - occurred) / 60000);
  if (Math.abs(deltaMinutes) <= 1) {
    return `at ${formatTime(occurredAtIso)}`;
  }
  if (deltaMinutes > 1) {
    return `event ${formatTime(occurredAtIso)} (logged ${formatTime(loggedAtIso)}, +${deltaMinutes} min)`;
  }
  return `event ${formatTime(occurredAtIso)} (logged ${formatTime(loggedAtIso)}, ${deltaMinutes} min)`;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function minutesBetween(aIso: string, bIso: string): number {
  return (Date.parse(bIso) - Date.parse(aIso)) / 60000;
}

function confidenceFromCount(count: number): 'low' | 'medium' | 'high' {
  if (count >= 10) {
    return 'high';
  }
  if (count >= 5) {
    return 'medium';
  }
  return 'low';
}

function predictNextFromIntervals(
  label: string,
  times: string[],
  now = new Date(),
): Prediction | null {
  if (times.length < 3) {
    return null;
  }

  const intervals: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    intervals.push(minutesBetween(times[index - 1], times[index]));
  }

  const typicalInterval = median(intervals);
  const lastTime = Date.parse(times[times.length - 1]);
  const predictedAt = new Date(lastTime + typicalInterval * 60000);

  return {
    label,
    predictedAtIso: predictedAt.toISOString(),
    minutesFromNow: Math.round((predictedAt.getTime() - now.getTime()) / 60000),
    confidence: confidenceFromCount(intervals.length),
  };
}

function predictWake(chatJid: string, now = new Date()): Prediction | null {
  const sessions = getRecentBabySleepSessions(chatJid, 30);
  if (sessions.length < 3) {
    return null;
  }

  const durations = sessions
    .map((session) => session.duration_minutes)
    .filter(
      (value): value is number => Number.isFinite(value) && value > 0,
    );

  if (durations.length < 3) {
    return null;
  }

  const lastSleepStart = getLastBabyEvent(chatJid, ['sleep_start']);
  const lastSleepEnd = getLastBabyEvent(chatJid, ['sleep_end']);

  if (!lastSleepStart) {
    return null;
  }

  if (
    lastSleepEnd &&
    Date.parse(lastSleepEnd.occurred_at) > Date.parse(lastSleepStart.occurred_at)
  ) {
    return null;
  }

  const typicalDuration = median(durations);
  const predictedAt = new Date(
    Date.parse(lastSleepStart.occurred_at) + typicalDuration * 60000,
  );

  return {
    label: 'wake up',
    predictedAtIso: predictedAt.toISOString(),
    minutesFromNow: Math.round((predictedAt.getTime() - now.getTime()) / 60000),
    confidence: confidenceFromCount(durations.length),
  };
}

function formatLastEvent(prefix: string, event?: BabyEventRow): string {
  if (!event) {
    return `No ${prefix} logged yet.`;
  }

  return `Last ${prefix}: ${formatTime(event.occurred_at)} by ${event.sender_name}.`;
}

type ReminderIntent =
  | { kind: 'create'; actionText: string; dueAtIso: string; intervalMinutes: number | null }
  | { kind: 'list' }
  | { kind: 'cancel_all' };

type FeedLinkedReminderIntent =
  | { kind: 'set'; minutes: number; actionText: string }
  | { kind: 'disable' };

const AUTO_AFTER_FEED_PREFIX = '[AUTO_AFTER_FEED] ';
const FEED_LINKED_REMINDER_ACTION_DEFAULT = 'time to eat';

function feedLinkedReminderKey(chatJid: string): string {
  return `cribclaw:after-feed-minutes:${chatJid}`;
}

function feedLinkedReminderActionKey(chatJid: string): string {
  return `cribclaw:after-feed-action:${chatJid}`;
}

function parseFeedLinkedReminderIntent(text: string): FeedLinkedReminderIntent | null {
  const lowered = text.toLowerCase().trim();
  const setMatch = lowered.match(
    /set\s+reminder(?:s)?\s+to\s+(.+?)\s+(\d+)\s*(h|hr|hrs|hour|hours|min|mins|minute|minutes)\s+after\s+each\s+feed\b/i,
  );
  if (setMatch?.[1] && setMatch?.[2] && setMatch?.[3]) {
    const actionText = setMatch[1].trim();
    const amount = Number(setMatch[2]);
    const unit = setMatch[3].toLowerCase();
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    if (minutes > 0) {
      return {
        kind: 'set',
        minutes,
        actionText: actionText || FEED_LINKED_REMINDER_ACTION_DEFAULT,
      };
    }
  }

  if (
    /(disable|stop|turn off|cancel)\s+.*(after each feed|feed reminder|after-feed reminder)/i.test(
      lowered,
    )
  ) {
    return { kind: 'disable' };
  }

  return null;
}

function parseReminderIntent(text: string, receivedAtIso: string): ReminderIntent | null {
  const lowered = text.toLowerCase().trim();

  if (/(list|show).*(reminders?|timers?)/.test(lowered)) {
    return { kind: 'list' };
  }

  if (/(cancel|stop|delete).*(all )?(reminders?|timers?)/.test(lowered)) {
    return { kind: 'cancel_all' };
  }

  const everyMatch = lowered.match(
    /every\s+(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours)\b.*?\bremind(?: me| us)?(?: to)?\s+(.+)$/i,
  );
  if (everyMatch?.[1] && everyMatch?.[2] && everyMatch?.[3]) {
    const amount = Number(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const intervalMinutes = unit.startsWith('h') ? amount * 60 : amount;
    if (intervalMinutes > 0) {
      const now = new Date(receivedAtIso);
      const dueAt = new Date(now.getTime() + intervalMinutes * 60000);
      return {
        kind: 'create',
        actionText: everyMatch[3].trim(),
        dueAtIso: dueAt.toISOString(),
        intervalMinutes,
      };
    }
  }

  const inMatch = lowered.match(
    /remind(?: me| us)?\s+in\s+(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours)\b(?:\s+to)?\s+(.+)$/i,
  );
  if (inMatch?.[1] && inMatch?.[2] && inMatch?.[3]) {
    const amount = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    if (minutes > 0) {
      const now = new Date(receivedAtIso);
      const dueAt = new Date(now.getTime() + minutes * 60000);
      return {
        kind: 'create',
        actionText: inMatch[3].trim(),
        dueAtIso: dueAt.toISOString(),
        intervalMinutes: null,
      };
    }
  }

  return null;
}

function extractedEventKey(event: ExtractedBabyEvent): string {
  const occurredMinute = event.occurredAt.slice(0, 16);
  const summaryKey = event.summary.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${event.eventType}|${occurredMinute}|${summaryKey}`;
}

function mergeLlmAndFallbackEvents(
  llmEvents: ExtractedBabyEvent[] | undefined,
  fallbackEvents: ExtractedBabyEvent[] | undefined,
): ExtractedBabyEvent[] {
  const primary = llmEvents ? [...llmEvents] : [];
  const fallback = fallbackEvents || [];
  if (primary.length === 0) {
    return fallback;
  }
  if (fallback.length === 0) {
    return primary;
  }

  const merged = [...primary];
  const seenTypes = new Set(primary.map((event) => event.eventType));
  const seenKeys = new Set(primary.map(extractedEventKey));

  for (const fallbackEvent of fallback) {
    const key = extractedEventKey(fallbackEvent);
    if (seenKeys.has(key)) {
      continue;
    }
    // LLM-first behavior: only augment clearly missing event types.
    if (seenTypes.has(fallbackEvent.eventType)) {
      continue;
    }
    merged.push({
      ...fallbackEvent,
      confidence: Math.min(fallbackEvent.confidence, 0.78),
      attributes: {
        ...fallbackEvent.attributes,
        parser_augmented: true,
      },
      summary: `Augmented: ${fallbackEvent.summary}`,
    });
    seenTypes.add(fallbackEvent.eventType);
    seenKeys.add(key);
  }

  return merged;
}

function isFeedIntakeCalculationQuery(text: string): boolean {
  const hasCalcIntent =
    /\b(how much|total|totals|sum|calculate|intake|consumed)\b/.test(text) ||
    /\b(ml|milliliter|milliliters|oz|ounce|ounces)\b/.test(text);
  const hasFeedIntent =
    /\b(feed|fed|eat|eaten|drank|drink|bottle|nurse|nursing|breast)\b/.test(
      text,
    );
  return hasCalcIntent && hasFeedIntent;
}

function isSummaryVisualQuery(text: string): boolean {
  if (isFeedIntakeCalculationQuery(text)) {
    return false;
  }
  // Don't route specific-type queries to the visual summary
  if (/\b(tummy|pump|stash|growth|weight|height|bath|solid|pattern|trend|insight|norm)\b/.test(text)) {
    return false;
  }
  return (
    /\b(summary|day view|week view|timeline|calendar)\b/.test(text) ||
    /\b(today|how many|totals)\b/.test(text)
  );
}

function resolveQueryWindow(text: string, referenceIso: string): QueryWindow {
  const reference = new Date(referenceIso);
  const lowered = text.toLowerCase();
  const iso = (value: Date) => value.toISOString();

  if (/\btoday\b/.test(lowered)) {
    const start = new Date(reference);
    start.setHours(0, 0, 0, 0);
    return {
      startIso: iso(start),
      endIso: iso(reference),
      label: 'today',
    };
  }

  const hoursMatch = lowered.match(
    /\b(?:last|past|previous)\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/,
  );
  if (hoursMatch?.[1]) {
    const hours = Number(hoursMatch[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return {
        startIso: iso(new Date(reference.getTime() - hours * 60 * 60 * 1000)),
        endIso: iso(reference),
        label: `past ${hours} hours`,
      };
    }
  }

  const daysMatch = lowered.match(
    /\b(?:last|past|previous)\s+(\d+)\s*(d|day|days)\b/,
  );
  if (daysMatch?.[1]) {
    const days = Number(daysMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      return {
        startIso: iso(new Date(reference.getTime() - days * 24 * 60 * 60 * 1000)),
        endIso: iso(reference),
        label: `past ${days} days`,
      };
    }
  }

  if (/\b(?:last|past)\s+day\b/.test(lowered)) {
    return {
      startIso: iso(new Date(reference.getTime() - 24 * 60 * 60 * 1000)),
      endIso: iso(reference),
      label: 'past 24 hours',
    };
  }

  return {
    startIso: iso(new Date(reference.getTime() - 24 * 60 * 60 * 1000)),
    endIso: iso(reference),
    label: 'past 24 hours',
  };
}

function formatFeedIntakeReply(
  totals: FeedIntakeTotals,
  windowLabel: string,
  text: string,
): string {
  if (totals.feedCount === 0) {
    return `No feed events found for ${windowLabel}.`;
  }

  const wantsMl = /\bml|milliliter|milliliters\b/.test(text);
  const wantsOz = /\boz|ounce|ounces\b/.test(text);
  const ml = Math.round(totals.totalMl);
  const oz = totals.totalOz.toFixed(2);

  let totalsText = '';
  if (wantsMl && !wantsOz) {
    totalsText = `${ml} ml`;
  } else if (wantsOz && !wantsMl) {
    totalsText = `${oz} oz`;
  } else {
    totalsText = `${ml} ml (${oz} oz)`;
  }

  const coverageText =
    totals.feedsMissingVolume > 0
      ? `\nCalculated from ${totals.feedsWithVolume}/${totals.feedCount} feed logs with volume values (${totals.feedsMissingVolume} missing amount).`
      : `\nCalculated from ${totals.feedCount} feed logs with volume values.`;

  return `Feed intake ${windowLabel}: ${totalsText}.${coverageText}`;
}

// ---------------------------------------------------------------------------
// Chat-based baby config (name, DOB, birth weight)
// ---------------------------------------------------------------------------

const CONFIG_NAME_PATTERN =
  /(?:(?:baby|baby's|babys|her|his|the baby's?)\s+name\s+(?:is|:)\s*|set\s+(?:baby\s+)?name\s+(?:to|as|:)\s*|call\s+(?:him|her|the\s+baby|baby)\s+|(?:^|\s)name\s+(?:is|:)\s*)(.+)/i;
const CONFIG_DOB_PATTERN =
  /(?:(?:she|he|baby)?\s*(?:was\s+)?born\s+(?:on\s+)?|birthday\s+(?:is\s+)?|date\s+of\s+birth\s+(?:is\s+)?|dob\s+(?:is\s+)?|set\s+(?:baby\s+)?(?:dob|birthday|birth\s+date)\s+(?:to\s+)?)(.+)/i;
const CONFIG_BIRTH_WEIGHT_PATTERN =
  /(?:birth\s+weight\s+(?:is|was)\s+|weighed\s+at\s+birth\s+|(?:she|he|baby)\s+weighed\s+)(.+?)(?:\s+at\s+birth)?$/i;
const CONFIG_TIMEZONE_PATTERN =
  /(?:(?:my|our|set)\s+)?(?:time\s*zone|timezone)\s+(?:is\s+|to\s+)?(.+)/i;
const CONFIG_TIMEZONE_LOCATION_PATTERN =
  /(?:i(?:'?m| am)\s+in\s+|we(?:'re| are)\s+in\s+|located?\s+in\s+|(?:^|\s)(eastern|central|mountain|pacific|hawaii)\s+time(?:\s+zone)?$)/i;
const CONFIG_QUERY_PATTERN =
  /(?:what(?:'?s| is) (?:the |my |our )?(?:baby(?:'?s)? )?(?:name|dob|birthday|birth\s*date|birth\s*weight|time\s*zone|timezone)|show (?:baby )?(?:settings|config|info|profile)|(?:baby|my) (?:settings|config|profile))/i;

/**
 * Detect if text looks like a compound baby profile dump, e.g.
 * "Naomi, born Feb 10 2025, 7lbs 3oz" or "fill in: Luna feb 10 7lbs".
 *
 * Only triggers when:
 * 1. There's an explicit profile prefix ("fill in...", "baby info:", "profile:"), OR
 * 2. The message is short (< 80 chars) and has NO event keywords (feed, diaper, sleep, etc.)
 *    AND contains at least a name+date or name+weight combo.
 */
const PROFILE_PREFIX_RE =
  /^(?:fill\s+in\s+(?:the\s+)?(?:missing\s+)?(?:info|information|details|profile)?[:\s]*|(?:baby|profile|settings?)\s*(?:info|update)?[:\s]+|update\s+(?:baby\s+)?profile[:\s]*)/i;

const EVENT_WORDS_RE =
  /\b(fed|feed|ate|bottle|nurse|breast|diaper|poop|pee|wet|dirty|sleep|nap|woke|wake|pump|tummy|bath|solid|medicine|med)\b/i;

function parseCompoundBabyProfile(
  text: string,
  chatJid: string,
): string | null {
  const hasProfilePrefix = PROFILE_PREFIX_RE.test(text);

  // Without a profile prefix, only try compound parse on short messages with no event words
  if (!hasProfilePrefix) {
    if (text.length > 80 || EVENT_WORDS_RE.test(text)) return null;
  }

  // Strip the prefix if present
  const cleaned = text.replace(PROFILE_PREFIX_RE, '').trim();
  if (!cleaned) return null;

  const updates: string[] = [];

  // Try to extract a name: first capitalized word that isn't a month or keyword
  const MONTHS =
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)$/i;
  const SKIP_WORDS =
    /^(born|birthday|dob|weight|weighed|lbs?|oz|kg|g|pounds?|ounces?|kilos?|grams?|the|my|our|baby|is|was|on|in|at|and|she|he|did|do|how|what|when|where|why|happy|change|medium|small|large|big|little|amount|of)$/i;

  // Name: look for a capitalized word at the start that isn't a date/keyword
  const nameCandidate = cleaned.match(/^([A-Z][a-z]+)/);
  if (
    nameCandidate &&
    !MONTHS.test(nameCandidate[1]) &&
    !SKIP_WORDS.test(nameCandidate[1])
  ) {
    const currentName =
      getRouterState(`cribclaw:baby-name:${chatJid}`) ||
      CRIBCLAW_BABY_NAME ||
      '';
    if (!currentName || currentName === '(not set)') {
      setRouterState(`cribclaw:baby-name:${chatJid}`, nameCandidate[1]);
      updates.push(`Name: ${nameCandidate[1]}`);
    }
  }

  // DOB: look for date patterns anywhere in the text
  const datePatterns = [
    /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:\s*,?\s*\d{4})?)\b/i,
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
  ];
  for (const pat of datePatterns) {
    const m = cleaned.match(pat);
    if (m) {
      const parsed = new Date(m[1]);
      if (!isNaN(parsed.getTime())) {
        const isoDate = parsed.toISOString().slice(0, 10);
        setRouterState(`cribclaw:baby-dob:${chatJid}`, isoDate);
        updates.push(`DOB: ${isoDate}`);
        break;
      }
    }
  }

  // Birth weight: "7lbs 3oz", "7 lbs", "3.2kg", "7 pounds 3 ounces"
  const weightMatch = cleaned.match(
    /\b(\d+(?:\.\d+)?\s*(?:lbs?|pounds?|kg|kilos?)(?:\s+\d+(?:\.\d+)?\s*(?:oz|ounces?|g|grams?))?)\b/i,
  );
  if (weightMatch) {
    setRouterState(
      `cribclaw:birth-weight:${chatJid}`,
      weightMatch[1].trim(),
    );
    updates.push(`Birth weight: ${weightMatch[1].trim()}`);
  }

  // Require at least 2 fields for non-prefixed messages, or 1 field for prefixed ones
  if (updates.length === 0) return null;
  if (!hasProfilePrefix && updates.length < 2) return null;

  // Show what was set + what's still missing
  const babyName =
    getRouterState(`cribclaw:baby-name:${chatJid}`) ||
    CRIBCLAW_BABY_NAME ||
    '';
  const dob = getRouterState(`cribclaw:baby-dob:${chatJid}`) || '';
  const birthWeight = getRouterState(`cribclaw:birth-weight:${chatJid}`) || '';
  const tz =
    getRouterState(`cribclaw:timezone:${chatJid}`) || TIMEZONE || '';

  const missing: string[] = [];
  if (!babyName) missing.push('name (e.g. "name is Luna")');
  if (!dob) missing.push('birthday (e.g. "born Feb 10")');
  if (!birthWeight) missing.push('birth weight (e.g. "7lbs 3oz")');
  if (!tz) missing.push('timezone (e.g. "timezone PST")');

  const lines = [`Updated baby profile:\n  ${updates.join('\n  ')}`];
  if (missing.length > 0) {
    lines.push(`\nStill missing: ${missing.join(', ')}`);
  } else {
    lines.push('\nProfile complete! Start logging with "fed 4oz bottle" or "diaper wet".');
  }
  return lines.join('');
}

export function applyLlmConfigUpdate(updates: LlmConfigUpdate, chatJid: string): string {
  const applied: string[] = [];
  if (updates.name) {
    setRouterState(`cribclaw:baby-name:${chatJid}`, updates.name);
    applied.push(`Name: ${updates.name}`);
  }
  if (updates.dob) {
    // Accept ISO date or try parsing
    const parsed = new Date(updates.dob);
    const isoDate = !isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : updates.dob;
    setRouterState(`cribclaw:baby-dob:${chatJid}`, isoDate);
    applied.push(`DOB: ${isoDate}`);
  }
  if (updates.birth_weight) {
    setRouterState(`cribclaw:birth-weight:${chatJid}`, updates.birth_weight);
    applied.push(`Birth weight: ${updates.birth_weight}`);
  }
  if (updates.timezone) {
    const resolved = resolveTimezoneInput(updates.timezone);
    if (resolved) {
      setRouterState(`cribclaw:timezone:${chatJid}`, resolved);
      applied.push(`Timezone: ${resolved}`);
    }
  }

  if (applied.length === 0) return 'No profile changes detected.';

  const babyName = getRouterState(`cribclaw:baby-name:${chatJid}`) || CRIBCLAW_BABY_NAME || '';
  const dob = getRouterState(`cribclaw:baby-dob:${chatJid}`) || '';
  const birthWeight = getRouterState(`cribclaw:birth-weight:${chatJid}`) || '';
  const tz = getRouterState(`cribclaw:timezone:${chatJid}`) || TIMEZONE || '';

  const missing: string[] = [];
  if (!babyName) missing.push('name');
  if (!dob) missing.push('birthday');
  if (!birthWeight) missing.push('birth weight');
  if (!tz) missing.push('timezone');

  const lines = [`Updated baby profile:\n  ${applied.join('\n  ')}`];
  if (missing.length > 0) {
    lines.push(`\nStill need: ${missing.join(', ')}`);
  } else {
    lines.push('\nProfile complete! Start logging with "fed 4oz bottle" or "diaper wet".');
  }
  return lines.join('');
}

function parseBabyConfig(text: string, chatJid: string): string | null {
  const lowered = text.trim().toLowerCase();

  // Query current config
  if (CONFIG_QUERY_PATTERN.test(lowered)) {
    const babyName = getRouterState(`cribclaw:baby-name:${chatJid}`) || CRIBCLAW_BABY_NAME || '(not set)';
    const dob = getRouterState(`cribclaw:baby-dob:${chatJid}`) || CRIBCLAW_BABY_DOB || '(not set)';
    const birthWeight = getRouterState(`cribclaw:birth-weight:${chatJid}`) || '(not set)';
    const tz = getRouterState(`cribclaw:timezone:${chatJid}`) || TIMEZONE || '(not set)';
    return [
      'Baby profile:',
      `  Name: ${babyName}`,
      `  Date of birth: ${dob}`,
      `  Birth weight: ${birthWeight}`,
      `  Timezone: ${tz}`,
      '',
      'To update, just tell me — e.g. "Luna, born Feb 10, 7lbs 3oz"',
    ].join('\n');
  }

  // Set name
  const nameMatch = text.match(CONFIG_NAME_PATTERN);
  if (nameMatch) {
    const name = nameMatch[1].trim().replace(/[.!]+$/, '').trim();
    if (name.length > 0 && name.length < 50) {
      setRouterState(`cribclaw:baby-name:${chatJid}`, name);
      return `Baby name set to "${name}".`;
    }
  }

  // Set DOB
  const dobMatch = text.match(CONFIG_DOB_PATTERN);
  if (dobMatch) {
    const rawDate = dobMatch[1].trim().replace(/[.!]+$/, '').trim();
    const parsed = new Date(rawDate);
    if (!isNaN(parsed.getTime())) {
      const isoDate = parsed.toISOString().slice(0, 10);
      setRouterState(`cribclaw:baby-dob:${chatJid}`, isoDate);
      return `Date of birth set to ${isoDate}.`;
    }
    return `Could not parse "${rawDate}" as a date. Try a format like "Feb 10, 2025" or "2025-02-10".`;
  }

  // Set birth weight
  const birthWeightMatch = text.match(CONFIG_BIRTH_WEIGHT_PATTERN);
  if (birthWeightMatch) {
    const raw = birthWeightMatch[1].trim().replace(/[.!]+$/, '').trim();
    setRouterState(`cribclaw:birth-weight:${chatJid}`, raw);
    return `Birth weight set to "${raw}".`;
  }

  // Set timezone (e.g. "timezone is America/Los_Angeles", "set timezone to PST", "my timezone is EST")
  const tzMatch = text.match(CONFIG_TIMEZONE_PATTERN);
  if (tzMatch) {
    const raw = tzMatch[1].trim().replace(/[.!]+$/, '').trim();
    const resolved = resolveTimezoneInput(raw);
    if (resolved) {
      setRouterState(`cribclaw:timezone:${chatJid}`, resolved);
      return `Timezone set to ${resolved}.`;
    }
    return `Could not recognize "${raw}" as a timezone. Try an IANA timezone like "America/New_York" or abbreviation like "EST", "PST", "CST".`;
  }

  // Location-based timezone (e.g. "I'm in New York", "we're in California")
  const locationMatch = text.match(CONFIG_TIMEZONE_LOCATION_PATTERN);
  if (locationMatch) {
    const raw = locationMatch[1].trim().replace(/[.!]+$/, '').trim();
    const resolved = resolveTimezoneInput(raw);
    if (resolved) {
      setRouterState(`cribclaw:timezone:${chatJid}`, resolved);
      return `Timezone set to ${resolved} based on your location.`;
    }
  }

  // Compound profile: "Naomi feb 10 2025 7lbs 3oz" or "fill in missing: ..."
  const compoundResult = parseCompoundBabyProfile(text, chatJid);
  if (compoundResult) return compoundResult;

  return null;
}

// ---------------------------------------------------------------------------
// Helper: get baby name from chat config or env fallback
// ---------------------------------------------------------------------------

export function getBabyName(chatJid: string): string {
  return getRouterState(`cribclaw:baby-name:${chatJid}`) || CRIBCLAW_BABY_NAME || '';
}

// ---------------------------------------------------------------------------
// Helper: get timezone from chat config or global fallback
// ---------------------------------------------------------------------------

const TIMEZONE_ABBREVIATIONS: Record<string, string> = {
  est: 'America/New_York',
  edt: 'America/New_York',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
  gmt: 'Etc/GMT',
  utc: 'Etc/UTC',
  bst: 'Europe/London',
  cet: 'Europe/Paris',
  eet: 'Europe/Helsinki',
  ist: 'Asia/Kolkata',
  jst: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  aest: 'Australia/Sydney',
  aedt: 'Australia/Sydney',
  nzst: 'Pacific/Auckland',
  nzdt: 'Pacific/Auckland',
};

const LOCATION_TIMEZONES: Record<string, string> = {
  'new york': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  chicago: 'America/Chicago',
  denver: 'America/Denver',
  phoenix: 'America/Phoenix',
  anchorage: 'America/Anchorage',
  honolulu: 'Pacific/Honolulu',
  hawaii: 'Pacific/Honolulu',
  california: 'America/Los_Angeles',
  texas: 'America/Chicago',
  florida: 'America/New_York',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  tokyo: 'Asia/Tokyo',
  sydney: 'Australia/Sydney',
  toronto: 'America/Toronto',
  vancouver: 'America/Vancouver',
  seattle: 'America/Los_Angeles',
  boston: 'America/New_York',
  atlanta: 'America/New_York',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  miami: 'America/New_York',
  portland: 'America/Los_Angeles',
  israel: 'Asia/Jerusalem',
  india: 'Asia/Kolkata',
  singapore: 'Asia/Singapore',
  'hong kong': 'Asia/Hong_Kong',
  seoul: 'Asia/Seoul',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  mumbai: 'Asia/Kolkata',
  dubai: 'Asia/Dubai',
  auckland: 'Pacific/Auckland',
  'new zealand': 'Pacific/Auckland',
  eastern: 'America/New_York',
  central: 'America/Chicago',
  mountain: 'America/Denver',
  pacific: 'America/Los_Angeles',
};

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function resolveTimezoneInput(input: string): string | null {
  const trimmed = input.trim();

  // Direct IANA timezone (e.g. "America/New_York")
  if (isValidTimezone(trimmed)) {
    return trimmed;
  }

  // Abbreviation lookup
  const lower = trimmed.toLowerCase();
  const abbr = TIMEZONE_ABBREVIATIONS[lower];
  if (abbr) return abbr;

  // Location lookup
  const loc = LOCATION_TIMEZONES[lower];
  if (loc) return loc;

  return null;
}

export function getTimezone(chatJid: string): string | undefined {
  return getRouterState(`cribclaw:timezone:${chatJid}`) || TIMEZONE || undefined;
}

export class CribclawService {
  processMessage(
    chatJid: string,
    message: NewMessage,
    mode: CribclawMode,
    preExtractedEvents?: ExtractedBabyEvent[],
    llmAction?: LlmAction,
  ): CribclawResult {
    const intent = classifyCribclawIntent(message.content);
    const tz = getTimezone(chatJid);

    // LLM-first: handle structured actions from the unified LLM call
    let configPrefix = '';
    if (llmAction) {
      if (llmAction.action === 'config_update') {
        return {
          intent: 'query_data',
          reply: applyLlmConfigUpdate(llmAction.updates, chatJid),
        };
      }

      if (llmAction.action === 'mixed') {
        configPrefix = applyLlmConfigUpdate(llmAction.config_updates, chatJid) + '\n\n';
        // Fall through to event processing with the events from the LLM
        // The preExtractedEvents should already be set by the caller
      }

      if (llmAction.action === 'query') {
        return { intent: 'query_data', reply: llmAction.reply };
      }

      if (llmAction.action === 'chat') {
        // Return empty reply so the message falls through to the NanoClaw
        // agent container, which has session memory for real conversations.
        return { intent: 'unknown', reply: '' };
      }

      if (llmAction.action === 'none') {
        return { intent: 'unknown', reply: '' };
      }
    }

    // Config commands run FIRST — before LLM extraction can override intent.
    // This ensures "Naomi feb 10 7lbs" is treated as profile setup, not a logged event.
    const configResult = parseBabyConfig(message.content, chatJid);
    if (configResult) {
      return { intent: 'query_data', reply: configResult };
    }

    const parserFallbackEvents =
      CRIBCLAW_PARSER_FALLBACK &&
      preExtractedEvents &&
      preExtractedEvents.length > 0
        ? extractBabyEvents(message.content, message.timestamp, tz)
        : undefined;
    const mergedPreExtractedEvents = mergeLlmAndFallbackEvents(
      preExtractedEvents,
      parserFallbackEvents,
    );
    const hasPreExtractedEvents = mergedPreExtractedEvents.length > 0;
    const hasNonNotePreExtractedEvent = mergedPreExtractedEvents.some(
      (event) => event.eventType !== 'note',
    );
    const effectiveIntent =
      (intent === 'query_data' || intent === 'unknown') &&
      hasPreExtractedEvents &&
      hasNonNotePreExtractedEvent
        ? 'log_event'
        : intent;
    const lowered = message.content.toLowerCase();
    const feedLinkedIntent = parseFeedLinkedReminderIntent(message.content);
    const reminderIntent = parseReminderIntent(message.content, message.timestamp);

    if (feedLinkedIntent?.kind === 'set') {
      setRouterState(feedLinkedReminderKey(chatJid), String(feedLinkedIntent.minutes));
      setRouterState(feedLinkedReminderActionKey(chatJid), feedLinkedIntent.actionText);
      return {
        intent: 'query_data',
        reply: `Enabled after-feed reminder: ${feedLinkedIntent.actionText} ${feedLinkedIntent.minutes} minutes after each feed.`,
      };
    }

    if (feedLinkedIntent?.kind === 'disable') {
      setRouterState(feedLinkedReminderKey(chatJid), '0');
      const canceled = cancelActiveCribclawRemindersByPrefix(
        chatJid,
        AUTO_AFTER_FEED_PREFIX,
      );
      return {
        intent: 'query_data',
        reply:
          canceled > 0
            ? `Disabled after-feed reminders and canceled ${canceled} pending auto reminder(s).`
            : 'Disabled after-feed reminders.',
      };
    }

    if (reminderIntent?.kind === 'create') {
      const reminderId = createCribclawReminder({
        chat_jid: chatJid,
        sender: message.sender,
        sender_name: message.sender_name,
        action_text: reminderIntent.actionText,
        due_at: reminderIntent.dueAtIso,
        interval_minutes: reminderIntent.intervalMinutes,
      });
      const cadence = reminderIntent.intervalMinutes
        ? ` (repeats every ${reminderIntent.intervalMinutes} min)`
        : '';
      return {
        intent: 'query_data',
        reply: `Reminder #${reminderId} set for ${formatTime(
          reminderIntent.dueAtIso,
        )}: ${reminderIntent.actionText}${cadence}.`,
      };
    }

    if (reminderIntent?.kind === 'list') {
      const reminders = listActiveCribclawReminders(chatJid);
      if (reminders.length === 0) {
        return { intent: 'query_data', reply: 'No active reminders.' };
      }
      const lines = reminders.map((reminder) => {
        const cadence = reminder.interval_minutes
          ? ` every ${reminder.interval_minutes} min`
          : '';
        return `#${reminder.id} at ${formatTime(reminder.due_at)}${cadence}: ${reminder.action_text}`;
      });
      return {
        intent: 'query_data',
        reply: `Active reminders:\n${lines.join('\n')}`,
      };
    }

    if (reminderIntent?.kind === 'cancel_all') {
      const canceled = cancelAllCribclawReminders(chatJid);
      return {
        intent: 'query_data',
        reply: canceled > 0 ? `Canceled ${canceled} active reminders.` : 'No active reminders to cancel.',
      };
    }

    // Chart/graph requests
    const chartSpec = parseChartRequest(message.content);
    if (chartSpec) {
      try {
        const result = generateChart(chatJid, chartSpec, message.timestamp);
        if (result.pngPath) {
          return {
            intent: 'query_data',
            reply: `${result.title} (${result.dataPoints} data points)`,
            attachmentFilePath: result.pngPath,
            attachmentCaption: result.title,
            attachmentMimeType: 'image/png',
          };
        }
        return {
          intent: 'query_data',
          reply: `Chart generated but PNG rendering failed. HTML available at ${result.htmlPath}`,
        };
      } catch (err: any) {
        return {
          intent: 'query_data',
          reply: `Could not generate chart: ${err?.message || 'unknown error'}`,
        };
      }
    }

    if (effectiveIntent === 'query_data') {
      if (isSummaryVisualQuery(lowered)) {
        const visual = this.processSummaryWithVisual(chatJid, lowered);
        return {
          intent: effectiveIntent,
          reply: visual.reply,
          attachmentFilePath: visual.attachmentFilePath,
          attachmentCaption: visual.attachmentCaption,
          attachmentMimeType: visual.attachmentMimeType,
        };
      }
      return {
        intent: effectiveIntent,
        reply: this.handleQuery(chatJid, lowered, message.timestamp),
      };
    }

    if (effectiveIntent === 'assistant_task') {
      if (
        !mode.allowAssistantTasks ||
        mode.runtimeMode !== 'builder' ||
        !mode.ownerSenders.has(message.sender)
      ) {
        return {
          intent: effectiveIntent,
          reply:
            'Builder mode is locked. This family chat can log/query baby events. Owner-only assistant tasks are disabled right now.',
        };
      }

      return {
        intent: effectiveIntent,
        reply:
          'Routing this to builder mode agent. I will post results back here.',
        delegateToAgentPrompt: [
          'You are CribClaw builder mode for one family.',
          'Perform this owner request safely and summarize what you changed:',
          message.content,
        ].join('\n'),
      };
    }

    const extractedEvents =
      hasPreExtractedEvents
        ? mergedPreExtractedEvents
        : CRIBCLAW_PARSER_FALLBACK
          ? effectiveIntent === 'log_event'
            ? extractBabyEvents(message.content, message.timestamp, tz)
            : [extractBabyEvent(message.content, message.timestamp, tz)]
          : [];

    if (extractedEvents.length === 0) {
      return {
        intent: effectiveIntent,
        reply:
          'I could not extract structured events from that message yet. Please retry with a bit more detail.',
      };
    }
    const loggedTypes: string[] = [];
    const loggedIds: number[] = [];
    const amendedReplies: string[] = [];
    let firstAmendedId: number | undefined;
    let lastEventTime = '';
    let lastFeedOccurredAt = '';

    for (const event of extractedEvents) {
      if (
        effectiveIntent === 'edit_event' &&
        event.attributes.event_time_source === 'message_text'
      ) {
        const targetType =
          event.eventType === 'note'
            ? getLastBabyEventAny(chatJid)?.event_type
            : event.eventType;
        if (targetType) {
          const amended = amendLatestBabyEventTime({
            chat_jid: chatJid,
            event_type: targetType,
            occurred_at: event.occurredAt,
            logged_at: message.timestamp,
            sender: message.sender,
            summary: event.summary,
            source_content: message.content,
            confidence: event.confidence,
            attributes: event.attributes,
          });
          if (amended) {
            if (!firstAmendedId) {
              firstAmendedId = amended.id;
            }
            amendedReplies.push(
              `Updated ${amended.event_type.replace('_', ' ')} time from ${formatTime(
                amended.previous_occurred_at,
              )} to ${formatTime(amended.occurred_at)}.`,
            );
            lastEventTime = amended.occurred_at;
            if (amended.event_type === 'feed') {
              lastFeedOccurredAt = amended.occurred_at;
            }
            continue;
          }
        }
      }

      if (effectiveIntent === 'edit_event') {
        event.attributes.correction = true;
        event.attributes.original_intent = 'edit_event';
        event.summary = `Correction: ${event.summary}`;
      }

      if (effectiveIntent === 'unknown' && event.eventType === 'note') {
        // Only auto-log as a note if the message contains baby-related keywords.
        // Otherwise skip it — it's likely a conversational message ("hey", "hi",
        // "how's it going") that should go through the LLM for a real response.
        if (!EVENT_KEYWORD_PATTERN.test(message.content)) {
          continue;
        }
        event.attributes.auto_logged = true;
        event.summary = `Note: ${event.summary}`;
      }

      const eventInput: BabyEventInput = {
        // Keep both times: when caregiver logged it and when event occurred.
        chat_jid: chatJid,
        message_id: message.id,
        sender: message.sender,
        sender_name: message.sender_name,
        event_type: event.eventType,
        logged_at: message.timestamp,
        occurred_at: event.occurredAt,
        summary: event.summary,
        source_content: message.content,
        confidence: event.confidence,
        attributes: (() => {
          const loggedDelayMinutes = Math.round(
            (Date.parse(message.timestamp) - Date.parse(event.occurredAt)) / 60000,
          );
          return Number.isFinite(loggedDelayMinutes)
            ? {
                ...event.attributes,
                logged_delay_minutes: loggedDelayMinutes,
              }
            : event.attributes;
        })(),
      };

      const eventId = insertBabyEvent(eventInput);
      loggedIds.push(eventId);
      loggedTypes.push(event.eventType.replace('_', ' '));
      lastEventTime = event.occurredAt;
      if (event.eventType === 'feed') {
        lastFeedOccurredAt = event.occurredAt;
      }
      if (event.eventType === 'growth') {
        this.processGrowthEvent(chatJid, event, message.sender, message.sender_name);
      }
      if (event.eventType === 'pump') {
        this.processPumpEvent(chatJid, event, message.sender, message.sender_name);
      }
    }

    if (amendedReplies.length > 0 && loggedIds.length === 0) {
      return {
        intent: effectiveIntent,
        loggedEventId: firstAmendedId,
        reply: amendedReplies.join('\n'),
      };
    }

    // Nothing was logged — the message wasn't a baby event.
    // Let it pass through to the LLM for a conversational response.
    if (loggedIds.length === 0) {
      return {
        intent: 'unknown' as CribclawIntent,
        reply: '',
      };
    }

    const eventId = loggedIds[0];
    const uniqueTypes = [...new Set(loggedTypes)];
    const typeSummary = uniqueTypes.join(', ');

    let baseReply: string;
    if (uniqueTypes.length > 1) {
      baseReply = `Logged ${uniqueTypes.length} events (${typeSummary}) at ${formatTime(
        lastEventTime || message.timestamp,
      )} by ${message.sender_name}.`;
    } else if (uniqueTypes[0] === 'note') {
      baseReply = `Noted ${formatEventAndLoggedTime(
        lastEventTime || message.timestamp,
        message.timestamp,
      )}. Logged as a note by ${message.sender_name}.`;
    } else if (uniqueTypes[0] === 'sleep_start') {
      baseReply = `Nap started at ${formatTime(
        lastEventTime || message.timestamp,
      )}. Say "woke up" when the nap ends.`;
    } else if (uniqueTypes[0] === 'sleep_end') {
      const lastStart = getLastBabyEvent(chatJid, ['sleep_start']);
      if (lastStart) {
        const durationMin = Math.round(
          (Date.parse(lastEventTime || message.timestamp) - Date.parse(lastStart.occurred_at)) / 60000,
        );
        if (durationMin > 0 && durationMin < 1440) {
          const hrs = Math.floor(durationMin / 60);
          const mins = durationMin % 60;
          const durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
          baseReply = `Nap ended at ${formatTime(
            lastEventTime || message.timestamp,
          )}. Duration: ${durationStr}.`;
        } else {
          baseReply = `Nap ended at ${formatTime(lastEventTime || message.timestamp)}.`;
        }
      } else {
        baseReply = `Nap ended at ${formatTime(lastEventTime || message.timestamp)}.`;
      }
    } else {
      baseReply = `${uniqueTypes[0]} logged ${formatEventAndLoggedTime(
        lastEventTime || message.timestamp,
        message.timestamp,
      )} by ${message.sender_name}.`;
    }

    let afterFeedSuffix = '';
    const afterFeedMinutes = Number(getRouterState(feedLinkedReminderKey(chatJid)) || '0');
    if (afterFeedMinutes > 0 && lastFeedOccurredAt) {
      const actionText =
        getRouterState(feedLinkedReminderActionKey(chatJid)) ||
        FEED_LINKED_REMINDER_ACTION_DEFAULT;
      cancelActiveCribclawRemindersByPrefix(chatJid, AUTO_AFTER_FEED_PREFIX);
      const dueAt = new Date(
        Date.parse(lastFeedOccurredAt) + afterFeedMinutes * 60000,
      ).toISOString();
      createCribclawReminder({
        chat_jid: chatJid,
        sender: message.sender,
        sender_name: message.sender_name,
        action_text: `${AUTO_AFTER_FEED_PREFIX}${actionText}`,
        due_at: dueAt,
        interval_minutes: null,
      });
      afterFeedSuffix = `\nAuto reminder set for ${formatTime(
        dueAt,
      )}: ${actionText}.`;
    }

    const amendmentPrefix =
      amendedReplies.length > 0 ? `${amendedReplies.join('\n')}\n` : '';

    // Add adaptive feed prediction hint when a feed is logged
    let adaptiveSuffix = '';
    if (lastFeedOccurredAt && CRIBCLAW_ADAPTIVE_REMINDERS) {
      const adaptiveInterval = this.getAdaptiveFeedInterval(chatJid);
      if (adaptiveInterval && adaptiveInterval > 0) {
        const nextFeedAt = new Date(Date.parse(lastFeedOccurredAt) + adaptiveInterval * 60000);
        const minsFromNow = Math.round((nextFeedAt.getTime() - Date.now()) / 60000);
        if (minsFromNow > 0) {
          adaptiveSuffix = `\nBased on recent pattern, next feed predicted ${formatRelativeMinutes(minsFromNow)}.`;
        }
      }
    }

    return {
      intent: effectiveIntent,
      loggedEventId: eventId,
      reply: `${configPrefix}${amendmentPrefix}${baseReply}${afterFeedSuffix}${adaptiveSuffix}`,
    };
  }

  private handleQuery(chatJid: string, text: string, referenceIso: string): string {
    if (isFeedIntakeCalculationQuery(text)) {
      const window = resolveQueryWindow(text, referenceIso);
      const totals = getFeedIntakeTotals(chatJid, window.startIso, window.endIso);
      return formatFeedIntakeReply(totals, window.label, text);
    }

    if (/(next|predict).*(feed|eat|bottle|nurse)/.test(text)) {
      const prediction = predictNextFromIntervals(
        'next feed',
        getBabyEventTimes(chatJid, 'feed', 30),
      );
      if (!prediction) {
        return 'Need a bit more feed history before I can predict the next one.';
      }

      return `Predicted ${prediction.label}: ${formatTime(
        prediction.predictedAtIso,
      )} (${formatRelativeMinutes(prediction.minutesFromNow)}, confidence: ${
        prediction.confidence
      }).`;
    }

    if (/(next|predict).*(diaper)/.test(text)) {
      const prediction = predictNextFromIntervals(
        'next diaper change',
        getBabyEventTimes(chatJid, 'diaper', 40),
      );
      if (!prediction) {
        return 'Need a bit more diaper history before I can predict the next change.';
      }

      return `Predicted ${prediction.label}: ${formatTime(
        prediction.predictedAtIso,
      )} (${formatRelativeMinutes(prediction.minutesFromNow)}, confidence: ${
        prediction.confidence
      }).`;
    }

    if (/(next|predict).*(sleep|nap)/.test(text)) {
      const prediction = predictNextFromIntervals(
        'next sleep start',
        getBabyEventTimes(chatJid, 'sleep_start', 30),
      );
      if (!prediction) {
        return 'Need more sleep-start logs before I can estimate the next sleep window.';
      }

      return `Predicted ${prediction.label}: ${formatTime(
        prediction.predictedAtIso,
      )} (${formatRelativeMinutes(prediction.minutesFromNow)}, confidence: ${
        prediction.confidence
      }).`;
    }

    if (/(when).*(wake|wakes|wake up)/.test(text)) {
      const prediction = predictWake(chatJid);
      if (!prediction) {
        return 'I need more completed sleep sessions (start + end) to estimate wake time.';
      }

      return `Predicted ${prediction.label}: ${formatTime(
        prediction.predictedAtIso,
      )} (${formatRelativeMinutes(prediction.minutesFromNow)}, confidence: ${
        prediction.confidence
      }).`;
    }

    if (/(last).*(feed)/.test(text)) {
      return formatLastEvent('feed', getLastBabyEvent(chatJid, ['feed']));
    }

    if (/(last).*(diaper)/.test(text)) {
      return formatLastEvent('diaper', getLastBabyEvent(chatJid, ['diaper']));
    }

    if (/(last).*(sleep|nap)/.test(text)) {
      const event = getLastBabyEvent(chatJid, ['sleep_start', 'sleep_end']);
      if (!event) {
        return 'No sleep events logged yet.';
      }

      return `Last sleep event: ${event.event_type.replace(
        '_',
        ' ',
      )} at ${formatTime(event.occurred_at)} by ${event.sender_name}.`;
    }

    if (/(last).*(pump)/.test(text)) {
      return formatLastEvent('pump', getLastBabyEvent(chatJid, ['pump']));
    }

    if (/(last).*(bath)/.test(text)) {
      return formatLastEvent('bath', getLastBabyEvent(chatJid, ['bath']));
    }

    if (/(last).*(tummy)/.test(text)) {
      return formatLastEvent('tummy time', getLastBabyEvent(chatJid, ['tummy_time']));
    }

    if (/(last).*(solid|food)/.test(text)) {
      return formatLastEvent('solids', getLastBabyEvent(chatJid, ['solids']));
    }

    if (/(insight|norm|expected|should|typical|age.?based|how.?am.?i.?doing|on track|are we)/.test(text)) {
      return formatAgeInsights(chatJid);
    }

    if (/(growth|weight|height|measurement)/.test(text) && /(last|latest|current|how much|check)/.test(text)) {
      return this.handleGrowthQuery(chatJid);
    }

    if (/(pump|stash|freezer|stored milk|frozen milk)/.test(text) && /(how much|total|stash|inventory|check)/.test(text)) {
      return this.handlePumpStashQuery(chatJid);
    }

    if (/(tummy time|tummy)/.test(text) && /(how much|total|today|how long)/.test(text)) {
      const window = resolveQueryWindow(text, referenceIso);
      const tt = getTummyTimeTotal(chatJid, window.startIso, window.endIso);
      if (tt.count === 0) {
        return `No tummy time sessions recorded ${window.label}.`;
      }
      return `Tummy time ${window.label}: ${tt.totalMinutes} minutes across ${tt.count} sessions.`;
    }

    if (/(pattern|trend|week|comparison|change)/.test(text) && /(alert|compare|vs|versus|over)/.test(text)) {
      return this.handlePatternQuery(chatJid, referenceIso);
    }

    if (/(summary|today|how many|totals)/.test(text)) {
      return this.formatDailySummaryText(chatJid, referenceIso);
    }

    const lastFeed = getLastBabyEvent(chatJid, ['feed']);
    const lastDiaper = getLastBabyEvent(chatJid, ['diaper']);

    return [
      'I can answer things like:',
      '- when was the last feed?',
      '- predict next diaper/sleep',
      '- summary today',
      '- how much tummy time today?',
      '- check growth/weight',
      '- pump stash total',
      '- week comparison / pattern alerts',
      '- are we on track? (age-based insights)',
      lastFeed ? `Recent feed: ${formatTime(lastFeed.occurred_at)}` : 'No feeds logged yet.',
      lastDiaper
        ? `Recent diaper: ${formatTime(lastDiaper.occurred_at)}`
        : 'No diapers logged yet.',
    ].join('\n');
  }

  processSummaryWithVisual(chatJid: string, text: string): {
    reply: string;
    attachmentFilePath?: string;
    attachmentCaption: string;
    attachmentMimeType?: string;
  } {
    const now = new Date().toISOString();
    const summaryText = this.formatDailySummaryText(chatJid, now);
    const visual = generateVisualSummary(chatJid, text, now);
    const reply = `${summaryText}\nVisual summary (${visual.view}, ${visual.eventCount} events).`;
    if (visual.pngPath) {
      return {
        reply,
        attachmentFilePath: visual.pngPath,
        attachmentCaption: 'CribClaw visual summary',
        attachmentMimeType: 'image/png',
      };
    }
    return {
      reply: `${reply}\n(Image render unavailable on this machine right now.)`,
      attachmentCaption: 'CribClaw visual summary',
    };
  }

  private formatDailySummaryText(chatJid: string, referenceIso: string): string {
    const summary = getBabyDailySummary(chatJid, referenceIso);
    const parts: string[] = [];

    if (summary.feeds > 0) parts.push(`${summary.feeds} feeds`);
    if (summary.diapers > 0) parts.push(`${summary.diapers} diapers`);
    if (summary.sleepStarts > 0 || summary.sleepEnds > 0)
      parts.push(`${summary.sleepStarts} naps (${summary.sleepEnds} ended)`);
    if (summary.pumps > 0) parts.push(`${summary.pumps} pump sessions`);
    if (summary.tummyTimes > 0) parts.push(`${summary.tummyTimes} tummy time`);
    if (summary.solids > 0) parts.push(`${summary.solids} solids`);
    if (summary.baths > 0) parts.push(`${summary.baths} baths`);
    if (summary.growths > 0) parts.push(`${summary.growths} growth measurements`);
    if (summary.notes > 0) parts.push(`${summary.notes} notes/milestones`);

    if (parts.length === 0) {
      return 'No events logged today yet.';
    }

    return `Today: ${parts.join(', ')}.`;
  }

  private handleGrowthQuery(chatJid: string): string {
    const latest = getLatestBabyGrowth(chatJid);
    if (!latest) {
      return 'No growth measurements logged yet. Log a weight or height to start tracking.';
    }

    const parts: string[] = [`Latest measurement (${formatTime(latest.measured_at)}):`];
    if (latest.weight_lb != null) parts.push(`Weight: ${latest.weight_lb} lb`);
    if (latest.weight_kg != null) parts.push(`Weight: ${latest.weight_kg} kg`);
    if (latest.height_in != null) parts.push(`Height: ${latest.height_in} in`);
    if (latest.height_cm != null) parts.push(`Height: ${latest.height_cm} cm`);
    if (latest.head_cm != null) parts.push(`Head: ${latest.head_cm} cm`);

    // Show age if DOB is configured
    if (CRIBCLAW_BABY_DOB) {
      const dobMs = Date.parse(CRIBCLAW_BABY_DOB);
      if (Number.isFinite(dobMs)) {
        const ageDays = Math.floor((Date.now() - dobMs) / (24 * 60 * 60 * 1000));
        const ageWeeks = Math.floor(ageDays / 7);
        const ageMonths = Math.floor(ageDays / 30.44);
        parts.push(`Baby age: ${ageMonths} months (${ageWeeks} weeks)`);
      }
    }

    const history = getRecentBabyGrowth(chatJid, 5);
    if (history.length > 1) {
      const prev = history[1];
      if (latest.weight_lb != null && prev.weight_lb != null) {
        const gain = (latest.weight_lb - prev.weight_lb).toFixed(2);
        parts.push(`Weight change since last: ${Number(gain) >= 0 ? '+' : ''}${gain} lb`);
      }
    }

    return parts.join('\n');
  }

  private handlePumpStashQuery(chatJid: string): string {
    const stash = getPumpStashTotal(chatJid);
    if (stash.count === 0) {
      return 'No milk in stash. Log a pump session with amount to start tracking.';
    }

    return `Pump stash: ${stash.totalOz.toFixed(1)} oz (${Math.round(stash.totalMl)} ml) across ${stash.count} bags/containers.`;
  }

  private handlePatternQuery(chatJid: string, referenceIso: string): string {
    const comparison = getWeekComparison(chatJid, referenceIso);
    const tw = comparison.thisWeek;
    const lw = comparison.lastWeek;

    const lines: string[] = ['Week-over-week comparison:'];
    lines.push(`Feeds: ${tw.feeds} (last week: ${lw.feeds})${formatChangePercent(tw.feeds, lw.feeds)}`);
    lines.push(`Diapers: ${tw.diapers} (last week: ${lw.diapers})${formatChangePercent(tw.diapers, lw.diapers)}`);
    lines.push(`Naps: ${tw.sleepStarts} (last week: ${lw.sleepStarts})${formatChangePercent(tw.sleepStarts, lw.sleepStarts)}`);
    if (tw.totalSleepMinutes > 0 || lw.totalSleepMinutes > 0)
      lines.push(`Total sleep: ${Math.round(tw.totalSleepMinutes)} min (last week: ${Math.round(lw.totalSleepMinutes)} min)`);
    if (tw.tummyTimeMinutes > 0 || lw.tummyTimeMinutes > 0)
      lines.push(`Tummy time: ${tw.tummyTimeMinutes} min (last week: ${lw.tummyTimeMinutes} min)`);

    const alerts = detectPatternAlerts(comparison);
    if (alerts.length > 0) {
      lines.push('', 'Pattern alerts:');
      for (const alert of alerts) {
        lines.push(`- ${alert}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get the adaptive feed reminder interval based on recent feed history.
   * Returns median interval in minutes, or null if not enough data.
   */
  getAdaptiveFeedInterval(chatJid: string): number | null {
    if (!CRIBCLAW_ADAPTIVE_REMINDERS) return null;

    const times = getBabyEventTimes(chatJid, 'feed', 20);
    if (times.length < 4) return null;

    const intervals: number[] = [];
    for (let i = 1; i < times.length; i++) {
      intervals.push(minutesBetween(times[i - 1], times[i]));
    }

    return Math.round(median(intervals));
  }

  /**
   * Check if auto-escalation alert should fire (no feed in X minutes).
   * Returns alert message or null.
   */
  checkAutoEscalation(chatJid: string): string | null {
    if (CRIBCLAW_AUTO_ESCALATION_MINUTES <= 0) return null;

    const lastFeed = getLastBabyEvent(chatJid, ['feed']);
    if (!lastFeed) return null;

    const minutesSinceFeed = (Date.now() - Date.parse(lastFeed.occurred_at)) / 60000;
    if (minutesSinceFeed < CRIBCLAW_AUTO_ESCALATION_MINUTES) return null;

    const escalationKey = `cribclaw:escalation-sent:${chatJid}`;
    const lastSent = getRouterState(escalationKey);
    if (lastSent) {
      const minutesSinceAlert = (Date.now() - Date.parse(lastSent)) / 60000;
      if (minutesSinceAlert < CRIBCLAW_AUTO_ESCALATION_MINUTES) return null;
    }

    setRouterState(escalationKey, new Date().toISOString());
    const hours = Math.floor(minutesSinceFeed / 60);
    const mins = Math.round(minutesSinceFeed % 60);
    return `No feed logged in ${hours}h ${mins}m. Last feed was at ${formatTime(lastFeed.occurred_at)} by ${lastFeed.sender_name}.`;
  }

  /**
   * Generate the daily summary message for a chat.
   */
  generateDailySummary(chatJid: string): string {
    const now = new Date().toISOString();
    const summaryText = this.formatDailySummaryText(chatJid, now);

    const lines: string[] = ['Daily Summary', summaryText];

    // Add predictions
    const feedPrediction = predictNextFromIntervals(
      'next feed',
      getBabyEventTimes(chatJid, 'feed', 30),
    );
    if (feedPrediction) {
      lines.push(`Predicted ${feedPrediction.label}: ${formatRelativeMinutes(feedPrediction.minutesFromNow)}`);
    }

    // Add pattern alerts if enabled
    if (CRIBCLAW_PATTERN_ALERTS_ENABLED) {
      const comparison = getWeekComparison(chatJid, now);
      const alerts = detectPatternAlerts(comparison);
      if (alerts.length > 0) {
        lines.push('', 'Pattern alerts:');
        for (const alert of alerts) {
          lines.push(`- ${alert}`);
        }
      }
    }

    // Add today's observational stats
    const insights = getAgeBasedInsights(chatJid);
    if (insights.length > 0) {
      lines.push('', "Today's stats:");
      for (const insight of insights) {
        lines.push(`- ${insight.message}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Process a growth event: stores in the dedicated growth table in addition to baby_events.
   */
  processGrowthEvent(
    chatJid: string,
    event: ExtractedBabyEvent,
    sender: string,
    senderName: string,
  ): void {
    const attrs = event.attributes;
    const weightLb = typeof attrs.weight_lb === 'number' ? attrs.weight_lb : undefined;
    const weightKg = typeof attrs.weight_kg === 'number' ? attrs.weight_kg : undefined;
    const heightIn = typeof attrs.height_in === 'number' ? attrs.height_in : undefined;
    const heightCm = typeof attrs.height_cm === 'number' ? attrs.height_cm : undefined;

    if (weightLb || weightKg || heightIn || heightCm) {
      insertBabyGrowth({
        chat_jid: chatJid,
        measured_at: event.occurredAt,
        weight_lb: weightLb,
        weight_kg: weightKg,
        height_in: heightIn,
        height_cm: heightCm,
        sender,
        sender_name: senderName,
      });
    }
  }

  /**
   * Process a pump event: stores in the stash table if amount is provided.
   */
  processPumpEvent(
    chatJid: string,
    event: ExtractedBabyEvent,
    sender: string,
    senderName: string,
  ): void {
    const attrs = event.attributes;
    const amountOz = typeof attrs.amount_oz === 'number' ? attrs.amount_oz : 0;
    const amountMl = typeof attrs.amount_ml === 'number' ? attrs.amount_ml : 0;

    if (amountOz > 0 || amountMl > 0) {
      insertPumpStash({
        chat_jid: chatJid,
        stored_at: event.occurredAt,
        amount_oz: amountOz,
        amount_ml: amountMl,
        sender,
        sender_name: senderName,
      });
    }
  }
}

function formatChangePercent(current: number, previous: number): string {
  if (previous === 0 && current === 0) return '';
  if (previous === 0) return ' (new)';
  const change = ((current - previous) / previous) * 100;
  const sign = change >= 0 ? '+' : '';
  return ` (${sign}${Math.round(change)}%)`;
}

function detectPatternAlerts(comparison: ReturnType<typeof getWeekComparison>): string[] {
  const alerts: string[] = [];
  const tw = comparison.thisWeek;
  const lw = comparison.lastWeek;

  if (lw.feeds > 0 && tw.feeds < lw.feeds * 0.75) {
    alerts.push(`Feed count dropped ${Math.round(((lw.feeds - tw.feeds) / lw.feeds) * 100)}% compared to last week.`);
  }
  if (lw.diapers > 0 && tw.diapers < lw.diapers * 0.75) {
    alerts.push(`Diaper changes dropped ${Math.round(((lw.diapers - tw.diapers) / lw.diapers) * 100)}% compared to last week.`);
  }
  if (lw.totalSleepMinutes > 0 && tw.totalSleepMinutes < lw.totalSleepMinutes * 0.7) {
    alerts.push(`Total sleep decreased ${Math.round(((lw.totalSleepMinutes - tw.totalSleepMinutes) / lw.totalSleepMinutes) * 100)}% compared to last week.`);
  }
  if (lw.feeds > 0 && tw.feeds > lw.feeds * 1.5) {
    alerts.push(`Feed count increased ${Math.round(((tw.feeds - lw.feeds) / lw.feeds) * 100)}% — possible growth spurt.`);
  }

  return alerts;
}
