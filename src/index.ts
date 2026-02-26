import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CRIBCLAW_FEED_REMINDERS_ENABLED,
  CRIBCLAW_FEED_REMINDER_MINUTES,
  CRIBCLAW_ALLOW_ASSISTANT_TASKS,
  CRIBCLAW_ENABLED,
  CRIBCLAW_FAMILY_FOLDER,
  CRIBCLAW_LLM_FIRST,
  CRIBCLAW_OWNER_SENDERS,
  CRIBCLAW_RUNTIME_MODE,
  CRIBCLAW_DAILY_SUMMARY_ENABLED,
  CRIBCLAW_DAILY_SUMMARY_HOUR,
  CRIBCLAW_PATTERN_ALERTS_ENABLED,
  CRIBCLAW_AUTO_ESCALATION_MINUTES,
  CRIBCLAW_BABY_DOB,
  CRIBCLAW_BABY_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  PRIMARY_CHANNEL,
  TELEGRAM_BOT_TOKEN,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { TelegramChannel } from './channels/telegram.js';

import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  completeCribclawReminder,
  exportAllBabyCsvSnapshots,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getBabyDailySummary,
  getDueCribclawReminders,
  getLastBabyEvent,
  getLastBabyEventAny,
  getMessagesSince,
  getOpenBabySleepSessions,
  getNewMessages,
  getRouterState,
  getWeekComparison,
  initDatabase,
  rescheduleCribclawReminder,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { CribclawService, getTimezone } from './cribclaw.js';
import { classifyCribclawIntent, EVENT_KEYWORD_PATTERN, extractBabyEvents, isUnambiguousEvent } from './cribclaw-extractor.js';
import { ExtractedBabyEvent, LlmAction, LlmConfigUpdate } from './cribclaw-types.js';
import { printCribclawBanner } from './banner.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let lastFeedReminderCheckAt = 0;
let lastCustomReminderCheckAt = 0;
let lastDailySummaryCheckAt = 0;
let lastAutoEscalationCheckAt = 0;
let lastSleepAutoCloseCheckAt = 0;

const channels: Channel[] = [];
const queue = new GroupQueue();
const cribclaw = new CribclawService();
const cribclawOwnerSenders = new Set(CRIBCLAW_OWNER_SENDERS);
const VOICE_NOTE_FILE_MARKER = '__VOICE_NOTE_FILE__:';
const CSV_IMPORT_FILE_MARKER = '__CSV_IMPORT_FILE__:';

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function getBabyProfile(chatJid: string) {
  const name = getRouterState(`cribclaw:baby-name:${chatJid}`) || CRIBCLAW_BABY_NAME || '';
  const dob = getRouterState(`cribclaw:baby-dob:${chatJid}`) || CRIBCLAW_BABY_DOB || '';
  const birthWeight = getRouterState(`cribclaw:birth-weight:${chatJid}`) || '';
  const tz = getRouterState(`cribclaw:timezone:${chatJid}`) || TIMEZONE || '';
  const missing: string[] = [];
  if (!name) missing.push('name');
  if (!dob) missing.push('date of birth');
  if (!birthWeight) missing.push('birth weight');
  if (!tz) missing.push('timezone');
  return { name, dob, birthWeight, timezone: tz, missingFields: missing };
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

function coerceEventArray(
  raw: unknown,
  fallbackTimestampIso: string,
): ExtractedBabyEvent[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;

  const allowedTypes = new Set([
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
  ]);

  const events: ExtractedBabyEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const eventType = candidate.event_type;
    if (typeof eventType !== 'string' || !allowedTypes.has(eventType)) continue;

    const occurredRaw =
      typeof candidate.occurred_at === 'string'
        ? candidate.occurred_at
        : fallbackTimestampIso;
    const occurred = new Date(occurredRaw);
    const attributes: Record<string, string | number | boolean> = {};
    if (candidate.attributes && typeof candidate.attributes === 'object') {
      for (const [key, value] of Object.entries(
        candidate.attributes as Record<string, unknown>,
      )) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          attributes[key] = value;
        }
      }
    }

    const confidenceRaw = Number(candidate.confidence ?? 0.8);
    events.push({
      eventType: eventType as ExtractedBabyEvent['eventType'],
      occurredAt: Number.isNaN(occurred.getTime())
        ? fallbackTimestampIso
        : occurred.toISOString(),
      summary:
        typeof candidate.summary === 'string' && candidate.summary.trim()
          ? candidate.summary.trim()
          : `LLM extracted ${eventType}`,
      confidence:
        Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1
          ? confidenceRaw
          : 0.8,
      attributes,
    });
  }

  return events.length > 0 ? events : undefined;
}

function parseLlmEventExtractionOutput(
  rawResult: string,
  fallbackTimestampIso: string,
): ExtractedBabyEvent[] | undefined {
  const candidates: string[] = [];
  const trimmed = rawResult.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  const fencedMatches = rawResult.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const match of fencedMatches) {
    const inner = match
      .replace(/```(?:json)?/i, '')
      .replace(/```/g, '')
      .trim();
    if (inner) {
      candidates.push(inner);
    }
  }

  const firstBrace = rawResult.indexOf('{');
  const lastBrace = rawResult.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const bracketSlice = rawResult.slice(firstBrace, lastBrace + 1).trim();
    if (bracketSlice) {
      candidates.push(bracketSlice);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { events?: unknown } | unknown[];
      if (Array.isArray(parsed)) {
        const coercedArray = coerceEventArray(parsed, fallbackTimestampIso);
        if (coercedArray) return coercedArray;
        continue;
      }
      const coerced = coerceEventArray(
        (parsed as { events?: unknown }).events,
        fallbackTimestampIso,
      );
      if (coerced) return coerced;
    } catch {
      // try next candidate
    }
  }

  return undefined;
}

