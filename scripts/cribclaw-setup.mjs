#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const setupLogPath = path.join(projectRoot, 'logs', 'setup.log');

function logSetup(step, message) {
  mkdirSync(path.dirname(setupLogPath), { recursive: true });
  appendFileSync(
    setupLogPath,
    `[${new Date().toISOString()}] [${step}] ${message}\n`,
  );
}

function parseEnv(content) {
  const map = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    map.set(key, value);
  }
  return map;
}

function upsertEnv(content, key, value) {
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1].trim() !== '') {
      next.push('');
    }
    next.push(`${key}=${value}`);
  }
  return next.join('\n');
}

function runStep(label, relativeScriptPath, args = []) {
  const scriptPath = path.join(projectRoot, relativeScriptPath);
  console.log(`\n== ${label} ==`);
  const result = spawnSync(scriptPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function ensureRegisteredGroupsTable() {
  const dbDir = path.join(projectRoot, 'store');
  const dbPath = path.join(dbDir, 'messages.db');
  mkdirSync(dbDir, { recursive: true });

  const createSql = `
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `;

  const result = spawnSync('sqlite3', [dbPath, createSql], {
    cwd: projectRoot,
    stdio: 'pipe',
    shell: false,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'unknown sqlite3 error';
    throw new Error(`Failed to initialize setup database schema: ${stderr}`);
  }
  logSetup('telegram-setup', 'Ensured registered_groups table exists');
}

function commandAvailable(cmd, args = ['--version']) {
  const result = spawnSync(cmd, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function printDockerInstallHelp() {
  console.log('\nDocker is required and is not available yet.\n');
  console.log('Run these commands, then run setup again:\n');
  console.log('1) Install Docker Desktop (macOS):');
  console.log('   brew install --cask docker');
  console.log('\n2) If you see a cli-plugins permission error, run:');
  console.log('   sudo mkdir -p /usr/local/cli-plugins && sudo chown $(whoami) /usr/local/cli-plugins');
  console.log('\n3) Start Docker Desktop:');
  console.log('   open -a Docker');
  console.log('\n4) Wait until Docker is running, then verify:');
  console.log('   docker info');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDockerReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (commandAvailable('docker', ['info'])) return true;
    await sleep(2000);
  }
  return false;
}

async function askInput(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function redactToken(token) {
  if (!token) return '<missing>';
  if (token.length < 10) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function ensureTelegramToken(existingValue) {
  const existing = (existingValue || '').trim();
  if (existing) return existing;

  if (!process.stdin.isTTY) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required. Set it in .env or run setup interactively.',
    );
  }

  console.log('\nTelegram bot token is required.');
  console.log('Create a bot with @BotFather, then paste token here.');
  logSetup('telegram-setup', 'Prompting for TELEGRAM_BOT_TOKEN');
  const token = await askInput('Enter TELEGRAM_BOT_TOKEN: ');
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN.');
  return token;
}

async function telegramApi(token, method, payload = {}, signal) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail = data?.description || raw || 'Unknown error';
    throw new Error(`Telegram ${method} HTTP ${res.status}: ${detail}`);
  }

  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

function chatDisplayName(chat) {
  return (
    chat.title ||
    chat.username ||
    [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
    `Chat ${chat.id}`
  );
}

function chatSortValue(chat) {
  if (chat.type === 'private') return 0;
  if (chat.type === 'group' || chat.type === 'supergroup') return 1;
  return 2;
}

async function collectTelegramChats(token, seconds = 20) {
  logSetup('telegram-discovery', `Starting chat polling window (${seconds}s)`);
  const byId = new Map();
  let offset = 0;
  let sawFirstChatAt = 0;
  let lastUpdateAt = 0;
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    const remainingSec = Math.max(
      1,
      Math.min(8, Math.floor((deadline - Date.now()) / 1000)),
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (remainingSec + 3) * 1000);
    try {
      const updates = await telegramApi(
        token,
        'getUpdates',
        {
          offset,
          timeout: remainingSec,
          limit: 100,
          allowed_updates: ['message'],
        },
        controller.signal,
      );

      if (!Array.isArray(updates) || updates.length === 0) continue;

      for (const update of updates) {
        offset = Math.max(offset, (update.update_id || 0) + 1);
        const msg = update.message;
        if (!msg?.chat) continue;
        const chat = msg.chat;
        byId.set(chat.id, {
          id: chat.id,
          jid: `tg:${chat.id}`,
          type: chat.type,
          name: chatDisplayName(chat),
        });
        if (!sawFirstChatAt) {
          sawFirstChatAt = Date.now();
        }
        lastUpdateAt = Date.now();
      }
      if (updates.length > 0) {
        logSetup(
          'telegram-discovery',
          `Received ${updates.length} update(s), discovered chats=${byId.size}`,
        );
      }
    } catch (error) {
      const detail = error?.message || String(error);
      console.log(`Telegram update polling warning: ${detail}`);
      logSetup('telegram-discovery', `Polling warning: ${detail}`);
      await sleep(1200);
    } finally {
      clearTimeout(timeout);
    }

    // Early exit: once at least one chat is discovered and no new updates
    // arrive for a few seconds, stop polling to keep setup snappy.
    if (byId.size > 0) {
      const now = Date.now();
      const idleMs = now - (lastUpdateAt || sawFirstChatAt || now);
      const liveMs = now - (sawFirstChatAt || now);
      if (liveMs >= 3000 && idleMs >= 4000) {
        logSetup('telegram-discovery', 'Early-exit polling after stable chat discovery');
        break;
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    const typeDiff = chatSortValue(a) - chatSortValue(b);
    if (typeDiff !== 0) return typeDiff;
    return a.name.localeCompare(b.name);
  });
}

async function chooseChat(label, chats, allowSkip = false) {
  if (chats.length === 0) return null;

  if (!process.stdin.isTTY) {
    return chats[0];
  }

  console.log(`\n${label}`);
  chats.forEach((chat, index) => {
    const kind =
      chat.type === 'private'
        ? 'private'
        : chat.type === 'supergroup'
          ? 'group'
          : chat.type;
    console.log(`${index + 1}. ${chat.name} [${kind}] (${chat.jid})`);
  });

  const prompt = allowSkip
    ? '\nSelect number (or press Enter to skip): '
    : '\nSelect number (default 1): ';
  const answer = await askInput(prompt);
  if (!answer && !allowSkip) {
    return chats[0];
  }
  if (!answer && allowSkip) return null;

  const selected = Number(answer);
  if (!Number.isInteger(selected) || selected < 1 || selected > chats.length) {
    if (allowSkip) {
      console.log('Invalid selection, skipping.');
      return null;
    }
    throw new Error('Invalid selection.');
  }
  return chats[selected - 1];
}

async function discoverTelegramChats(token, botUsername) {
  console.log('\n== Telegram chat discovery ==');
  console.log(`Bot: @${botUsername || 'unknown'}`);
  console.log('Before continuing: in @BotFather run /setprivacy and disable privacy for this bot.');
  console.log('Now do this in Telegram:');
  console.log('1) Open a DM with your bot and send: /start');
  console.log('2) Optional: add bot to your caregivers group');
  console.log('3) Optional: in that group, send /cribclaw');
  logSetup(
    'telegram-discovery',
    'Waiting for user to send /start in DM (family group optional)',
  );

  if (process.stdin.isTTY) {
    console.log('Setup is paused here until you press Enter.');
    await askInput('\nPress Enter after sending those messages...');
  }

  const chats = await collectTelegramChats(token, 20);
  if (chats.length === 0) {
    logSetup('telegram-discovery', 'No chats discovered during polling window');
    throw new Error(
      'No Telegram chats discovered. Send /start to the bot in DM and /cribclaw in the family group, then re-run setup.',
    );
  }

  logSetup('telegram-discovery', `Discovered ${chats.length} chat(s)`);

  return chats;
}

async function main() {
  console.log('\nCribClaw quick setup (local, secure defaults)');
  console.log('This will set defaults, verify Telegram bot access, and register chats.');
  logSetup('telegram-setup', 'CribClaw setup started');

  const envPath = path.join(projectRoot, '.env');
  const envExamplePath = path.join(projectRoot, '.env.example');

  if (!existsSync(envPath)) {
    copyFileSync(envExamplePath, envPath);
    console.log('Created .env from .env.example');
  }

  let envContent = readFileSync(envPath, 'utf8');
  const envBefore = parseEnv(envContent);
  const token = await ensureTelegramToken(
    process.env.TELEGRAM_BOT_TOKEN || envBefore.get('TELEGRAM_BOT_TOKEN') || '',
  );

  envContent = upsertEnv(envContent, 'ASSISTANT_NAME', 'CribClaw');
  envContent = upsertEnv(envContent, 'ASSISTANT_HAS_OWN_NUMBER', 'true');
  envContent = upsertEnv(envContent, 'PRIMARY_CHANNEL', 'telegram');
  envContent = upsertEnv(envContent, 'TELEGRAM_BOT_TOKEN', token);
  envContent = upsertEnv(envContent, 'CRIBCLAW_ENABLED', 'true');
  envContent = upsertEnv(envContent, 'CRIBCLAW_FAMILY_FOLDER', 'family');
  envContent = upsertEnv(envContent, 'CRIBCLAW_RUNTIME_MODE', 'locked');
  envContent = upsertEnv(envContent, 'CRIBCLAW_ALLOW_ASSISTANT_TASKS', 'false');
  envContent = upsertEnv(envContent, 'CRIBCLAW_PARSER_FALLBACK', 'true');
  envContent = upsertEnv(envContent, 'CRIBCLAW_FEED_REMINDERS_ENABLED', 'true');
  envContent = upsertEnv(envContent, 'CRIBCLAW_FEED_REMINDER_MINUTES', '120,180');
  writeFileSync(envPath, envContent, 'utf8');
  console.log('Applied secure defaults to .env');
  console.log(`Telegram token: ${redactToken(token)}`);

  runStep('Environment check', '.claude/skills/setup/scripts/01-check-environment.sh');

  if (!commandAvailable('docker')) {
    printDockerInstallHelp();
    throw new Error('Docker is not installed yet.');
  }

  if (!commandAvailable('docker', ['info'])) {
    console.log('\nDocker is installed but not running yet.');
    if (process.platform === 'darwin') {
      console.log('Trying to start Docker Desktop for you...');
      spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore', shell: false });
    } else {
      console.log('Please start Docker daemon, then re-run setup.');
      throw new Error('Docker is not running yet.');
    }

    const ready = await waitForDockerReady();
    if (!ready) {
      console.log('\nDocker still is not ready.');
      console.log('Open Docker Desktop and wait until it says "Docker Desktop is running", then retry.');
      throw new Error('Docker is not running yet.');
    }
    console.log('Docker is running.');
  }

  runStep('Install dependencies', '.claude/skills/setup/scripts/02-install-deps.sh');
  runStep('Container setup (Docker)', '.claude/skills/setup/scripts/03-setup-container.sh', ['--runtime', 'docker']);
  runStep('Lock external mounts (secure)', '.claude/skills/setup/scripts/07-configure-mounts.sh', ['--empty']);

  console.log('\n== Telegram bot verification ==');
  logSetup('telegram-setup', 'Running Telegram getMe verification');
  let me;
  try {
    me = await telegramApi(token, 'getMe');
  } catch (error) {
    const detail = error?.message || String(error);
    logSetup('telegram-setup', `Telegram verification failed: ${detail}`);
    if (detail.includes('401')) {
      throw new Error(
        'Telegram token is invalid (401 Unauthorized). In @BotFather run /revoke then /token for your bot, update TELEGRAM_BOT_TOKEN, and re-run setup.',
      );
    }
    throw error;
  }
  console.log(`Connected to Telegram bot @${me.username || 'unknown'} (id ${me.id})`);
  logSetup('telegram-setup', `Connected bot @${me.username || 'unknown'} (${me.id})`);

  // Ensure polling-based bot mode is available.
  try {
    await telegramApi(token, 'deleteWebhook', { drop_pending_updates: false });
  } catch {
    // Best-effort only.
  }

  const chats = await discoverTelegramChats(token, me.username);
  const privateChats = chats.filter((c) => c.type === 'private');
  const groupChats = chats.filter(
    (c) => c.type === 'group' || c.type === 'supergroup',
  );

  const assistantName = parseEnv(readFileSync(envPath, 'utf8')).get('ASSISTANT_NAME') || 'CribClaw';
  const trigger = `@${assistantName}`;

  const mainCandidates = privateChats.length > 0 ? privateChats : chats;
  const mainChat = await chooseChat('Select your main control chat', mainCandidates, false);
  if (!mainChat) {
    throw new Error('Main control chat is required.');
  }

  ensureRegisteredGroupsTable();

  runStep('Register main control chat', '.claude/skills/setup/scripts/06-register-channel.sh', [
    '--jid',
    mainChat.jid,
    '--name',
    'main',
    '--trigger',
    trigger,
    '--folder',
    'main',
    '--no-trigger-required',
  ]);
  console.log(`Registered main chat: ${mainChat.name}`);

  const familyChat = await chooseChat(
    'Select your family caregivers group',
    groupChats,
    true,
  );
  if (familyChat) {
    runStep('Register family caregivers group', '.claude/skills/setup/scripts/06-register-channel.sh', [
      '--jid',
      familyChat.jid,
      '--name',
      'family',
      '--trigger',
      trigger,
      '--folder',
      'family',
      '--no-trigger-required',
    ]);
    console.log(`Registered family group: ${familyChat.name}`);
    logSetup('telegram-setup', `Registered family group ${familyChat.jid}`);
  } else {
    console.log('\nSkipped family group registration.');
    console.log('Using DM-only mode: main chat will also be your CribClaw family folder.');
    console.log('You can add a real family group later by re-running setup.');
    logSetup(
      'telegram-setup',
      'No family group selected; switching CRIBCLAW_FAMILY_FOLDER to main',
    );
    const envNow = readFileSync(envPath, 'utf8');
    const updated = upsertEnv(envNow, 'CRIBCLAW_FAMILY_FOLDER', 'main');
    writeFileSync(envPath, updated, 'utf8');
  }

  console.log('\nSetup complete. Start CribClaw with:');
  console.log('npm run dev');
  if (familyChat) {
    console.log('\nThen test in your family group:');
  } else {
    console.log('\nThen test in your main bot DM:');
  }
  console.log('fed 4oz at 8:15am');
  console.log('summary today');
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  console.error('Check logs/setup.log for details.');
  process.exit(1);
});
