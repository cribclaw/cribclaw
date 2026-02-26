#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function which(bin) {
  const probe = spawnSync('which', [bin], { encoding: 'utf8' });
  if (probe.status === 0) {
    const out = probe.stdout.trim();
    return out || null;
  }
  return null;
}

function checkBinary(bin, extraArgs = ['--help']) {
  const path = which(bin);
  if (!path) return { ok: false, path: null, runnable: false };
  const run = spawnSync(bin, extraArgs, { encoding: 'utf8' });
  const runnable = run.status === 0 || run.status === 1;
  return { ok: true, path, runnable };
}

function printStatus(label, ok, detail = '') {
  const icon = ok ? 'PASS' : 'FAIL';
  const suffix = detail ? ` - ${detail}` : '';
  console.log(`${icon}: ${label}${suffix}`);
}

function main() {
  const envFile = parseEnvFile(ENV_PATH);
  const effectiveEnv = { ...envFile, ...process.env };

  console.log('CribClaw STT diagnostics');
  console.log('');

  const checks = [];

  const whisperCli = checkBinary('whisper-cli', ['--help']);
  checks.push({
    name: 'whisper-cli in PATH',
    ok: whisperCli.ok && whisperCli.runnable,
    detail: whisperCli.path || 'not found',
  });

  const whisperMain = checkBinary('main', ['--help']);
  checks.push({
    name: 'main (whisper.cpp) in PATH',
    ok: whisperMain.ok && whisperMain.runnable,
    detail: whisperMain.path || 'not found',
  });

  const whisperPy = checkBinary('whisper', ['--help']);
  checks.push({
    name: 'python whisper CLI in PATH',
    ok: whisperPy.ok && whisperPy.runnable,
    detail: whisperPy.path || 'not found',
  });

  const ffmpeg = checkBinary('ffmpeg', ['-version']);
  checks.push({
    name: 'ffmpeg in PATH (needed for .oga conversion)',
    ok: ffmpeg.ok && ffmpeg.runnable,
    detail: ffmpeg.path || 'not found',
  });

  const defaultModelPath = path.join(PROJECT_ROOT, 'models', 'ggml-base.en.bin');
  const modelPath = effectiveEnv.WHISPER_MODEL_PATH || defaultModelPath;
  const hasModelPath = Boolean(modelPath);
  const modelExists = hasModelPath && fs.existsSync(modelPath);
  checks.push({
    name: 'WHISPER_MODEL_PATH configured',
    ok: Boolean(effectiveEnv.WHISPER_MODEL_PATH) || modelExists,
    detail: effectiveEnv.WHISPER_MODEL_PATH
      ? effectiveEnv.WHISPER_MODEL_PATH
      : modelExists
        ? `${defaultModelPath} (auto-detected)`
        : 'not set',
  });
  checks.push({
    name: 'WHISPER model file exists',
    ok: modelExists,
    detail: hasModelPath ? (modelExists ? 'found' : 'missing file') : 'skipped',
  });

  const hasOpenAiKey = Boolean(effectiveEnv.OPENAI_API_KEY);
  checks.push({
    name: 'OPENAI_API_KEY (optional fallback)',
    ok: hasOpenAiKey,
    detail: hasOpenAiKey ? 'set' : 'not set',
  });

  for (const c of checks) {
    printStatus(c.name, c.ok, c.detail);
  }

  console.log('');
  const localEngineAvailable =
    (whisperCli.ok && whisperCli.runnable) ||
    (whisperMain.ok && whisperMain.runnable) ||
    (whisperPy.ok && whisperPy.runnable);

  const localPass = localEngineAvailable && (modelExists || whisperPy.ok) && (ffmpeg.ok && ffmpeg.runnable);
  if (localPass) {
    console.log('RESULT: LOCAL STT READY');
    process.exit(0);
  }

  if (hasOpenAiKey) {
    console.log('RESULT: LOCAL STT NOT READY, API FALLBACK AVAILABLE');
    process.exit(0);
  }

  console.log('RESULT: STT NOT READY');
  console.log('');
  console.log('Fix:');
  console.log('1) Install whisper.cpp: brew install whisper-cpp');
  console.log('2) Set WHISPER_MODEL_PATH to a local ggml model file');
  console.log('3) Re-run: npm run cribclaw:check-stt');
  process.exit(1);
}

main();