function parseLlmActionOutput(
  rawResult: string,
  fallbackTimestampIso: string,
): LlmAction | undefined {
  const candidates: string[] = [];
  const trimmed = rawResult.trim();

  // Try raw
  candidates.push(trimmed);

  // Try code fence extraction
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());

  // Try brace extraction
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || !parsed.action) continue;

      switch (parsed.action) {
        case 'config_update':
          if (parsed.updates && typeof parsed.updates === 'object') {
            return { action: 'config_update', updates: parsed.updates };
          }
          break;

        case 'log_events': {
          const events = coerceEventArray(
            Array.isArray(parsed.events) ? parsed.events : [],
            fallbackTimestampIso,
          );
          if (events && events.length > 0) {
            return { action: 'log_events', events };
          }
          break;
        }

        case 'mixed': {
          const mixedEvents = coerceEventArray(
            Array.isArray(parsed.events) ? parsed.events : [],
            fallbackTimestampIso,
          );
          return {
            action: 'mixed',
            config_updates: parsed.config_updates || {},
            events: mixedEvents || [],
          };
        }

        case 'query':
          if (typeof parsed.reply === 'string') {
            return { action: 'query', reply: parsed.reply };
          }
          break;

        case 'chat':
          if (typeof parsed.reply === 'string') {
            return { action: 'chat', reply: parsed.reply };
          }
          break;

        case 'none':
          return { action: 'none' };
      }
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

async function extractEventsWithLlmFirst(
  group: RegisteredGroup,
  chatJid: string,
  message: NewMessage,
): Promise<ExtractedBabyEvent[] | undefined> {
  const llmExtractTimeout = Math.max(
    5_000,
    parseInt(process.env.CRIBCLAW_LLM_EXTRACT_TIMEOUT_MS || '15000', 10) || 15_000,
  );
  const fastTimeoutGroup: RegisteredGroup = {
    ...group,
    containerConfig: {
      ...group.containerConfig,
      timeout: llmExtractTimeout,
    },
  };

  const prompt = [
    'You extract baby tracking events from caregiver messages.',
    'Return strict JSON only. No markdown, no explanation.',
    'Schema:',
    '{"events":[{"event_type":"feed|diaper|sleep_start|sleep_end|milestone|note|pump|tummy_time|solids|growth|bath","occurred_at":"ISO-8601 optional","summary":"short text","confidence":0.0-1.0,"attributes":{"key":"string|number|boolean"}}]}',
    'Additional event types:',
    '- pump: breast milk pumping session. Attributes: amount_ml, amount_oz, duration_minutes, side (left/right/both).',
    '- tummy_time: supervised tummy time session. Attributes: duration_minutes.',
    '- solids: solid food feeding (purees, baby-led weaning). Attributes: food_name, amount, reaction.',
    '- growth: weight/height/head measurement. Attributes: weight_kg, weight_lb, height_cm, height_in, head_cm.',
    '- bath: bath or wash. Attributes: duration_minutes, water_temperature_f.',
    'If no event is present, return {"events":[]}.',
    'If multiple events exist in one message, include all.',
    'Event types are not mutually exclusive: one message can produce feed + diaper + note, etc.',
    'Always infer occurred_at from text when possible; otherwise use the message timestamp.',
    'Set attributes.event_time_source to "message_text" or "message_timestamp".',
    'If a quantity in ml/oz appears, classify as feed (not note).',
    'If feed details and contextual sentiment are both present, include feed event and a separate note event.',
    'Prefer structured feed attributes: amount_ml, amount_oz, side, duration_minutes when available.',
    'Capture interesting variables when present: mood, temperature_f/temperature_c, feed_method, poop_amount, pee_amount, spit_up, gassy, rash.',
    'When the user mentions a time (e.g. "at 3pm"), interpret it in their timezone below. Return occurred_at as UTC ISO-8601.',
    `User timezone: ${getTimezone(chatJid) || 'unknown (use message timestamp)'}`,
    `Message timestamp: ${message.timestamp}`,
    `Sender: ${message.sender_name}`,
    `Message: ${message.content}`,
  ].join('\n');

  const output = await runContainerAgent(
    fastTimeoutGroup,
    {
      prompt,
      groupFolder: group.folder,
      chatJid,
      isMain: group.folder === MAIN_GROUP_FOLDER,
      oneShot: true,
    },
    () => {
      // one-off extraction path; no queue streaming registration
    },
  );

  if (output.status !== 'success') {
    logger.warn(
      { chatJid, status: output.status, error: output.error },
      'LLM event extraction failed',
    );
    return undefined;
  }

  if (!output.result) {
    logger.warn({ chatJid }, 'LLM event extraction returned empty result');
    return undefined;
  }

  const parsed = parseLlmEventExtractionOutput(output.result, message.timestamp);
  if (!parsed) {
    logger.warn(
      { chatJid, outputPreview: output.result.slice(0, 300) },
      'LLM event extraction returned unparseable output',
    );
  }
  return parsed;
}

