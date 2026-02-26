import { BabyEventType, CribclawIntent, ExtractedBabyEvent } from './cribclaw-types.js';

const MERIDIAN_PATTERN = '(a\\.?m\\.?|p\\.?m\\.?)';
const EXPLICIT_TIME_PATTERN = new RegExp(
  `\\bat\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIAN_PATTERN}\\b`,
  'i',
);
const COLON_TIME_PATTERN = new RegExp(
  `\\b(\\d{1,2})[:.](\\d{2})\\s*(?:${MERIDIAN_PATTERN})?\\b`,
  'i',
);
const FEED_OZ_PATTERN = /(\d+(?:\.\d+)?)\s*(?:oz|ounce|ounces)\b/i;
const FEED_ML_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:ml|milliliter|milliliters|millilitre|millilitres)\b/i;
const FEED_VOLUME_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:oz|ounce|ounces|ml|milliliter|milliliters|millilitre|millilitres)\b/i;
const MINUTES_PATTERN = /(\d+)\s*(?:min|minute|minutes)\b/i;
const RELATIVE_AGO_PATTERN =
  /\b(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+ago\b/i;
const RELATIVE_ARTICLE_AGO_PATTERN =
  /\b(an?|one)\s+(second|sec|minute|min|hour|hr)\s+ago\b/i;
const RELATIVE_HALF_HOUR_PATTERN = /\bhalf\s+an?\s+hour\s+ago\b/i;
const TEMP_CONTEXT_PATTERN =
  /(?:temp(?:erature)?|fever|warm)[^\d]{0,10}(\d{2,3}(?:\.\d+)?)\s*(°?\s*[cf])?\b/i;
const POO_PEE_AMOUNT_PATTERN =
  /\b(small|medium|large)\s+(?:amount of\s+)?(poo|poop|pee|urine)\b/gi;
const KV_PATTERN = /([a-z][a-z0-9_ -]{1,24})\s*(?:=|:)\s*([a-z0-9_.%-]+)/gi;
const PUMP_PATTERN = /\b(pump|pumped|pumping|expressed)\b/i;
const TUMMY_TIME_PATTERN = /\b(tummy\s*time|tummy)\b/i;
const SOLIDS_PATTERN = /\b(solids?|puree|cereal|avocado|banana|rice|oatmeal|sweet potato|peas|carrots|fruit|veggie|veggies|vegetables|baby food)\b/i;
const GROWTH_PATTERN = /\b(weigh|weight|weighs|weighed|height|length|head\s*circumference|measured|pounds?|lbs?|kilos?|kg|inches|cm)\b/i;
const BATH_PATTERN = /\b(bath|bathed|bathing|shower|washed)\b/i;
export const SLEEP_RANGE_PATTERN = /\b(?:slept|napped|sleep|nap)\s+(?:from\s+)?(\d{1,2})(?:[:.]([\d]{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:to|until|-|–)\s*(\d{1,2})(?:[:.]([\d]{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i;
export const WEIGHT_LB_PATTERN = /(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/i;
export const WEIGHT_KG_PATTERN = /(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilograms?)\b/i;
export const HEIGHT_IN_PATTERN = /(\d+(?:\.\d+)?)\s*(?:in(?:ches)?|")\b/i;
export const HEIGHT_CM_PATTERN = /(\d+(?:\.\d+)?)\s*(?:cm|centimeters?)\b/i;

const LOG_HINTS =
  /\b(fed|feed|fedbaby|bottle|nurse|nursing|breast|diaper|change|changed|poop|pee|wet|dirty|nap|sleep|asleep|woke|milestone|rolled|crawled|pump|pumped|pumping|tummy\s*time|solids|puree|cereal|baby food|bath|bathed|weigh|weight|measured|slept from)\b/i;
const QUERY_HINTS =
  /(when|what time|last|how many|how much|summary|today|next|predict|trend|average|totals|total|sum|calculate|intake|consumed|past|previous|remind|reminder|should i|is it time|help|what can you do|show (?:baby )?(?:settings|config|info|profile)|chart|graph|visual|report|stats|statistics|overview|history|log\b|daily|weekly)/i;
const EDIT_HINTS = /(actually|correction|correct that|update that|edit)/i;
const TASK_HINTS = /(build|generate|write code|refactor|deploy|setup|automation|tool)/i;
const ML_PER_OZ = 29.5735;
export const EVENT_KEYWORD_PATTERN =
  /(?:fed|feed|fedbaby|bottle|nurse|nursing|breast|diaper|change|changed|poop|pee|wet|dirty|bm|stool|nap|sleep|asleep|woke|milestone|rolled|crawled|stood|walked|first time|solid food|pump|pumped|pumping|tummy\s*time|solids|puree|cereal|bath|bathed|weigh|weight)/i;

interface ParsedOccurredAt {
  occurredAt: string;
  source: 'message_text' | 'message_timestamp';
  kind?: 'explicit' | 'relative' | 'fallback';
  phrase?: string;
}

/**
 * Set hours/minutes on a Date using a specific IANA timezone.
 * Returns a UTC Date representing that local time in the given timezone.
 * Falls back to Date.setHours() (server local time) if no timezone provided.
 */
function setHoursInTimezone(
  referenceDate: Date,
  hours: number,
  minutes: number,
  timezone?: string,
): Date {
  if (!timezone) {
    const d = new Date(referenceDate);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  // Get the calendar date as it appears in the user's timezone
  const ymd = referenceDate.toLocaleDateString('en-CA', { timeZone: timezone });

  // Build an ISO string treating the local time numbers as if they were UTC
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const guessUtc = new Date(`${ymd}T${h}:${m}:00.000Z`);

  // Compute the timezone's UTC offset at this approximate moment
  const fmt = (tz: string) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, hourCycle: 'h23',
    }).formatToParts(guessUtc);
    const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  };

  const utcMs = fmt('UTC');
  const tzMs = fmt(timezone);
  const offsetMs = tzMs - utcMs;

  // UTC = local - offset
  return new Date(guessUtc.getTime() - offsetMs);
}

// Fast-bypass patterns: short, unambiguous messages where regex is perfectly reliable.
// These skip the LLM entirely for instant responses.
const FAST_FEED_RE = /^\s*(?:fed|feed|bottle|nurse[ds]?|nursing|breast)\b.{0,30}\d+(?:\.\d+)?\s*(?:oz|ml|ounces?|milliliters?)\b/i;
const FAST_DIAPER_RE = /^\s*(?:diaper|change[ds]?|wet|dirty|poop|pee)\b.{0,20}(?:wet|dirty|poop|pee|both|dry|blowout)?\s*$/i;
const FAST_SLEEP_RE = /^\s*(?:asleep|woke\s+up|nap\s+(?:start|end)|sleep\s+(?:start|end)|fell\s+asleep|woke|napping|nap\s+over)\s*$/i;

/**
 * Returns true for short, unambiguous event messages where regex extraction
 * is perfectly reliable and no LLM call is needed.
 */
export function isUnambiguousEvent(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false; // Long messages may be ambiguous
  return FAST_FEED_RE.test(t) || FAST_DIAPER_RE.test(t) || FAST_SLEEP_RE.test(t);
}

export function classifyCribclawIntent(message: string): CribclawIntent {
  const text = message.trim().toLowerCase();

  if (!text) {
    return 'unknown';
  }

  if (EDIT_HINTS.test(text)) {
    return 'edit_event';
  }

  if (TASK_HINTS.test(text)) {
    return 'assistant_task';
  }

  if (text.includes('?') || QUERY_HINTS.test(text)) {
    return 'query_data';
  }

  if (LOG_HINTS.test(text) || FEED_VOLUME_PATTERN.test(text)) {
    return 'log_event';
  }

  return 'unknown';
}

function inferEventType(text: string): BabyEventType {
  const normalized = text.toLowerCase();
  const hasFeedVolume = FEED_VOLUME_PATTERN.test(normalized);

  const hasSleepWord = /(sleep|nap|asleep|awake|woke)/.test(normalized);
  const hasSleepStart =
    /(sleep\s*start|nap\s*start|fell asleep|asleep now|down for (?:a )?nap|sleeping|went to sleep|going to sleep|put (?:him|her|baby|them) down|napped?|she.?s? asleep|he.?s? asleep)/.test(
      normalized,
    );
  const hasSleepEnd = /(sleep\s*end|nap\s*end|nap\s*over|woke up|awake now|up from (?:a )?nap|just woke|she.?s? up|he.?s? up|baby.?s? up|waking up|stopped sleeping)/.test(
    normalized,
  );

  if (hasSleepWord && hasSleepStart && !hasSleepEnd) {
    return 'sleep_start';
  }

  if (hasSleepWord && hasSleepEnd) {
    return 'sleep_end';
  }

  if (GROWTH_PATTERN.test(normalized) && (WEIGHT_LB_PATTERN.test(text) || WEIGHT_KG_PATTERN.test(text) || HEIGHT_IN_PATTERN.test(text) || HEIGHT_CM_PATTERN.test(text))) {
    return 'growth';
  }

  if (PUMP_PATTERN.test(normalized)) {
    return 'pump';
  }

  if (TUMMY_TIME_PATTERN.test(normalized)) {
    return 'tummy_time';
  }

  if (BATH_PATTERN.test(normalized)) {
    return 'bath';
  }

  if (SOLIDS_PATTERN.test(normalized) && !/solid food/.test(normalized)) {
    return 'solids';
  }

  if (/\b(diaper|poop|pee|wet|dirty|bm|stool)\b/.test(normalized)) {
    return 'diaper';
  }

  if (/\b(fed|feed|fedbaby|bottle|nurse|nursing|breast)\b/.test(normalized)) {
    return 'feed';
  }

  if (/\b(milestone|rolled|crawled|stood|walked)\b|first time|solid food/.test(normalized)) {
    return 'milestone';
  }

  if (hasFeedVolume) {
    return 'feed';
  }

  return 'note';
}

function inferEventTypes(text: string): BabyEventType[] {
  const normalized = text.toLowerCase();
  const types: BabyEventType[] = [];
  const hasFeedVolume = FEED_VOLUME_PATTERN.test(normalized);

  const hasSleepWord = /(sleep|nap|asleep|awake|woke)/.test(normalized);
  const hasSleepStart =
    /(sleep\s*start|nap\s*start|fell asleep|asleep now|down for (?:a )?nap|sleeping|went to sleep|going to sleep|put (?:him|her|baby|them) down|napped?|she.?s? asleep|he.?s? asleep)/.test(
      normalized,
    );
  const hasSleepEnd = /(sleep\s*end|nap\s*end|nap\s*over|woke up|awake now|up from (?:a )?nap|just woke|she.?s? up|he.?s? up|baby.?s? up|waking up|stopped sleeping)/.test(
    normalized,
  );

  if (hasSleepWord && hasSleepStart && !hasSleepEnd) {
    types.push('sleep_start');
  }

  if (hasSleepWord && hasSleepEnd) {
    types.push('sleep_end');
  }

  if (GROWTH_PATTERN.test(normalized) && (WEIGHT_LB_PATTERN.test(text) || WEIGHT_KG_PATTERN.test(text) || HEIGHT_IN_PATTERN.test(text) || HEIGHT_CM_PATTERN.test(text))) {
    types.push('growth');
  }

  if (PUMP_PATTERN.test(normalized)) {
    types.push('pump');
  }

  if (TUMMY_TIME_PATTERN.test(normalized)) {
    types.push('tummy_time');
  }

  if (BATH_PATTERN.test(normalized)) {
    types.push('bath');
  }

  if (SOLIDS_PATTERN.test(normalized) && !/solid food/.test(normalized)) {
    types.push('solids');
  }

  if (/\b(diaper|poop|pee|wet|dirty|bm|stool)\b/.test(normalized)) {
    types.push('diaper');
  }

  if (/\b(fed|feed|fedbaby|bottle|nurse|nursing|breast)\b/.test(normalized)) {
    types.push('feed');
  }

  if (/\b(milestone|rolled|crawled|stood|walked)\b|first time|solid food/.test(normalized)) {
    types.push('milestone');
  }

  if (hasFeedVolume) {
    types.push('feed');
  }

  if (types.length === 0) {
    return ['note'];
  }

  return [...new Set(types)];
}

function parseRelativeAgo(
  text: string,
  receivedAt: Date,
): ParsedOccurredAt | undefined {
  if (RELATIVE_HALF_HOUR_PATTERN.test(text)) {
    const occurred = new Date(receivedAt.getTime() - 30 * 60000);
    return {
      occurredAt: occurred.toISOString(),
      source: 'message_text',
      kind: 'relative',
      phrase: 'half an hour ago',
    };
  }

  const articleMatch = text.match(RELATIVE_ARTICLE_AGO_PATTERN);
  if (articleMatch?.[2]) {
    const unitRaw = articleMatch[2].toLowerCase();
    const minutes = unitRaw.startsWith('hour')
      ? 60
      : unitRaw.startsWith('min')
        ? 1
        : 1 / 60;
    const occurred = new Date(receivedAt.getTime() - minutes * 60000);
    return {
      occurredAt: occurred.toISOString(),
      source: 'message_text',
      kind: 'relative',
      phrase: articleMatch[0],
    };
  }

  const numericMatch = text.match(RELATIVE_AGO_PATTERN);
  if (!numericMatch?.[1] || !numericMatch[2]) {
    return undefined;
  }
  const amount = Number(numericMatch[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  const unitRaw = numericMatch[2].toLowerCase();
  const minutes = unitRaw.startsWith('hour')
    ? amount * 60
    : unitRaw.startsWith('min')
      ? amount
      : amount / 60;
  const occurred = new Date(receivedAt.getTime() - minutes * 60000);
  return {
    occurredAt: occurred.toISOString(),
    source: 'message_text',
    kind: 'relative',
    phrase: numericMatch[0],
  };
}

function parseOccurredAt(text: string, receivedAt: string, timezone?: string): ParsedOccurredAt {
  const fallback = new Date(receivedAt);
  const explicitMatch = text.match(EXPLICIT_TIME_PATTERN);
  const colonMatch = text.match(COLON_TIME_PATTERN);
  const match = explicitMatch ?? colonMatch;

  if (match) {
    const hoursRaw = Number(match[1]);
    const minuteRaw = Number(match[2] ?? '0');
    const meridian = match[3]?.toLowerCase();
    const normalizedMeridian = meridian?.replace(/\./g, '');

    let hours = hoursRaw;

    if (normalizedMeridian === 'pm' && hours < 12) {
      hours += 12;
    }

    if (normalizedMeridian === 'am' && hours === 12) {
      hours = 0;
    }

    if (!meridian && (hours > 23 || minuteRaw > 59)) {
      return {
        occurredAt: fallback.toISOString(),
        source: 'message_timestamp',
        kind: 'fallback',
      };
    }

    const resolved = setHoursInTimezone(fallback, hours, minuteRaw, timezone);
    return {
      occurredAt: resolved.toISOString(),
      source: 'message_text',
      kind: 'explicit',
      phrase: match[0],
    };
  }

  const relative = parseRelativeAgo(text, fallback);
  if (relative) {
    return relative;
  }

  return {
    occurredAt: fallback.toISOString(),
    source: 'message_timestamp',
    kind: 'fallback',
  };
}

function parseCustomAttributes(text: string): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};

  for (const match of text.matchAll(KV_PATTERN)) {
    const rawKey = match[1]?.trim();
    const rawValue = match[2]?.trim();
    if (!rawKey || !rawValue) {
      continue;
    }

    const key = rawKey.toLowerCase().replace(/\s+/g, '_');

    if (/^(true|false)$/i.test(rawValue)) {
      attributes[key] = rawValue.toLowerCase() === 'true';
      continue;
    }

    const numeric = Number(rawValue);
    if (!Number.isNaN(numeric) && rawValue !== '') {
      attributes[key] = numeric;
      continue;
    }

    attributes[key] = rawValue;
  }

  return attributes;
}

function buildSummary(eventType: BabyEventType, text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();

  if (compact.length <= 160) {
    return compact;
  }

  return `${eventType}: ${compact.slice(0, 157)}...`;
}

function maybeParseTemperature(text: string): {
  fahrenheit?: number;
  celsius?: number;
} | null {
  const match = text.match(TEMP_CONTEXT_PATTERN);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || '').toLowerCase().replace(/[^\w]/g, '');

  if (unit === 'c') {
    return {
      celsius: Number(value.toFixed(2)),
      fahrenheit: Number(((value * 9) / 5 + 32).toFixed(2)),
    };
  }
  if (unit === 'f') {
    return {
      fahrenheit: Number(value.toFixed(2)),
      celsius: Number((((value - 32) * 5) / 9).toFixed(2)),
    };
  }
  if (value <= 45) {
    return {
      celsius: Number(value.toFixed(2)),
      fahrenheit: Number(((value * 9) / 5 + 32).toFixed(2)),
    };
  }
  return {
    fahrenheit: Number(value.toFixed(2)),
    celsius: Number((((value - 32) * 5) / 9).toFixed(2)),
  };
}

function extractMoodTag(text: string): string | undefined {
  const moodMatch = text
    .toLowerCase()
    .match(/\b(happy|fussy|calm|cranky|sleepy|gassy|alert)\b/);
  return moodMatch?.[1];
}

function enrichInterestingAttributes(
  text: string,
  eventType: BabyEventType,
  attributes: Record<string, string | number | boolean>,
): void {
  const lowered = text.toLowerCase();

  const mood = extractMoodTag(text);
  if (mood) {
    attributes.mood = mood;
  }

  if (/\bspit ?up|vomit|threw up\b/.test(lowered)) {
    attributes.spit_up = true;
  }
  if (/\bgas|gassy\b/.test(lowered)) {
    attributes.gassy = true;
  }
  if (/\brash\b/.test(lowered)) {
    attributes.rash = true;
  }
  if (/\bcough|congestion|stuffy\b/.test(lowered)) {
    attributes.respiratory_note = true;
  }

  const temp = maybeParseTemperature(text);
  if (temp?.fahrenheit !== undefined) {
    attributes.temperature_f = temp.fahrenheit;
  }
  if (temp?.celsius !== undefined) {
    attributes.temperature_c = temp.celsius;
  }

  if (eventType === 'feed') {
    if (/\bbottle\b/.test(lowered)) {
      attributes.feed_method = 'bottle';
    } else if (/\bnurse|nursing|breast\b/.test(lowered)) {
      attributes.feed_method = 'breast';
    }
  }

  if (eventType === 'diaper') {
    for (const match of lowered.matchAll(POO_PEE_AMOUNT_PATTERN)) {
      const amount = match[1];
      const kind = match[2];
      if (!amount || !kind) continue;
      if (kind.startsWith('poo') || kind.startsWith('poop')) {
        attributes.poop_amount = amount;
      } else {
        attributes.pee_amount = amount;
      }
    }
  }

  if (eventType === 'pump') {
    if (/\bleft\b/.test(lowered)) attributes.side = 'left';
    if (/\bright\b/.test(lowered)) attributes.side = 'right';
    if (/\bboth\b/.test(lowered)) attributes.side = 'both';
  }

  if (eventType === 'growth') {
    const weightLb = text.match(WEIGHT_LB_PATTERN);
    if (weightLb?.[1]) attributes.weight_lb = Number(weightLb[1]);
    const weightKg = text.match(WEIGHT_KG_PATTERN);
    if (weightKg?.[1]) attributes.weight_kg = Number(weightKg[1]);
    const heightIn = text.match(HEIGHT_IN_PATTERN);
    if (heightIn?.[1]) attributes.height_in = Number(heightIn[1]);
    const heightCm = text.match(HEIGHT_CM_PATTERN);
    if (heightCm?.[1]) attributes.height_cm = Number(heightCm[1]);
  }

  if (eventType === 'tummy_time') {
    const durMatch = text.match(/(\d+)\s*(?:min|minutes?)\b/i);
    if (durMatch?.[1]) attributes.duration_minutes = Number(durMatch[1]);
  }

  if (eventType === 'solids') {
    const foodMatch = text.match(/\b(avocado|banana|rice|oatmeal|sweet potato|peas|carrots|apples?|pears?|squash|chicken|turkey|yogurt|cereal)\b/i);
    if (foodMatch?.[1]) attributes.food_item = foodMatch[1].toLowerCase();
  }
}

function normalizeFeedVolume(attributes: Record<string, string | number | boolean>): void {
  const amountOz =
    typeof attributes.amount_oz === 'number' ? (attributes.amount_oz as number) : undefined;
  const amountMl =
    typeof attributes.amount_ml === 'number' ? (attributes.amount_ml as number) : undefined;

  if (amountOz !== undefined && amountMl === undefined) {
    attributes.amount_ml = Math.round(amountOz * ML_PER_OZ);
    return;
  }

  if (amountMl !== undefined && amountOz === undefined) {
    attributes.amount_oz = Number((amountMl / ML_PER_OZ).toFixed(2));
  }
}

function buildExtractedEvent(
  text: string,
  receivedAt: string,
  forcedType?: BabyEventType,
  timezone?: string,
): ExtractedBabyEvent {
  const eventType = forcedType || inferEventType(text);
  const parsedTime = parseOccurredAt(text, receivedAt, timezone);
  const attributes = parseCustomAttributes(text);
  const lowered = text.toLowerCase();
  const occurredAt = parsedTime.occurredAt;

  // Handle "slept from X to Y" range syntax — produces both sleep_start and sleep_end
  // This is handled by extractBabyEvents which will call this function for each derived type

  // For sleep range messages, if this is specifically a sleep_start, use the start time
  // and if sleep_end, use the end time. The caller handles splitting.

  const ozMatch = text.match(FEED_OZ_PATTERN);
  if (ozMatch?.[1]) {
    attributes.amount_oz = Number(ozMatch[1]);
  }

  const mlMatch = text.match(FEED_ML_PATTERN);
  if (mlMatch?.[1]) {
    attributes.amount_ml = Number(mlMatch[1]);
  }

  if (eventType === 'feed') {
    normalizeFeedVolume(attributes);
  }

  if (eventType === 'pump') {
    normalizeFeedVolume(attributes);
  }

  if (/(left side|left breast)/i.test(text)) {
    attributes.side = 'left';
  }

  if (/(right side|right breast)/i.test(text)) {
    attributes.side = 'right';
  }

  const minutesMatch = text.match(MINUTES_PATTERN);
  if (minutesMatch?.[1]) {
    attributes.duration_minutes = Number(minutesMatch[1]);
  }

  if (eventType === 'diaper') {
    attributes.wet = /(wet|pee)/.test(lowered);
    attributes.dirty = /(dirty|poop|bm\b|stool)/.test(lowered);

    if (/(blowout)/.test(lowered)) {
      attributes.severity = 'blowout';
    }

    if (/(green|yellow|brown|black)/.test(lowered)) {
      const color = lowered.match(/green|yellow|brown|black/)?.[0];
      if (color) {
        attributes.color = color;
      }
    }
  }

  attributes.event_time_source = parsedTime.source;
  if (parsedTime.kind) {
    attributes.event_time_kind = parsedTime.kind;
  }
  if (parsedTime.phrase) {
    attributes.event_time_phrase = parsedTime.phrase.trim();
  }

  enrichInterestingAttributes(text, eventType, attributes);

  const confidenceByType: Record<BabyEventType, number> = {
    feed: 0.88,
    diaper: 0.9,
    sleep_start: 0.86,
    sleep_end: 0.86,
    milestone: 0.8,
    note: 0.7,
    pump: 0.88,
    tummy_time: 0.9,
    solids: 0.85,
    growth: 0.92,
    bath: 0.9,
  };

  return {
    eventType,
    occurredAt,
    summary: buildSummary(eventType, text),
    confidence: confidenceByType[eventType],
    attributes,
  };
}

export function extractBabyEvent(text: string, receivedAt: string, timezone?: string): ExtractedBabyEvent {
  return buildExtractedEvent(text, receivedAt, undefined, timezone);
}

function splitMultiEventMessage(text: string): string[] {
  const normalized = text
    .replace(/\n+/g, '; ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return [];
  }

  const delimiter = new RegExp(
    `(?:;\\s*|,\\s*(?=${EVENT_KEYWORD_PATTERN.source})|\\s+and\\s+(?=${EVENT_KEYWORD_PATTERN.source}))`,
    'i',
  );
  const parts = normalized
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [normalized];
}

export function extractBabyEvents(text: string, receivedAt: string, timezone?: string): ExtractedBabyEvent[] {
  // Handle "slept from X to Y" — produces both sleep_start and sleep_end events
  const sleepRangeMatch = text.match(SLEEP_RANGE_PATTERN);
  if (sleepRangeMatch) {
    const fallback = new Date(receivedAt);

    const startHourRaw = Number(sleepRangeMatch[1]);
    const startMin = Number(sleepRangeMatch[2] || '0');
    const startMeridian = (sleepRangeMatch[3] || '').replace(/\./g, '').toLowerCase();
    const endHourRaw = Number(sleepRangeMatch[4]);
    const endMin = Number(sleepRangeMatch[5] || '0');
    const endMeridian = (sleepRangeMatch[6] || '').replace(/\./g, '').toLowerCase();

    let startHour = startHourRaw;
    let endHour = endHourRaw;

    // If only end has meridian, infer start from context
    const effectiveStartMeridian = startMeridian || endMeridian;
    const effectiveEndMeridian = endMeridian || startMeridian;

    if (effectiveStartMeridian === 'pm' && startHour < 12) startHour += 12;
    if (effectiveStartMeridian === 'am' && startHour === 12) startHour = 0;
    if (effectiveEndMeridian === 'pm' && endHour < 12) endHour += 12;
    if (effectiveEndMeridian === 'am' && endHour === 12) endHour = 0;

    const startDate = setHoursInTimezone(fallback, startHour, startMin, timezone);
    const endDate = setHoursInTimezone(fallback, endHour, endMin, timezone);

    // If end is before start, the sleep crossed midnight — adjust start to previous day
    if (endDate <= startDate) {
      startDate.setDate(startDate.getDate() - 1);
    }

    const durationMinutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

    const sleepStart: ExtractedBabyEvent = {
      eventType: 'sleep_start',
      occurredAt: startDate.toISOString(),
      summary: `Sleep start (from range: ${sleepRangeMatch[0]})`,
      confidence: 0.88,
      attributes: { event_time_source: 'message_text', event_time_kind: 'explicit', sleep_range: true },
    };

    const sleepEnd: ExtractedBabyEvent = {
      eventType: 'sleep_end',
      occurredAt: endDate.toISOString(),
      summary: `Sleep end (from range: ${sleepRangeMatch[0]}, duration: ${durationMinutes} min)`,
      confidence: 0.88,
      attributes: { event_time_source: 'message_text', event_time_kind: 'explicit', sleep_range: true, duration_minutes: durationMinutes },
    };

    return [sleepStart, sleepEnd];
  }

  const segments = splitMultiEventMessage(text);
  if (segments.length === 0) {
    return [extractBabyEvent(text, receivedAt, timezone)];
  }

  if (segments.length === 1) {
    const inferredTypes = inferEventTypes(segments[0]);
    if (inferredTypes.length > 1) {
      return inferredTypes.map((eventType) =>
        buildExtractedEvent(segments[0], receivedAt, eventType, timezone),
      );
    }
  }

  const events = segments.map((segment) => extractBabyEvent(segment, receivedAt, timezone));
  const realEvents = events.filter((event) => event.eventType !== 'note');
  if (realEvents.length > 0) {
    return realEvents;
  }

  return [extractBabyEvent(text, receivedAt, timezone)];
}
