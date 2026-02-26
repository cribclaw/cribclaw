import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { readEnvFile } from './env.js';

const sttEnv = readEnvFile([
  'WHISPER_MODEL_PATH',
  'CRIBCLAW_STT_MODEL',
  'OPENAI_API_KEY',
]);

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH || sttEnv.WHISPER_MODEL_PATH || '';
const CRIBCLAW_STT_MODEL =
  process.env.CRIBCLAW_STT_MODEL || sttEnv.CRIBCLAW_STT_MODEL || 'whisper-1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || sttEnv.OPENAI_API_KEY || '';

function convertToWav(inputPath: string): string | undefined {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  const convert = spawnSync(
    'ffmpeg',
    ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', wavPath],
    { encoding: 'utf8' },
  );
  if (convert.status !== 0 || !fs.existsSync(wavPath)) {
    return undefined;
  }
  return wavPath;
}

function runLocalWhisperCli(audioPath: string): string | undefined {
  const candidates: Array<{
    bin: string;
    args: (outPrefix: string) => string[];
    transcriptPath: (outPrefix: string) => string;
    requiresModelPath?: boolean;
  }> = [
    {
      // whisper.cpp CLI (common homebrew name)
      bin: 'whisper-cli',
      args: (outPrefix) => [
        '-ng',
        '-nfa',
        '-m',
        WHISPER_MODEL_PATH,
        '-f',
        audioPath,
        '-of',
        outPrefix,
        '-otxt',
      ],
      transcriptPath: (outPrefix) => `${outPrefix}.txt`,
      requiresModelPath: true,
    },
    {
      // fallback name used in some installations
      bin: 'main',
      args: (outPrefix) => [
        '-ng',
        '-nfa',
        '-m',
        WHISPER_MODEL_PATH,
        '-f',
        audioPath,
        '-of',
        outPrefix,
        '-otxt',
      ],
      transcriptPath: (outPrefix) => `${outPrefix}.txt`,
      requiresModelPath: true,
    },
    {
      // python whisper package
      bin: 'whisper',
      args: (outPrefix) => [audioPath, '--output_format', 'txt', '--output_dir', path.dirname(outPrefix)],
      transcriptPath: () => `${audioPath.replace(/\.[^.]+$/, '')}.txt`,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.requiresModelPath && !WHISPER_MODEL_PATH) {
      continue;
    }
    const outPrefix = path.join(
      os.tmpdir(),
      `cribclaw-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const args = candidate.args(outPrefix).filter(Boolean);
    const run = spawnSync(candidate.bin, args, { encoding: 'utf8' });
    if (run.status !== 0) {
      continue;
    }
    const transcriptFile = candidate.transcriptPath(outPrefix);
    if (!fs.existsSync(transcriptFile)) {
      continue;
    }
    const transcript = fs.readFileSync(transcriptFile, 'utf8').trim();
    if (transcript) {
      return transcript;
    }
  }

  return undefined;
}

async function runOpenAiWhisperFallback(input: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<string | undefined> {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const model = CRIBCLAW_STT_MODEL;
  const form = new FormData();
  form.append(
    'file',
    new Blob([input.bytes], { type: input.mimeType }),
    input.filename,
  );
  form.append('model', model);
  form.append('response_format', 'text');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) return undefined;
  const text = (await res.text()).trim();
  return text || undefined;
}

export async function transcribeAudioBytes(input: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<string | undefined> {
  const ext = path.extname(input.filename) || '.ogg';
  const tmpAudioPath = path.join(
    os.tmpdir(),
    `cribclaw-voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  fs.writeFileSync(tmpAudioPath, Buffer.from(input.bytes));

  try {
    const wavPath = convertToWav(tmpAudioPath);
    const local = runLocalWhisperCli(wavPath || tmpAudioPath);
    if (local) {
      return local;
    }
    // Optional fallback only if API key is present.
    return await runOpenAiWhisperFallback(input);
  } finally {
    try {
      fs.unlinkSync(tmpAudioPath);
    } catch {
      // ignore cleanup errors
    }
    try {
      const wavPath = tmpAudioPath.replace(/\.[^.]+$/, '.wav');
      if (fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