async function transcribeVoiceNoteWithAgent(
  group: RegisteredGroup,
  chatJid: string,
  message: NewMessage,
): Promise<string | undefined> {
  if (!message.content.startsWith(VOICE_NOTE_FILE_MARKER)) {
    return undefined;
  }

  const containerAudioPath = message.content.slice(VOICE_NOTE_FILE_MARKER.length).trim();
  if (!containerAudioPath || containerAudioPath === '__unavailable__') return undefined;

  const prompt = [
    'You are doing audio transcription for a baby tracking assistant.',
    'Transcribe this audio file into plain text.',
    'Return strict JSON only: {"transcript":"..."}',
    'If the environment cannot transcribe audio directly, return {"transcript":""} immediately.',
    'Do not browse or run long tasks.',
    `Audio file path: ${containerAudioPath}`,
  ].join('\n');

  const fastTimeoutGroup: RegisteredGroup = {
    ...group,
    containerConfig: {
      ...group.containerConfig,
      timeout: 45000,
    },
  };

  logger.info(
    { chatJid, audioPath: containerAudioPath },
    'Starting agent voice transcription',
  );
  const output = await runContainerAgent(
    fastTimeoutGroup,
    {
      prompt,
      groupFolder: group.folder,
      chatJid,
      isMain: group.folder === MAIN_GROUP_FOLDER,
      oneShot: true,
    },
    () => {
      // one-off transcription path
    },
  );

  if (output.status !== 'success' || !output.result) {
    logger.warn(
      { chatJid, status: output.status, error: output.error },
      'Agent voice transcription returned no usable result',
    );
    return undefined;
  }

  try {
    const parsed = JSON.parse(output.result) as { transcript?: unknown };
    if (typeof parsed.transcript === 'string') {
      const transcript = parsed.transcript.trim();
      return transcript || undefined;
    }
  } catch {
    const text = output.result.trim();
    if (text && !text.startsWith('{')) {
      logger.info(
        { chatJid, transcriptLength: text.length },
        'Agent voice transcription returned plain text',
      );
      return text;
    }
  }

  logger.warn(
    { chatJid, outputPreview: output.result.slice(0, 200) },
    'Agent voice transcription returned empty/invalid transcript payload',
  );
  return undefined;
}

async function answerQueryWithLlmFirst(
  group: RegisteredGroup,
  chatJid: string,
  message: NewMessage,
): Promise<string | undefined> {
  const llmQueryTimeout = Math.max(
    8_000,
    parseInt(process.env.CRIBCLAW_LLM_QUERY_TIMEOUT_MS || '25000', 10) || 25_000,
  );
  const fastTimeoutGroup: RegisteredGroup = {
    ...group,
    containerConfig: {
      ...group.containerConfig,
      timeout: llmQueryTimeout,
    },
  };

  const summary = getBabyDailySummary(chatJid, new Date().toISOString());
  const lastFeed = getLastBabyEvent(chatJid, ['feed']);
  const lastDiaper = getLastBabyEvent(chatJid, ['diaper']);

  const prompt = [
    'You are CribClaw family assistant. Answer the caregiver question briefly and directly.',
    'Use provided structured context first; do not invent facts.',
    'If context is insufficient, say what is missing and suggest one next log/action.',
    `Question: ${message.content}`,
    `Today counts: feeds=${summary.feeds}, diapers=${summary.diapers}, sleep_starts=${summary.sleepStarts}, sleep_ends=${summary.sleepEnds}, notes=${summary.notes}, pumps=${summary.pumps}, tummy_times=${summary.tummyTimes}, solids=${summary.solids}, growths=${summary.growths}, baths=${summary.baths}`,
    `Last feed: ${lastFeed ? `${lastFeed.occurred_at} by ${lastFeed.sender_name}` : 'none'}`,
    `Last diaper: ${lastDiaper ? `${lastDiaper.occurred_at} by ${lastDiaper.sender_name}` : 'none'}`,
    'Return plain text only.',
  ].join('\n');

  const output = await runContainerAgent(
    fastTimeoutGroup,
    {
      prompt,
      groupFolder: group.folder,
      chatJid,
      isMain: group.folder === MAIN_GROUP_FOLDER,
      oneShot: true,
    },
    () => {
      // one-off query path
    },
  );

  if (output.status !== 'success' || !output.result) return undefined;
  const text = formatOutbound(
    typeof output.result === 'string' ? output.result : JSON.stringify(output.result),
  );
  return text || undefined;
}

/**
 * Classify a message using a direct Anthropic API call (no container overhead).
 * This is fast (~1-2s) because it skips container startup entirely.
 */
