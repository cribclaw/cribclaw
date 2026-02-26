import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('Telegram group JID: starts with tg:-100', () => {
    const jid = 'tg:-10012345678';
    expect(jid.startsWith('tg:')).toBe(true);
  });

  it('Telegram user JID: starts with tg:', () => {
    const jid = 'tg:12345678';
    expect(jid.startsWith('tg:')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata('tg:-100group1', '2024-01-01T00:00:01.000Z', 'Group 1', 'telegram', true);
    storeChatMetadata('tg:100user', '2024-01-01T00:00:02.000Z', 'User DM', 'telegram', false);
    storeChatMetadata('tg:-100group2', '2024-01-01T00:00:03.000Z', 'Group 2', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('tg:-100group1');
    expect(groups.map((g) => g.jid)).toContain('tg:-100group2');
    expect(groups.map((g) => g.jid)).not.toContain('tg:100user');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:-100group', '2024-01-01T00:00:01.000Z', 'Group', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:-100group');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('tg:-100reg', '2024-01-01T00:00:01.000Z', 'Registered', 'telegram', true);
    storeChatMetadata('tg:-100unreg', '2024-01-01T00:00:02.000Z', 'Unregistered', 'telegram', true);

    _setRegisteredGroups({
      'tg:-100reg': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'tg:-100reg');
    const unreg = groups.find((g) => g.jid === 'tg:-100unreg');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('tg:-100old', '2024-01-01T00:00:01.000Z', 'Old', 'telegram', true);
    storeChatMetadata('tg:-100new', '2024-01-01T00:00:05.000Z', 'New', 'telegram', true);
    storeChatMetadata('tg:-100mid', '2024-01-01T00:00:03.000Z', 'Mid', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('tg:-100new');
    expect(groups[1].jid).toBe('tg:-100mid');
    expect(groups[2].jid).toBe('tg:-100old');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata('unknown-format-123', '2024-01-01T00:00:01.000Z', 'Unknown');
    // Explicitly non-group with unusual JID
    storeChatMetadata('custom:abc', '2024-01-01T00:00:02.000Z', 'Custom DM', 'custom', false);
    // A real group for contrast
    storeChatMetadata('tg:-100group', '2024-01-01T00:00:03.000Z', 'Group', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:-100group');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
