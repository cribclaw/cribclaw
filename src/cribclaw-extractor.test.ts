import { describe, expect, it } from 'vitest';

import { extractBabyEvent, extractBabyEvents } from './cribclaw-extractor.js';

describe('extractBabyEvent feed volume normalization', () => {
  const receivedAt = '2026-02-24T12:00:00.000Z';

  it('fills amount_ml when only ounces are provided', () => {
    const event = extractBabyEvent('fed 4oz bottle', receivedAt);
    expect(event.eventType).toBe('feed');
    expect(event.attributes.amount_oz).toBe(4);
    expect(event.attributes.amount_ml).toBe(118);
  });

  it('fills amount_oz when only ml are provided', () => {
    const event = extractBabyEvent('fed 120ml bottle', receivedAt);
    expect(event.eventType).toBe('feed');
    expect(event.attributes.amount_ml).toBe(120);
    expect(event.attributes.amount_oz).toBe(4.06);
  });

  it('extracts multiple events even without explicit separators', () => {
    const events = extractBabyEvents('fed 4oz diaper wet at 8:15am', receivedAt);
    const types = events.map((event) => event.eventType);
    expect(types).toContain('feed');
    expect(types).toContain('diaper');
  });

  it('treats ml-only transcript text as feed even with note prefix', () => {
    const event = extractBabyEvent(
      'Note: That baby at 2.22 p.m. 70 ml. Happy baby!',
      receivedAt,
    );
    expect(event.eventType).toBe('feed');
    expect(event.attributes.amount_ml).toBe(70);
    expect(event.attributes.amount_oz).toBe(2.37);
  });

  it('extracts feed + diaper from fedbaby and milliliters phrasing', () => {
    const events = extractBabyEvents(
      "Fedbaby at 2.15 pm, 30 milliliters, happy baby, change baby's diaper at 2.32 pm, medium amount of poo, medium amount of pee.",
      receivedAt,
    );
    const types = events.map((event) => event.eventType);
    expect(types).toContain('feed');
    expect(types).toContain('diaper');
  });

  it('records event time source and interesting attributes', () => {
    const event = extractBabyEvent(
      'Temp 100.2F, fed 3oz bottle at 2:22pm, happy baby',
      receivedAt,
    );
    expect(event.attributes.event_time_source).toBe('message_text');
    expect(event.attributes.feed_method).toBe('bottle');
    expect(event.attributes.mood).toBe('happy');
    expect(event.attributes.temperature_f).toBe(100.2);
  });

  it('uses message timestamp as event_time_source when no explicit time exists', () => {
    const event = extractBabyEvent('fed 2oz and diaper wet', receivedAt);
    expect(event.attributes.event_time_source).toBe('message_timestamp');
  });

  it('parses relative time phrases like "5 minutes ago"', () => {
    const event = extractBabyEvent('fed 2oz 5 minutes ago', receivedAt);
    expect(event.attributes.event_time_source).toBe('message_text');
    expect(event.attributes.event_time_kind).toBe('relative');
    const diffMinutes = Math.round(
      (Date.parse(receivedAt) - Date.parse(event.occurredAt)) / 60000,
    );
    expect(diffMinutes).toBe(5);
  });
});