async function classifyWithLlm(
  _group: RegisteredGroup,
  chatJid: string,
  message: NewMessage,
  profile: ReturnType<typeof getBabyProfile>,
): Promise<LlmAction | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.debug('classifyWithLlm: no ANTHROPIC_API_KEY, skipping');
    return undefined;
  }

  try {
    const tz = getTimezone(chatJid);
    const tzInfo = tz || 'unknown (use message timestamp)';

    let queryContext = '';
    try {
      const summary = getBabyDailySummary(chatJid, message.timestamp);
      const lastFeed = getLastBabyEvent(chatJid, ['feed']);
      const lastDiaper = getLastBabyEvent(chatJid, ['diaper']);
      queryContext = [
        `Today's stats: ${summary.feeds} feeds, ${summary.diapers} diapers, ${summary.sleepStarts} sleeps`,
        lastFeed ? `Last feed: ${lastFeed.occurred_at}` : 'No feeds logged yet',
        lastDiaper ? `Last diaper: ${lastDiaper.occurred_at}` : 'No diapers logged yet',
      ].join('\n');
    } catch {
      // Non-critical
    }

    const userPrompt = [
      'Baby profile:',
      `  Name: ${profile.name || '(not set)'}`,
      `  DOB: ${profile.dob || '(not set)'}`,
      `  Birth weight: ${profile.birthWeight || '(not set)'}`,
      `  Timezone: ${profile.timezone || '(not set)'}`,
      profile.missingFields.length > 0 ? `  Missing: ${profile.missingFields.join(', ')}` : '  Profile complete',
      '',
      'Recent context:',
      queryContext || '  No data yet',
      '',
      `User timezone: ${tzInfo}`,
      `Message timestamp: ${message.timestamp}`,
      `Sender: ${message.sender_name}`,
      `Message: ${message.content}`,
    ].join('\n');

    const systemPrompt = [
      'You are CribClaw, a baby tracking assistant. Classify caregiver messages and return strict JSON only.',
      '',
      'Return ONE JSON object with one of these action types:',
      '',
      '1. config_update — setting baby name, DOB, birth weight, or timezone',
      '   {"action":"config_update","updates":{"name":"...","dob":"YYYY-MM-DD","birth_weight":"...","timezone":"IANA/Zone"}}',
      '',
      '2. log_events — logging baby events',
      '   {"action":"log_events","events":[{"event_type":"feed|diaper|sleep_start|sleep_end|milestone|note|pump|tummy_time|solids|growth|bath","occurred_at":"ISO-8601","summary":"short text","confidence":0.0-1.0,"attributes":{...}}]}',
      '',
      '3. mixed — both profile updates AND baby events',
      '   {"action":"mixed","config_updates":{...},"events":[...]}',
      '',
      '4. query — asking about baby data',
      '   {"action":"query","reply":"brief answer using context provided"}',
      '',
      '5. chat — greeting, conversation, help, or unclear',
      '   {"action":"chat","reply":"brief friendly response"}',
      '',
      '6. none — empty or irrelevant',
      '   {"action":"none"}',
      '',
      'Rules:',
      '- If baby name is NOT set and message has a capitalized name with a date or weight, return config_update.',
      '- A quantity with ml/oz = log_events (feed).',
      '- "fill in missing info: ..." = config_update.',
      '- For log_events: include amount_ml, amount_oz, wet, dirty, duration_minutes, side, mood, spit_up, gassy, etc.',
      '- Times in user timezone; return occurred_at as UTC ISO-8601.',
      '- Set attributes.event_time_source to "message_text" or "message_timestamp".',
      '- Return ONLY JSON. No markdown. No explanation.',
    ].join('\n');

    const model = process.env.CRIBCLAW_CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
    const timeoutMs = Number(process.env.CRIBCLAW_LLM_EXTRACT_TIMEOUT_MS || '10000');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      logger.warn({ status: res.status, statusText: res.statusText }, 'classifyWithLlm API error');
      return undefined;
    }

    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = body.content?.find((b) => b.type === 'text')?.text;
    if (!text) return undefined;

    const action = parseLlmActionOutput(text, message.timestamp);
    if (action) {
      logger.info(
        { chatJid, action: action.action, model },
        'classifyWithLlm result',
      );
      return action;
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.warn({ chatJid }, 'classifyWithLlm timed out');
    } else {
      logger.warn({ err: err?.message || err }, 'classifyWithLlm failed');
    }
  }
  return undefined;
}

