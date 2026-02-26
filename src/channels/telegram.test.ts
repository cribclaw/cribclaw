import { describe, expect, it } from 'vitest';

import { classifyTelegramPollingError, TelegramChannel } from './telegram.js';

function createChannel() {
  return new TelegramChannel({
    token: '123456:dummy-token',
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
  });
}

describe('TelegramChannel', () => {
  it('owns tg prefixed JIDs', () => {
    const channel = createChannel();
    expect(channel.ownsJid('tg:12345')).toBe(true);
    expect(channel.ownsJid('tg:-100123456789')).toBe(true);
  });

  it('does not own non-telegram JIDs', () => {
    const channel = createChannel();
    expect(channel.ownsJid('random')).toBe(false);
  });

  it('starts disconnected', () => {
    const channel = createChannel();
    expect(channel.isConnected()).toBe(false);
  });

  it('classifies common network reset polling failures', () => {
    const classified = classifyTelegramPollingError(new Error('fetch failed'));
    expect(classified.kind).toBe('network_reset');
  });

  it('classifies DNS polling failures', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.telegram.org');
    const classified = classifyTelegramPollingError(err);
    expect(classified.kind).toBe('network_dns');
  });

  it('classifies timeout polling failures', () => {
    const err = new Error('UND_ERR_CONNECT_TIMEOUT');
    const classified = classifyTelegramPollingError(err);
    expect(classified.kind).toBe('network_timeout');
  });
});
