#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
const DEFAULT_MODEL_PATH = path.join(PROJECT_ROOT, 'models', 'ggml-base.en.bin');

function ensureEnvFile() {
  if (fs.existsSync(ENV_PATH)) return;
  if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    return;
  }
  fs.writeFileSync(ENV_PATH, '', 'utf8');
}

function upsertEnvKey(filePath, key, value) {
  const exists = fs.existsSync(filePath);
  const lines = exists ? fs.readFileSync(filePath, 'utf8').split('\n') : [];
  let replaced = false;
  const next = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
    next.push(`${key}=${value}`);
  }
  fs.writeFileSync(filePath, `${next.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
}

function main() {
  if (!fs.existsSync(DEFAULT_MODEL_PATH)) {
    console.error(`Model file not found: ${DEFAULT_MODEL_PATH}`);
    console.error('Download it first, then re-run this command.');
    console.error('');
    console.error(
      `curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin -o ${DEFAULT_MODEL_PATH}`,
    );
    process.exit(1);
  }

  ensureEnvFile();
  upsertEnvKey(ENV_PATH, 'WHISPER_MODEL_PATH', DEFAULT_MODEL_PATH);

  console.log('Local STT enabled in .env');
  console.log(`WHISPER_MODEL_PATH=${DEFAULT_MODEL_PATH}`);
  console.log('');
  console.log('Next:');
  console.log('1) npm run cribclaw:check-stt');
  console.log('2) npm run dev');
}

main();