async function processCribclawMessages(
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
  messages: NewMessage[],
): Promise<{ hadError: boolean; outputSentToUser: boolean }> {
  let hadError = false;
  let outputSentToUser = false;
  const unhandledMessages: NewMessage[] = [];

  for (const message of messages) {
    try {
      let messageForProcessing = message;

      // CSV file import via Telegram chat
      if (message.content.startsWith(CSV_IMPORT_FILE_MARKER)) {
        const csvPath = message.content.slice(CSV_IMPORT_FILE_MARKER.length).trim();
        await channel.sendMessage(chatJid, 'CSV file received. Importing...');
        outputSentToUser = true;
        try {
          // Dynamic import from scripts/ — use import.meta.url for reliable path resolution
          const scriptDir = path.resolve(new URL('.', import.meta.url).pathname, '..', 'scripts');
          const mod = await import(path.join(scriptDir, 'cribclaw-import-csv.js')) as { importCsvFile: (f: string, j: string, s?: string) => string };
          const result = mod.importCsvFile(csvPath, chatJid, message.sender_name);
          logger.info({ csvPath, result }, 'CSV import via chat completed');
          await channel.sendMessage(chatJid, result);
        } catch (err: any) {
          const errMsg = err?.stack || err?.message || String(err);
          logger.warn({ err: errMsg, csvPath }, 'CSV import via chat failed');
          await channel.sendMessage(chatJid, `CSV import failed: ${err?.message || String(err)}`);
        }
        continue;
      }

      if (message.content.startsWith(VOICE_NOTE_FILE_MARKER)) {
        await channel.sendMessage(
          chatJid,
          'Voice note received. Transcribing now...',
        );
        outputSentToUser = true;
        let transcript: string | undefined;
        try {
          transcript = await transcribeVoiceNoteWithAgent(
            group,
            chatJid,
            message,
          );
        } catch (err: any) {
          logger.error({ err: err?.message || err, chatJid }, 'Voice transcription threw');
        }
        if (!transcript) {
          const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
          const modelPath = process.env.WHISPER_MODEL_PATH || '';
          await channel.sendMessage(
            chatJid,
            hasOpenAi || modelPath
              ? 'I received the voice note but transcription failed or timed out. Please retry, or send text.'
              : 'I received the voice note, but local transcription is not configured yet (set WHISPER_MODEL_PATH or OPENAI_API_KEY).',
          );
          outputSentToUser = true;
          continue;
        }
        await channel.sendMessage(
          chatJid,
          `Transcribed voice note: "${transcript.slice(0, 180)}${
            transcript.length > 180 ? '…' : ''
          }"`,
        );
        outputSentToUser = true;
        messageForProcessing = { ...message, content: transcript };
      }

      const messageIntent = classifyCribclawIntent(messageForProcessing.content);
      const messageText = messageForProcessing.content;

      // ── Regex-first path (instant) ────────────────────────────────
      // Regex handles all known intents: log_event, query_data, edit_event,
      // config updates. Only truly ambiguous 'unknown' messages go to the LLM.
      let llmAction: LlmAction | undefined;
      let preExtractedEvents: ExtractedBabyEvent[] | undefined;

      if (messageIntent === 'log_event' || messageIntent === 'edit_event') {
        // Regex can handle these — extract events with the fast regex parser
        const tz = getTimezone(chatJid);
        preExtractedEvents = extractBabyEvents(messageText, messageForProcessing.timestamp, tz);
      } else if (messageIntent === 'unknown') {
        // Unknown intent: try LLM classification for ambiguous messages
        // (config updates, conversational, or events the regex didn't catch)
        if (CRIBCLAW_LLM_FIRST) {
          const profile = getBabyProfile(chatJid);
          llmAction = await classifyWithLlm(group, chatJid, messageForProcessing, profile);

          if (llmAction?.action === 'log_events') {
            preExtractedEvents = llmAction.events;
          } else if (llmAction?.action === 'mixed') {
            preExtractedEvents = llmAction.events;
          }
        }
      }
      // query_data and assistant_task intents are handled directly by
      // processMessage's regex query handler — no extraction needed.

      const result = cribclaw.processMessage(chatJid, messageForProcessing, {
        runtimeMode: CRIBCLAW_RUNTIME_MODE,
        allowAssistantTasks: CRIBCLAW_ALLOW_ASSISTANT_TASKS,
        ownerSenders: cribclawOwnerSenders,
      }, preExtractedEvents, llmAction);

      // If cribclaw returned an empty reply, collect for agent container
      // fallback so the message doesn't get silently dropped.
      if (!result.reply && !result.attachmentFilePath && !result.delegateToAgentPrompt) {
        unhandledMessages.push(messageForProcessing);
        continue;
      }

      if (result.reply) {
        await channel.sendMessage(chatJid, result.reply);
        outputSentToUser = true;
      }
      // Caregiver handoff: if a different caregiver just logged, send a summary
      if (result.loggedEventId) {
        const handoffNote = await maybeHandleCaregiverHandoff(
          chatJid,
          messageForProcessing.sender,
          messageForProcessing.sender_name,
        );
        if (handoffNote) {
          await channel.sendMessage(chatJid, handoffNote);
        }
      }
      if (result.attachmentFilePath && channel.sendFile) {
        await channel.sendFile(chatJid, result.attachmentFilePath, {
          caption: result.attachmentCaption,
          mimeType: result.attachmentMimeType,
        });
        outputSentToUser = true;
      }

      if (result.delegateToAgentPrompt) {
        const output = await runAgent(
          group,
          result.delegateToAgentPrompt,
          chatJid,
          async (agentOutput) => {
            if (!agentOutput.result) return;
            const raw =
              typeof agentOutput.result === 'string'
                ? agentOutput.result
                : JSON.stringify(agentOutput.result);
            const text = formatOutbound(raw);
            if (text) {
              await channel.sendMessage(chatJid, text);
              outputSentToUser = true;
            }
            if (agentOutput.status === 'error') {
              hadError = true;
            }
          },
        );

        if (output === 'error') {
          hadError = true;
        }
      }
    } catch (err) {
      logger.error({ err, chatJid }, 'CribClaw message processing error');
      hadError = true;
      break;
    }
  }

  // Agent container fallback: route unhandled messages to the NanoClaw warm
  // container for conversational responses with persistent session memory.
  // Uses runAgent() which registers the process for IPC piping — subsequent
  // messages arriving while the container is alive get piped directly to it,
  // enabling true back-and-forth conversation. Idle timer shuts it down after
  // IDLE_TIMEOUT of no activity.
  if (unhandledMessages.length > 0) {
    let agentReplied = false;
    try {
      const prompt = formatMessages(unhandledMessages);

      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logger.debug({ group: group.name }, 'CribClaw agent idle timeout, closing container');
          queue.closeStdin(chatJid);
        }, IDLE_TIMEOUT);
      };

      const output = await runAgent(group, prompt, chatJid, async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = formatOutbound(raw);
          if (text) {
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
            agentReplied = true;
          }
          resetIdleTimer();
        }
        if (result.status === 'error') {
          hadError = true;
        }
      });

      if (idleTimer) clearTimeout(idleTimer);

      if (output === 'error') {
        hadError = true;
      }
    } catch (err) {
      logger.error({ err, chatJid }, 'CribClaw agent fallback error');
      hadError = true;
    }

    // Safety net: if the agent container didn't produce any reply, send a
    // helpful fallback so the user isn't left hanging.
    if (!agentReplied && !outputSentToUser) {
      try {
        await channel.sendMessage(
          chatJid,
          "I'm here! I can track feeds, diapers, sleep, and more. Try \"fed 4oz\" or \"diaper wet\", or ask me anything!",
        );
        outputSentToUser = true;
      } catch {
        // Last resort — nothing we can do
      }
    }
  }

  return { hadError, outputSentToUser };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const isCribclawFamilyGroup =
    CRIBCLAW_ENABLED && group.folder === CRIBCLAW_FAMILY_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  // except CribClaw family group, which is message-first.
  if (!isCribclawFamilyGroup && !isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      mode: isCribclawFamilyGroup ? 'cribclaw-family' : 'agent',
    },
    'Processing messages',
  );

  if (isCribclawFamilyGroup) {
    await channel.setTyping?.(chatJid, true);
    const { hadError, outputSentToUser } = await processCribclawMessages(
      chatJid,
      group,
      channel,
      missedMessages,
    );
    await channel.setTyping?.(chatJid, false);

    if (hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'CribClaw error after output was sent, skipping cursor rollback',
        );
        return true;
      }
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name },
        'CribClaw processing error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  }

  const prompt = formatMessages(missedMessages);

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const nowMs = Date.now();
      if (CRIBCLAW_FEED_REMINDERS_ENABLED) {
        if (nowMs - lastFeedReminderCheckAt >= 60000) {
          await maybeSendFeedReminders(new Date(nowMs));
          lastFeedReminderCheckAt = nowMs;
        }
      }
      if (nowMs - lastCustomReminderCheckAt >= 60000) {
        await maybeSendCustomReminders(new Date(nowMs));
        lastCustomReminderCheckAt = nowMs;
      }
      if (CRIBCLAW_DAILY_SUMMARY_ENABLED) {
        if (nowMs - lastDailySummaryCheckAt >= 60000) {
          await maybeSendDailySummary(new Date(nowMs));
          lastDailySummaryCheckAt = nowMs;
        }
      }
      if (CRIBCLAW_AUTO_ESCALATION_MINUTES > 0) {
        if (nowMs - lastAutoEscalationCheckAt >= 60000) {
          await maybeCheckAutoEscalation(new Date(nowMs));
          lastAutoEscalationCheckAt = nowMs;
        }
      }
      // Check for open sleep sessions that may need a nudge (every 5 min)
      if (nowMs - lastSleepAutoCloseCheckAt >= 300000) {
        await maybePromptOpenSleepSessions(new Date(nowMs));
        lastSleepAutoCloseCheckAt = nowMs;
      }
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const isCribclawFamilyGroup =
            CRIBCLAW_ENABLED && group.folder === CRIBCLAW_FAMILY_FOLDER;
          const needsTrigger =
            !isCribclawFamilyGroup && !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // CribClaw family groups: baby events are always handled inline via
          // the fast regex pipeline (even while a warm container is running).
          // Non-baby messages get piped to the warm container for conversation,
          // or enqueued for CribClaw processing if no container is active.
          if (isCribclawFamilyGroup) {
            const containerIsActive = queue.isActive(chatJid);
            const conversationalMessages: NewMessage[] = [];

            for (const msg of groupMessages) {
              // CSV imports and voice notes must always go through the normal
              // processCribclawMessages queue path — never pipe to warm container.
              if (msg.content.startsWith(CSV_IMPORT_FILE_MARKER) || msg.content.startsWith(VOICE_NOTE_FILE_MARKER)) {
                queue.enqueueMessageCheck(chatJid);
                continue;
              }

              const intent = classifyCribclawIntent(msg.content);
              const isBabyEvent =
                intent === 'log_event' ||
                intent === 'edit_event' ||
                intent === 'query_data' ||
                isUnambiguousEvent(msg.content);

              if (isBabyEvent && containerIsActive) {
                // Handle baby events inline via CribClaw pipeline — fast path
                // even while a warm conversation container is running.
                try {
                  let preExtracted: ExtractedBabyEvent[] | undefined;
                  if (intent === 'log_event' || intent === 'edit_event') {
                    const tz = getTimezone(chatJid);
                    preExtracted = extractBabyEvents(msg.content, msg.timestamp, tz);
                  }
                  const result = cribclaw.processMessage(chatJid, msg, {
                    runtimeMode: CRIBCLAW_RUNTIME_MODE,
                    allowAssistantTasks: CRIBCLAW_ALLOW_ASSISTANT_TASKS,
                    ownerSenders: cribclawOwnerSenders,
                  }, preExtracted);
                  if (result.reply) {
                    await channel.sendMessage(chatJid, result.reply);
                  }
                  if (result.attachmentFilePath && channel.sendFile) {
                    await channel.sendFile(chatJid, result.attachmentFilePath, {
                      caption: result.attachmentCaption,
                      mimeType: result.attachmentMimeType,
                    });
                  }
                  // Advance cursor past this message
                  lastAgentTimestamp[chatJid] = msg.timestamp;
                  saveState();
                } catch (err) {
                  logger.error({ err, chatJid }, 'CribClaw inline baby event error');
                }
              } else {
                conversationalMessages.push(msg);
              }
            }

            // Non-baby messages: pipe to warm container or enqueue
            if (conversationalMessages.length > 0) {
              if (containerIsActive) {
                const formatted = formatMessages(conversationalMessages);
                if (queue.sendMessage(chatJid, formatted)) {
                  logger.debug(
                    { chatJid, count: conversationalMessages.length },
                    'Piped CribClaw conversational messages to warm container',
                  );
                  lastAgentTimestamp[chatJid] =
                    conversationalMessages[conversationalMessages.length - 1].timestamp;
                  saveState();
                  channel.setTyping?.(chatJid, true);
                } else {
                  queue.enqueueMessageCheck(chatJid);
                }
              } else {
                queue.enqueueMessageCheck(chatJid);
              }
            }
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel.setTyping?.(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function maybeSendFeedReminders(now: Date): Promise<void> {
  if (!CRIBCLAW_ENABLED || CRIBCLAW_FEED_REMINDER_MINUTES.length === 0) {
    return;
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.folder !== CRIBCLAW_FAMILY_FOLDER) {
      continue;
    }

    const lastFeed = getLastBabyEvent(chatJid, ['feed']);
    if (!lastFeed) {
      continue;
    }

    const minutesSinceFeed = Math.floor(
      (now.getTime() - Date.parse(lastFeed.occurred_at)) / 60000,
    );
    if (!Number.isFinite(minutesSinceFeed) || minutesSinceFeed < 0) {
      continue;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) {
      continue;
    }

    for (const threshold of CRIBCLAW_FEED_REMINDER_MINUTES) {
      if (minutesSinceFeed < threshold) {
        continue;
      }

      const stateKey = `cribclaw:feed-reminder:${chatJid}:${threshold}`;
      const sentForFeedAt = getRouterState(stateKey);
      if (sentForFeedAt === lastFeed.occurred_at) {
        continue;
      }

      await channel.sendMessage(
        chatJid,
        [
          `Feed reminder: ${threshold / 60} hour${threshold / 60 === 1 ? '' : 's'} since last feed.`,
          `Last feed was at ${new Date(lastFeed.occurred_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}.`,
        ].join(' '),
      );
      setRouterState(stateKey, lastFeed.occurred_at);
    }
  }
}

async function maybeSendCustomReminders(now: Date): Promise<void> {
  const due = getDueCribclawReminders(now.toISOString());
  if (due.length === 0) return;

  for (const reminder of due) {
    const group = registeredGroups[reminder.chat_jid];
    if (!group) continue;

    const channel = findChannel(channels, reminder.chat_jid);
    if (!channel) continue;

    try {
      const displayText = reminder.action_text.startsWith('[AUTO_AFTER_FEED] ')
        ? reminder.action_text.slice('[AUTO_AFTER_FEED] '.length)
        : reminder.action_text;
      await channel.sendMessage(
        reminder.chat_jid,
        `Reminder: ${displayText}`,
      );
      if (reminder.interval_minutes && reminder.interval_minutes > 0) {
        const next = new Date(
          now.getTime() + reminder.interval_minutes * 60000,
        ).toISOString();
        rescheduleCribclawReminder(reminder.id, now.toISOString(), next);
      } else {
        completeCribclawReminder(reminder.id, now.toISOString());
      }
    } catch (err) {
      logger.warn(
        { err, reminderId: reminder.id, chatJid: reminder.chat_jid },
        'Failed to send custom reminder',
      );
    }
  }
}

async function maybeSendDailySummary(now: Date): Promise<void> {
  if (!CRIBCLAW_ENABLED || !CRIBCLAW_DAILY_SUMMARY_ENABLED) return;

  const currentHour = now.getHours();
  if (currentHour !== CRIBCLAW_DAILY_SUMMARY_HOUR) return;

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.folder !== CRIBCLAW_FAMILY_FOLDER) continue;

    const stateKey = `cribclaw:last-daily-summary:${chatJid}`;
    const lastSentDate = getRouterState(stateKey);
    const todayDate = now.toISOString().slice(0, 10);

    if (lastSentDate === todayDate) continue;

    const channel = findChannel(channels, chatJid);
    if (!channel) continue;

    const summary = getBabyDailySummary(chatJid, now.toISOString());
    const lines: string[] = [
      `Daily Summary for ${todayDate}:`,
      `Feeds: ${summary.feeds}`,
      `Diapers: ${summary.diapers}`,
      `Sleep starts: ${summary.sleepStarts}, ends: ${summary.sleepEnds}`,
    ];

    if (summary.pumps > 0) lines.push(`Pumps: ${summary.pumps}`);
    if (summary.tummyTimes > 0) lines.push(`Tummy time sessions: ${summary.tummyTimes}`);
    if (summary.solids > 0) lines.push(`Solids: ${summary.solids}`);
    if (summary.growths > 0) lines.push(`Growth measurements: ${summary.growths}`);
    if (summary.baths > 0) lines.push(`Baths: ${summary.baths}`);
    if (summary.notes > 0) lines.push(`Notes/milestones: ${summary.notes}`);

    // Pattern alerts: compare this week vs last week for significant drops
    if (CRIBCLAW_PATTERN_ALERTS_ENABLED) {
      try {
        const comparison = getWeekComparison(chatJid, now.toISOString());
        const alerts: string[] = [];

        if (
          comparison.lastWeek.feeds > 0 &&
          comparison.thisWeek.feeds < comparison.lastWeek.feeds * 0.75
        ) {
          const dropPct = Math.round(
            (1 - comparison.thisWeek.feeds / comparison.lastWeek.feeds) * 100,
          );
          alerts.push(`Feeds down ${dropPct}% vs last week (${comparison.thisWeek.feeds} vs ${comparison.lastWeek.feeds})`);
        }

        if (
          comparison.lastWeek.diapers > 0 &&
          comparison.thisWeek.diapers < comparison.lastWeek.diapers * 0.75
        ) {
          const dropPct = Math.round(
            (1 - comparison.thisWeek.diapers / comparison.lastWeek.diapers) * 100,
          );
          alerts.push(`Diapers down ${dropPct}% vs last week (${comparison.thisWeek.diapers} vs ${comparison.lastWeek.diapers})`);
        }

        if (
          comparison.lastWeek.totalSleepMinutes > 0 &&
          comparison.thisWeek.totalSleepMinutes < comparison.lastWeek.totalSleepMinutes * 0.70
        ) {
          const dropPct = Math.round(
            (1 - comparison.thisWeek.totalSleepMinutes / comparison.lastWeek.totalSleepMinutes) * 100,
          );
          alerts.push(`Sleep down ${dropPct}% vs last week`);
        }

        if (alerts.length > 0) {
          lines.push('');
          lines.push('Pattern alerts:');
          for (const alert of alerts) {
            lines.push(`  - ${alert}`);
          }
        }
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to compute pattern alerts');
      }
    }

    try {
      await channel.sendMessage(chatJid, lines.join('\n'));
      setRouterState(stateKey, todayDate);
    } catch (err) {
      logger.warn({ err, chatJid }, 'Failed to send daily summary');
    }
  }
}

