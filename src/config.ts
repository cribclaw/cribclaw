import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'PRIMARY_CHANNEL',
  'TELEGRAM_BOT_TOKEN',
  'CRIBCLAW_ENABLED',
  'CRIBCLAW_FAMILY_FOLDER',
  'CRIBCLAW_RUNTIME_MODE',
  'CRIBCLAW_ALLOW_ASSISTANT_TASKS',
  'CRIBCLAW_OWNER_SENDERS',
  'CRIBCLAW_FEED_REMINDERS_ENABLED',
  'CRIBCLAW_FEED_REMINDER_MINUTES',
  'CRIBCLAW_LLM_FIRST',
  'CRIBCLAW_PARSER_FALLBACK',
  'CRIBCLAW_DAILY_SUMMARY_ENABLED',
  'CRIBCLAW_DAILY_SUMMARY_HOUR',
  'CRIBCLAW_PATTERN_ALERTS_ENABLED',
  'CRIBCLAW_ADAPTIVE_REMINDERS',
  'CRIBCLAW_AUTO_ESCALATION_MINUTES',
  'CRIBCLAW_BABY_DOB',
  'CRIBCLAW_BABY_NAME',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const PRIMARY_CHANNEL = 'telegram';
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const CRIBCLAW_ENABLED =
  (process.env.CRIBCLAW_ENABLED || envConfig.CRIBCLAW_ENABLED || 'true') ===
  'true';
export const CRIBCLAW_FAMILY_FOLDER =
  process.env.CRIBCLAW_FAMILY_FOLDER ||
  envConfig.CRIBCLAW_FAMILY_FOLDER ||
  'family';
export const CRIBCLAW_RUNTIME_MODE =
  (process.env.CRIBCLAW_RUNTIME_MODE ||
    envConfig.CRIBCLAW_RUNTIME_MODE ||
    'locked') === 'builder'
    ? 'builder'
    : 'locked';
export const CRIBCLAW_ALLOW_ASSISTANT_TASKS =
  (process.env.CRIBCLAW_ALLOW_ASSISTANT_TASKS ||
    envConfig.CRIBCLAW_ALLOW_ASSISTANT_TASKS ||
    'false') === 'true';
export const CRIBCLAW_OWNER_SENDERS = (
  process.env.CRIBCLAW_OWNER_SENDERS ||
  envConfig.CRIBCLAW_OWNER_SENDERS ||
  ''
)
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean);

export const CRIBCLAW_FEED_REMINDERS_ENABLED =
  (process.env.CRIBCLAW_FEED_REMINDERS_ENABLED ||
    envConfig.CRIBCLAW_FEED_REMINDERS_ENABLED ||
    'false') === 'true';

export const CRIBCLAW_FEED_REMINDER_MINUTES = [
  ...new Set(
    (
      process.env.CRIBCLAW_FEED_REMINDER_MINUTES ||
      envConfig.CRIBCLAW_FEED_REMINDER_MINUTES ||
      '120,180'
    )
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
  ),
].sort((a, b) => a - b);

export const CRIBCLAW_LLM_FIRST =
  (process.env.CRIBCLAW_LLM_FIRST ||
    envConfig.CRIBCLAW_LLM_FIRST ||
    'true') === 'true';

export const CRIBCLAW_PARSER_FALLBACK =
  (process.env.CRIBCLAW_PARSER_FALLBACK ||
    envConfig.CRIBCLAW_PARSER_FALLBACK ||
    'true') === 'true';

export const CRIBCLAW_DAILY_SUMMARY_ENABLED =
  (process.env.CRIBCLAW_DAILY_SUMMARY_ENABLED ||
    envConfig.CRIBCLAW_DAILY_SUMMARY_ENABLED ||
    'true') === 'true';

// Hour (0-23) at which to send the daily summary. Default: 20 (8 PM).
export const CRIBCLAW_DAILY_SUMMARY_HOUR = Math.max(
  0,
  Math.min(
    23,
    parseInt(
      process.env.CRIBCLAW_DAILY_SUMMARY_HOUR ||
        envConfig.CRIBCLAW_DAILY_SUMMARY_HOUR ||
        '20',
      10,
    ) || 20,
  ),
);

export const CRIBCLAW_PATTERN_ALERTS_ENABLED =
  (process.env.CRIBCLAW_PATTERN_ALERTS_ENABLED ||
    envConfig.CRIBCLAW_PATTERN_ALERTS_ENABLED ||
    'true') === 'true';

export const CRIBCLAW_ADAPTIVE_REMINDERS =
  (process.env.CRIBCLAW_ADAPTIVE_REMINDERS ||
    envConfig.CRIBCLAW_ADAPTIVE_REMINDERS ||
    'true') === 'true';

// Minutes without a feed before auto-escalation alert (0 = disabled). Default: 0 (disabled).
export const CRIBCLAW_AUTO_ESCALATION_MINUTES = Math.max(
  0,
  parseInt(
    process.env.CRIBCLAW_AUTO_ESCALATION_MINUTES ||
      envConfig.CRIBCLAW_AUTO_ESCALATION_MINUTES ||
      '0',
    10,
  ) || 0,
);

// Baby date of birth (ISO date string, e.g. "2025-06-15") — used for age-based features.
export const CRIBCLAW_BABY_DOB =
  process.env.CRIBCLAW_BABY_DOB || envConfig.CRIBCLAW_BABY_DOB || '';

// Baby's name (displayed in visual summaries and reports).
export const CRIBCLAW_BABY_NAME =
  process.env.CRIBCLAW_BABY_NAME || envConfig.CRIBCLAW_BABY_NAME || '';
