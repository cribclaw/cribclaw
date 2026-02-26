import { beforeEach, describe, expect, it } from 'vitest';

import { CribclawService } from './cribclaw.js';
import {
  _initTestDatabase,
  getBabyDailySummary,
  getLastBabyEvent,
  listActiveCribclawReminders,
} from './db.js';
import { NewMessage } from './types.js';

const LOCKED_MODE = {
  runtimeMode: 'locked' as const,
  allowAssistantTasks: false,
  ownerSenders: new Set<string>(),
};

function makeMessage(content: string, id = 'msg-1'): NewMessage {
  return {
    id,
    chat_jid: 'tg:-100family',
    sender: 'tg:100mom',
    sender_name: 'Mom',
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };
}

describe('CribclawService', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('logs feed events from free-form text', () => {
    const service = new CribclawService();
    const result = service.processMessage(
      'tg:-100family',
      makeMessage('fed 4oz bottle at 8:15am'),
      LOCKED_MODE,
    );

    expect(result.intent).toBe('log_event');
    expect(result.loggedEventId).toBeTypeOf('number');
    expect(result.reply.toLowerCase()).toContain('feed logged');
  });

  it('answers last-feed query after logs exist', () => {
    const service = new CribclawService();
    service.processMessage(
      'tg:-100family',
      makeMessage('fed 4oz bottle at 8:15am', 'msg-feed-1'),
      LOCKED_MODE,
    );

    const result = service.processMessage(
      'tg:-100family',
      makeMessage('when was last feed?', 'msg-query-1'),
      LOCKED_MODE,
    );

    expect(result.intent).toBe('query_data');
    expect(result.reply.toLowerCase()).toContain('last feed');
  });

  it('returns visual attachment for summary queries', () => {
    const service = new CribclawService();
    service.processMessage(
      'tg:-100family',
      makeMessage('fed 4oz bottle at 8:15am', 'msg-feed-s1'),
      LOCKED_MODE,
    );

    const result = service.processMessage(
      'tg:-100family',
      makeMessage('summary today', 'msg-summary-1'),
      LOCKED_MODE,
    );

    expect(result.intent).toBe('query_data');
    if (result.attachmentFilePath) {
      expect(result.attachmentFilePath).toContain('/store/reports/');
      expect(result.attachmentFilePath).toContain('.png');
      expect(result.attachmentMimeType).toBe('image/png');
    } else {
      expect(result.reply.toLowerCase()).toContain('image render unavailable');
    }
  });

  it('calculates feed intake totals for past 24 hours instead of forcing summary view', () => {
    const service = new CribclawService();
    const base = new Date('2026-02-25T12:00:00.000Z');
    service.processMessage(
      'tg:-100family',
      {
        ...makeMessage('fed 4oz bottle', 'msg-feed-total-1'),
        timestamp: new Date(base.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      },
      LOCKED_MODE,
    );
    service.processMessage(
      'tg:-100family',
      {
        ...makeMessage('fed 60 ml bottle', 'msg-feed-total-2'),
        timestamp: new Date(base.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      },
      LOCKED_MODE,
    );

    const query = service.processMessage(
      'tg:-100family',
      {
        ...makeMessage(
          'calculate total ml eaten in the past 24 hours',
          'msg-feed-total-query-1',
        ),
        timestamp: base.toISOString(),
      },
      LOCKED_MODE,
    );

    expect(query.intent).toBe('query_data');
    expect(query.attachmentFilePath).toBeUndefined();
    expect(query.reply.toLowerCase()).toContain('feed intake past 24 hours');
    expect(query.reply.toLowerCase()).toContain('178 ml');
  });

  it('creates and lists reminders from natural language', () => {
    const service = new CribclawService();
    const create = service.processMessage(
      'tg:-100family',
      makeMessage('remind me in 2 hours to feed'),
      LOCKED_MODE,
    );
    expect(create.reply.toLowerCase()).toContain('reminder #');

    const list = service.processMessage(
      'tg:-100family',
      makeMessage('list reminders', 'msg-reminder-list-1'),
      LOCKED_MODE,
    );
    expect(list.reply.toLowerCase()).toContain('active reminders');
    expect(list.reply.toLowerCase()).toContain('feed');
  });

  it('cancels reminders via natural language', () => {
    const service = new CribclawService();
    service.processMessage(
      'tg:-100family',
      makeMessage('remind me in 30 min to check diaper', 'msg-reminder-set-2'),
      LOCKED_MODE,
    );
    const cancel = service.processMessage(
      'tg:-100family',
      makeMessage('cancel all reminders', 'msg-reminder-cancel-1'),
      LOCKED_MODE,
    );
    expect(cancel.reply.toLowerCase()).toContain('canceled');
  });

  it('sets after-feed reminder policy and auto-schedules after feed', () => {
    const service = new CribclawService();
    const setPolicy = service.processMessage(
      'tg:-100family',
      makeMessage('set reminder to eat 3 hours after each feed', 'msg-policy-1'),
      LOCKED_MODE,
    );
    expect(setPolicy.reply.toLowerCase()).toContain('enabled after-feed reminder');

    const logFeed = service.processMessage(
      'tg:-100family',
      makeMessage('fed 4oz bottle at 8:15am', 'msg-feed-policy-1'),
      LOCKED_MODE,
    );
    expect(logFeed.reply.toLowerCase()).toContain('auto reminder set');

    const active = listActiveCribclawReminders('tg:-100family');
    expect(active.some((r) => r.action_text.includes('[AUTO_AFTER_FEED]'))).toBe(true);
  });

  it('disables after-feed reminder policy', () => {
    const service = new CribclawService();
    service.processMessage(
      'tg:-100family',
      makeMessage('set reminder to eat 3 hours after each feed', 'msg-policy-2'),
      LOCKED_MODE,
    );
    service.processMessage(
      'tg:-100family',
      makeMessage('fed 4oz bottle', 'msg-feed-policy-2'),
      LOCKED_MODE,
    );

    const disable = service.processMessage(
      'tg:-100family',
      makeMessage('disable after each feed reminder', 'msg-disable-policy-1'),
      LOCKED_MODE,
    );
    expect(disable.reply.toLowerCase()).toContain('disabled after-feed reminders');
  });

  it('logs multiple event types from one message', () => {
    const service = new CribclawService();
    const timestamp = new Date().toISOString();
    const result = service.processMessage(
      'tg:-100family',
      {
        ...makeMessage(
          'fed 4oz bottle and diaper wet at 8:15am',
          'msg-multi-1',
        ),
        timestamp,
      },
      LOCKED_MODE,
    );

    const summary = getBabyDailySummary('tg:-100family', timestamp);
    expect(summary.feeds).toBe(1);
    expect(summary.diapers).toBe(1);
    expect(result.reply.toLowerCase()).toContain('logged 2 events');
  });

  it('blocks assistant tasks in locked mode', () => {
    const service = new CribclawService();
    const result = service.processMessage(
      'tg:-100family',
      makeMessage('please write code to add a feature', 'msg-task-1'),
      LOCKED_MODE,
    );

    expect(result.intent).toBe('assistant_task');
    expect(result.delegateToAgentPrompt).toBeUndefined();
    expect(result.reply.toLowerCase()).toContain('locked');
  });

  it('routes assistant tasks in builder mode for owners', () => {
    const service = new CribclawService();
    const result = service.processMessage(
      'tg:-100family',
      {
        ...makeMessage('please write code to add predictive reminders', 'msg-task-2'),
        sender: 'tg:100owner',
        sender_name: 'Owner',
      },
      {
        runtimeMode: 'builder',
        allowAssistantTasks: true,
        ownerSenders: new Set(['tg:100owner']),
      },
    );

    expect(result.intent).toBe('assistant_task');
    expect(result.delegateToAgentPrompt).toBeTruthy();
  });

  it('auto-logs ambiguous statements that contain event keywords', () => {
    const service = new CribclawService();
    const result = service.processMessage(
      'tg:-100family',
      makeMessage('she seemed extra fussy after tummy time', 'msg-note-1'),
      LOCKED_MODE,
    );

    expect(['unknown', 'log_event']).toContain(result.intent);
    expect(result.loggedEventId).toBeTypeOf('number');
    // Parser extracts "tummy time" keyword, so this is logged as a tummy_time event
    expect(result.reply.toLowerCase()).toContain('logged');
  });

  it('trusts LLM-extracted non-note events over regex query intent', () => {
    const service = new CribclawService();
    const message = makeMessage(
      'Did baby eat? 70 ml at 2.22 p.m. and happy baby',
      'msg-llm-override-1',
    );
    const result = service.processMessage(
      'tg:-100family',
      message,
      LOCKED_MODE,
      [
        {
          eventType: 'feed',
          occurredAt: message.timestamp,
          summary: '70 ml feed',
          confidence: 0.9,
          attributes: { amount_ml: 70, amount_oz: 2.37 },
        },
        {
          eventType: 'note',
          occurredAt: message.timestamp,
          summary: 'happy baby',
          confidence: 0.84,
          attributes: {},
        },
      ],
    );

    const summary = getBabyDailySummary('tg:-100family', message.timestamp);
    expect(summary.feeds).toBe(1);
    expect(summary.notes).toBe(1);
    expect(result.reply.toLowerCase()).toContain('logged 2 events');
  });

  it('augments partial LLM extraction with missing parser event types', () => {
    const service = new CribclawService();
    const message = makeMessage(
      "Fedbaby at 2.15 pm, 30 milliliters, happy baby, change baby's diaper at 2.32 pm, medium amount of poo, medium amount of pee.",
      'msg-augment-1',
    );
    const result = service.processMessage(
      'tg:-100family',
      message,
      LOCKED_MODE,
      [
        {
          eventType: 'diaper',
          occurredAt: message.timestamp,
          summary: 'diaper change',
          confidence: 0.91,
          attributes: { dirty: true, wet: true },
        },
      ],
    );

    const summary = getBabyDailySummary('tg:-100family', message.timestamp);
    expect(summary.diapers).toBe(1);
    expect(summary.feeds).toBe(1);
    expect(result.reply.toLowerCase()).toContain('logged 2 events');
  });

  it('amends latest event time from natural-language correction', () => {
    const service = new CribclawService();
    service.processMessage(
      'tg:-100family',
      makeMessage('fed 4oz bottle at 8:15am', 'msg-correct-1'),
      LOCKED_MODE,
    );

    const correctionTime = '2026-02-25T17:30:00.000Z';
    const correction = service.processMessage(
      'tg:-100family',
      {
        ...makeMessage('actually it was 5 minutes ago', 'msg-correct-2'),
        timestamp: correctionTime,
      },
      LOCKED_MODE,
    );

    const lastFeed = getLastBabyEvent('tg:-100family', ['feed']);
    expect(lastFeed).toBeDefined();
    const diffMinutes = Math.round(
      (Date.parse(correctionTime) - Date.parse(lastFeed!.occurred_at)) / 60000,
    );
    expect(diffMinutes).toBe(5);
    expect(correction.reply.toLowerCase()).toContain('updated feed time');
  });
});