async function maybeCheckAutoEscalation(now: Date): Promise<void> {
  if (!CRIBCLAW_ENABLED || CRIBCLAW_AUTO_ESCALATION_MINUTES <= 0) return;

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.folder !== CRIBCLAW_FAMILY_FOLDER) continue;

    const lastFeed = getLastBabyEvent(chatJid, ['feed']);
    if (!lastFeed) continue;

    const minutesSinceFeed = Math.floor(
      (now.getTime() - Date.parse(lastFeed.occurred_at)) / 60000,
    );
    if (
      !Number.isFinite(minutesSinceFeed) ||
      minutesSinceFeed < CRIBCLAW_AUTO_ESCALATION_MINUTES
    ) {
      continue;
    }

    const stateKey = `cribclaw:auto-escalation:${chatJid}`;
    const sentForFeedAt = getRouterState(stateKey);
    if (sentForFeedAt === lastFeed.occurred_at) continue;

    const channel = findChannel(channels, chatJid);
    if (!channel) continue;

    try {
      const hours = Math.floor(minutesSinceFeed / 60);
      const mins = minutesSinceFeed % 60;
      const elapsed = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      await channel.sendMessage(
        chatJid,
        [
          `No feed logged for ${elapsed}.`,
          `Last feed was at ${new Date(lastFeed.occurred_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })} by ${lastFeed.sender_name}.`,
        ].join(' '),
      );
      setRouterState(stateKey, lastFeed.occurred_at);
    } catch (err) {
      logger.warn({ err, chatJid }, 'Failed to send auto-escalation alert');
    }
  }
}

