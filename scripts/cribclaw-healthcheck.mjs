#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { readEnvFileSimple } from './lib/ops-utils.mjs';

const root = process.cwd();
const envPath = path.join(root, '.env');
const storeDir = path.join(root, 'store');
const dbPath = path.join(storeDir, 'messages.db');

function pass(name, detail) {
  console.log(`PASS: ${name}${detail ? ` - ${detail}` : ''}`);
}

function warn(name, detail) {
  console.log(`WARN: ${name}${detail ? ` - ${detail}` : ''}`);
}

function fail(name, detail) {
  console.log(`FAIL: ${name}${detail ? ` - ${detail}` : ''}`);
}

function checkDocker() {
  const res = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (res.status === 0) {
    pass('Container runtime', 'docker info ok');
    return true;
  }
  fail(
    'Container runtime',
    (res.stderr || res.stdout || 'docker info failed').trim().slice(0, 200),
  );
  return false;
}

function checkDb() {
  if (!fs.existsSync(dbPath)) {
    fail('SQLite DB', `${dbPath} not found`);
    return false;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name IN ('messages','registered_groups','baby_events')",
      )
      .get();
    db.close();
    if (Number(row?.count || 0) < 3) {
      fail('SQLite schema', 'required tables missing');
      return false;
    }
    pass('SQLite DB', dbPath);
    return true;
  } catch (error) {
    fail('SQLite DB', String(error).slice(0, 200));
    return false;
  }
}

function main() {
  console.log('CribClaw production healthcheck\n');
  const env = readEnvFileSimple(envPath);
  const problems = [];

  const nodeMajor = Number(process.versions.node.split('.')[0] || '0');
  if (nodeMajor >= 20) {
    pass('Node version', process.versions.node);
  } else {
    fail('Node version', `${process.versions.node} (need >=20)`);
    problems.push('node');
  }

  if (fs.existsSync(envPath)) {
    pass('.env', envPath);
  } else {
    fail('.env', 'missing');
    problems.push('env');
  }

  const primaryChannel = env.PRIMARY_CHANNEL || 'telegram';
  pass('PRIMARY_CHANNEL', primaryChannel);

  if (primaryChannel !== 'whatsapp') {
    const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
      fail('Telegram bot token', 'missing TELEGRAM_BOT_TOKEN');
      problems.push('telegram-token');
    } else {
      pass('Telegram bot token', `${token.slice(0, 6)}...${token.slice(-4)}`);
    }
  }

  if (!checkDocker()) {
    problems.push('docker');
  }
  if (!checkDb()) {
    problems.push('db');
  }

  const whisperModel = env.WHISPER_MODEL_PATH || process.env.WHISPER_MODEL_PATH || '';
  if (whisperModel) {
    if (fs.existsSync(whisperModel)) {
      pass('Local STT model', whisperModel);
    } else {
      warn('Local STT model', `configured but not found: ${whisperModel}`);
    }
  } else {
    warn('Local STT model', 'not configured (voice notes may rely on fallbacks)');
  }

  if (problems.length > 0) {
    console.log('\nRESULT: NOT READY');
    console.log(`Blocking issues: ${problems.join(', ')}`);
    process.exit(1);
  }

  console.log('\nRESULT: READY');
}

main();
