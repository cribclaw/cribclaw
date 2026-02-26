import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudioBytes } from '../voice-transcription.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string };
  document?: { file_id: string; mime_type?: string; file_name?: string };
  video_note?: { file_id: string; mime_type?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramFile {
  file_path?: string;
}

const POLL_BACKOFF_MIN_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;

function withJitter(delayMs: number): number {
  const jitterFactor = 0.2;
  const jitter = delayMs * jitterFactor * Math.random();
  return Math.round(delayMs - jitter / 2 + jitter);
}

export function classifyTelegramPollingError(error: unknown): {
  kind:
    | 'network_dns'
    | 'network_timeout'
    | 'network_reset'
    | 'http'
    | 'abort'
    | 'unknown';
  detail: string;
} {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : String(error || '');
  const causeCode =
    error && typeof error === 'object' && 'cause' in error
      ? String(
          ((error as { cause?: { code?: unknown } }).cause?.code as string) || '',
        )
      : '';
  const lowered = `${message} ${causeCode}`.toLowerCase();

  if (lowered.includes('aborterror')) {
    return { kind: 'abort', detail: message || 'aborted' };
  }
  if (lowered.includes('enotfound') || lowered.includes('eai_again')) {
    return { kind: 'network_dns', detail: message || causeCode || 'dns failure' };
  }
  if (
    lowered.includes('etimedout') ||
    lowered.includes('timeout') ||
    lowered.includes('und_err_connect_timeout')
  ) {
    return {
      kind: 'network_timeout',
      detail: message || causeCode || 'network timeout',
    };
  }
  if (
    lowered.includes('econnreset') ||
    lowered.includes('socket hang up') ||
    lowered.includes('fetch failed')
  ) {
    return {
      kind: 'network_reset',
      detail: message || causeCode || 'connection reset',
    };
  }
  if (lowered.includes('http')) {
    return { kind: 'http', detail: message || 'http error' };
  }
  return { kind: 'unknown', detail: message || 'unknown polling error' };
}

export interface TelegramChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAutoRegister?: (chatId: string, chatName: string) => void;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private readonly opts: TelegramChannelOpts;
  private readonly apiBase: string;
  private connected = false;
  private stopRequested = false;
  private updateOffset = 0;
  private meId: number | null = null;
  private meUsername: string | null = null;
  private pollAbort?: AbortController;
  private pollBackoffMs = POLL_BACKOFF_MIN_MS;
  private consecutivePollFailures = 0;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    this.apiBase = `https://api.telegram.org/bot${opts.token}`;
  }

  async connect(): Promise<void> {
    const me = await this.apiRequest<TelegramUser>('getMe');
    this.meId = me.id;
    this.meUsername = me.username ?? null;
    this.connected = true;
    this.stopRequested = false;

    logger.info(
      {
        id: this.meId,
        username: this.meUsername,
      },
      'Connected to Telegram',
    );

    void this.pollLoop();
    await this.flushOutgoingQueue();
  }

  async disconnect(): Promise<void> {
    this.stopRequested = true;
    this.connected = false;
    this.pollAbort?.abort();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return /^tg:-?\d+$/.test(jid);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      return;
    }

    const chatId = this.parseChatId(jid);
    const prefixed = this.applyMessagePrefix(text);

    try {
      await this.apiRequest('sendMessage', {
        chat_id: chatId,
        text: prefixed,
      });
    } catch (error) {
      logger.error({ err: error, jid }, 'Failed to send Telegram message');
      this.outgoingQueue.push({ jid, text });
      throw error;
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    opts?: { caption?: string; mimeType?: string },
  ): Promise<void> {
    if (!this.connected) {
      throw new Error('Telegram channel is not connected');
    }

    const chatId = this.parseChatId(jid);
    const data = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (opts?.caption) {
      form.append('caption', opts.caption);
    }
    const fileName = filePath.split('/').pop() || 'cribclaw-summary';
    const mimeType = opts?.mimeType || 'application/octet-stream';
    const sendAsPhoto =
      mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
    const fieldName = sendAsPhoto ? 'photo' : 'document';
    const method = sendAsPhoto ? 'sendPhoto' : 'sendDocument';
    form.append(fieldName, new Blob([data], { type: mimeType }), fileName);

    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Telegram API ${method} failed with HTTP ${res.status}`);
    }

    const payload = (await res.json()) as TelegramApiResponse<unknown>;
    if (!payload.ok) {
      throw new Error(payload.description || `Telegram API ${method} returned ok=false`);
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping || !this.connected) return;
    const chatId = this.parseChatId(jid);
    try {
      await this.apiRequest('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch {
      // Non-fatal: typing indicators are best effort only.
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopRequested) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.apiRequest<TelegramUpdate[]>(
          'getUpdates',
          {
            timeout: 25,
            offset: this.updateOffset,
            allowed_updates: ['message'],
          },
          this.pollAbort.signal,
        );

        for (const update of updates) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
          if (update.message) {
            await this.handleInboundMessage(update.message);
          }
        }
        this.pollBackoffMs = POLL_BACKOFF_MIN_MS;
        this.consecutivePollFailures = 0;
      } catch (error: any) {
        if (this.stopRequested) break;
        const classified = classifyTelegramPollingError(error);
        if (classified.kind === 'abort') {
          continue;
        }
        this.consecutivePollFailures += 1;
        const retryInMs = withJitter(this.pollBackoffMs);
        logger.warn(
          {
            error: classified.detail,
            errorKind: classified.kind,
            consecutiveFailures: this.consecutivePollFailures,
            retryInMs,
          },
          'Telegram polling error, retrying',
        );
        await this.sleep(retryInMs);
        this.pollBackoffMs = Math.min(
          POLL_BACKOFF_MAX_MS,
          this.pollBackoffMs * 2,
        );
      } finally {
        this.pollAbort = undefined;
      }
    }
  }

  private async handleInboundMessage(message: TelegramMessage): Promise<void> {
    const chatId = `tg:${message.chat.id}`;
    const timestamp = new Date(message.date * 1000).toISOString();
    const isGroup =
      message.chat.type === 'group' || message.chat.type === 'supergroup';
    const chatName = this.chatDisplayName(message.chat);
    this.opts.onChatMetadata(chatId, timestamp, chatName, 'telegram', isGroup);

    const groups = this.opts.registeredGroups();
    if (!groups[chatId]) {
      if (this.opts.onAutoRegister && Object.keys(groups).length === 0) {
        this.opts.onAutoRegister(chatId, chatName);
      } else {
        return;
      }
    }

    const voiceOrAudioPresent = Boolean(
      message.voice?.file_id ||
      message.audio?.file_id ||
      (message.document?.mime_type?.startsWith('audio/') && message.document.file_id) ||
      message.video_note?.file_id,
    );
    if (voiceOrAudioPresent) {
      logger.info(
        {
          chatId,
          hasVoice: Boolean(message.voice?.file_id),
          hasAudio: Boolean(message.audio?.file_id),
          hasVideoNote: Boolean(message.video_note?.file_id),
          hasAudioDocument: Boolean(
            message.document?.mime_type?.startsWith('audio/') &&
              message.document.file_id,
          ),
        },
        'Telegram audio-like message detected',
      );
      try {
        await this.sendMessage(
          chatId,
          'Voice note detected. Preparing transcription...',
        );
      } catch {
        // Best-effort ack only
      }
    }
    // CSV file import via chat
    const csvFilePath = await this.resolveCsvDocument(chatId, message);

    const content =
      message.text ||
      message.caption ||
      (csvFilePath ? `__CSV_IMPORT_FILE__:${csvFilePath}` : undefined) ||
      (await this.resolveVoiceMessageContent(chatId, message)) ||
      (voiceOrAudioPresent ? '__VOICE_NOTE_FILE__:__unavailable__' : '');
    if (!content) return;

    const sender = message.from ? `tg-user:${message.from.id}` : `tg-user:unknown`;
    const senderName = this.userDisplayName(message.from);
    const fromMe = Boolean(this.meId && message.from?.id === this.meId);

    const inbound: NewMessage = {
      id: String(message.message_id),
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: fromMe,
    };

    this.opts.onMessage(chatId, inbound);
  }

  private async resolveVoiceMessageContent(
    chatJid: string,
    message: TelegramMessage,
  ): Promise<string | undefined> {
    const fileId =
      message.voice?.file_id ||
      message.audio?.file_id ||
      message.video_note?.file_id ||
      (message.document?.mime_type?.startsWith('audio/')
        ? message.document.file_id
        : undefined);

    if (!fileId) {
      logger.info({ chatJid }, 'No Telegram voice/audio file_id found');
      return undefined;
    }

    try {
      const file = await this.apiRequest<TelegramFile>('getFile', {
        file_id: fileId,
      });
      if (!file.file_path) {
        logger.warn({ chatJid, fileId }, 'Telegram getFile returned no file_path');
        return undefined;
      }

      const downloadUrl = `https://api.telegram.org/file/bot${this.opts.token}/${file.file_path}`;
      const fileRes = await fetch(downloadUrl);
      if (!fileRes.ok) {
        logger.warn(
          { chatJid, status: fileRes.status },
          'Telegram voice download failed',
        );
        return undefined;
      }

      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      const mimeType =
        message.voice?.mime_type ||
        message.audio?.mime_type ||
        message.video_note?.mime_type ||
        message.document?.mime_type ||
        'audio/ogg';
      const filename = path.basename(file.file_path) || 'voice-note.ogg';

      const transcript = await transcribeAudioBytes({
        bytes,
        filename,
        mimeType,
      });
      if (!transcript) {
        logger.warn(
          { chatJid, filename, mimeType },
          'No transcript from local STT, falling back to agent file path',
        );
        const groups = this.opts.registeredGroups();
        const group = groups[chatJid];
        if (!group) return undefined;
        const dir = path.join(GROUPS_DIR, group.folder, 'voice-notes');
        fs.mkdirSync(dir, { recursive: true });
        const hostFilePath = path.join(
          dir,
          `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`,
        );
        fs.writeFileSync(hostFilePath, Buffer.from(bytes));
        const containerFilePath = `/workspace/group/voice-notes/${path.basename(hostFilePath)}`;
        logger.info(
          { chatJid, hostFilePath, containerFilePath },
          'Queued audio file for agent transcription',
        );
        return `__VOICE_NOTE_FILE__:${containerFilePath}`;
      }

      logger.info(
        { chatJid, filename, transcriptLength: transcript.length },
        'Voice transcription succeeded',
      );
      return transcript;
    } catch (error: any) {
      logger.warn(
        { error: error?.message || String(error) },
        'Telegram voice transcription failed',
      );
      return undefined;
    }
  }

  private async resolveCsvDocument(
    chatJid: string,
    message: TelegramMessage,
  ): Promise<string | undefined> {
    const doc = message.document;
    if (!doc?.file_id) return undefined;

    const fileName = doc.file_name?.toLowerCase() || '';
    const mimeType = doc.mime_type?.toLowerCase() || '';
    const isCsv =
      fileName.endsWith('.csv') ||
      mimeType === 'text/csv' ||
      mimeType === 'application/csv';

    if (!isCsv) return undefined;

    try {
      const file = await this.apiRequest<TelegramFile>('getFile', {
        file_id: doc.file_id,
      });
      if (!file.file_path) return undefined;

      const downloadUrl = `https://api.telegram.org/file/bot${this.opts.token}/${file.file_path}`;
      const fileRes = await fetch(downloadUrl);
      if (!fileRes.ok) return undefined;

      const bytes = Buffer.from(await fileRes.arrayBuffer());
      const importDir = path.join(STORE_DIR, 'import');
      fs.mkdirSync(importDir, { recursive: true });
      const localPath = path.join(
        importDir,
        `${Date.now()}-${doc.file_name || 'import.csv'}`,
      );
      fs.writeFileSync(localPath, bytes);

      logger.info(
        { chatJid, fileName: doc.file_name, size: bytes.length, localPath },
        'CSV file downloaded for import',
      );
      return localPath;
    } catch (error: any) {
      logger.warn(
        { error: error?.message || String(error) },
        'Failed to download CSV document from Telegram',
      );
      return undefined;
    }
  }

  private chatDisplayName(chat: TelegramChat): string {
    return (
      chat.title ||
      chat.username ||
      [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
      `Chat ${chat.id}`
    );
  }

  private userDisplayName(user?: TelegramUser): string {
    if (!user) return 'Unknown';
    return (
      [user.first_name, user.last_name].filter(Boolean).join(' ') ||
      (user.username ? `@${user.username}` : '') ||
      `User ${user.id}`
    );
  }

  private parseChatId(jid: string): number {
    if (!this.ownsJid(jid)) {
      throw new Error(`Invalid Telegram JID: ${jid}`);
    }
    return Number(jid.slice(3));
  }

  private applyMessagePrefix(text: string): string {
    // Keep behavior aligned with other channels where the sender identity is explicit.
    // If bot has its own account, no prefix needed.
    // Telegram channel usually runs with a dedicated bot account.
    return text;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.connected && this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift();
        if (!item) continue;
        try {
          await this.sendMessage(item.jid, item.text);
        } catch {
          this.outgoingQueue.unshift(item);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async apiRequest<T>(
    method: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal,
    });

    if (!res.ok) {
      throw new Error(`Telegram API ${method} failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as TelegramApiResponse<T>;
    if (!data.ok) {
      throw new Error(data.description || `Telegram API ${method} returned ok=false`);
    }
    return data.result;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