const SLEEP_AUTO_CLOSE_HOURS = 6;

async function maybePromptOpenSleepSessions(now: Date): Promise<void> {
  if (!CRIBCLAW_ENABLED) return;

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.folder !== CRIBCLAW_FAMILY_FOLDER) continue;

    const openSessions = getOpenBabySleepSessions(chatJid);
    if (openSessions.length === 0) continue;

    for (const session of openSessions) {
      const startedMs = Date.parse(session.started_at);
      if (!Number.isFinite(startedMs)) continue;

      const hoursOpen = (now.getTime() - startedMs) / (60 * 60 * 1000);
      if (hoursOpen < SLEEP_AUTO_CLOSE_HOURS) continue;

      const stateKey = `cribclaw:sleep-prompt:${chatJid}:${session.id}`;
      if (getRouterState(stateKey)) continue;

      const channel = findChannel(channels, chatJid);
      if (!channel) continue;

      try {
        const hrs = Math.floor(hoursOpen);
        const mins = Math.round((hoursOpen - hrs) * 60);
        const elapsed = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        const startTime = new Date(startedMs).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        await channel.sendMessage(
          chatJid,
          `Nap started at ${startTime} (${elapsed} ago). Is baby still sleeping? Say "woke up" to end the session.`,
        );
        setRouterState(stateKey, now.toISOString());
      } catch (err) {
        logger.warn({ err, chatJid, sessionId: session.id }, 'Failed to send sleep auto-close prompt');
      }
    }
  }
}

async function maybeHandleCaregiverHandoff(chatJid: string, currentSender: string, currentSenderName: string): Promise<string | undefined> {
  if (!CRIBCLAW_ENABLED) return undefined;

  const stateKey = `cribclaw:last-active-sender:${chatJid}`;
  const lastSender = getRouterState(stateKey);

  if (!lastSender || lastSender === currentSender) {
    setRouterState(stateKey, currentSender);
    return undefined;
  }

  // Different caregiver just logged something — send a quick handoff summary
  setRouterState(stateKey, currentSender);

  const lastEvent = getLastBabyEventAny(chatJid);
  if (!lastEvent) return undefined;

  const summary = getBabyDailySummary(chatJid, new Date().toISOString());
  const parts: string[] = [];

  if (summary.feeds > 0) parts.push(`${summary.feeds} feed${summary.feeds > 1 ? 's' : ''}`);
  if (summary.diapers > 0) parts.push(`${summary.diapers} diaper${summary.diapers > 1 ? 's' : ''}`);
  if (summary.sleepStarts > 0) parts.push(`${summary.sleepStarts} nap${summary.sleepStarts > 1 ? 's' : ''}`);

  if (parts.length === 0) return undefined;

  return `Handoff note: today so far — ${parts.join(', ')}. Last event: ${lastEvent.event_type.replace('_', ' ')} at ${new Date(lastEvent.occurred_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })} by ${lastEvent.sender_name}.`;
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  if (CRIBCLAW_ENABLED) {
    printCribclawBanner();
  }

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  exportAllBabyCsvSnapshots();
  logger.info('CSV snapshots initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect Telegram channel
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required. Set it in .env.',
    );
  }
  const telegram = new TelegramChannel({
    ...channelOpts,
    token: TELEGRAM_BOT_TOKEN,
    onAutoRegister: (chatId, chatName) => {
      logger.info({ chatId, chatName }, 'Auto-registering first chat');
      registerGroup(chatId, {
        name: chatName || 'CribClaw',
        folder: CRIBCLAW_ENABLED ? CRIBCLAW_FAMILY_FOLDER : 'main',
        trigger: '@CribClaw',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });

      // Set default timezone from system
      if (TIMEZONE) {
        setRouterState(`cribclaw:timezone:${chatId}`, TIMEZONE);
        logger.info({ chatId, timezone: TIMEZONE }, 'Set default timezone from system');
      }

      // Send onboarding hint (deferred so channel is fully wired)
      setTimeout(async () => {
        try {
          const channel = channels.find(c => c.ownsJid(chatId));
          if (channel) {
            const tzNote = TIMEZONE
              ? `Your timezone is set to ${TIMEZONE} (from system). Say "timezone is ___" to change it.`
              : 'Say "timezone is America/New_York" (or your timezone) so I log times correctly.';
            await channel.sendMessage(
              chatId,
              `Welcome to CribClaw! I'm ready to track your baby's feeds, diapers, sleep, and more.\n\n${tzNote}\n\nSay "show settings" to see your profile, or just start logging!`,
            );
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to send onboarding message');
        }
      }, 2000);
    },
  });
  channels.push(telegram);
  await telegram.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async () => {},
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
