import { extractBabyEvents } from '../src/cribclaw-extractor.js';
import {
  BabyEventType,
  getAllBabyEventsForBackfill,
  initDatabase,
  insertBabyEvent,
} from '../src/db.js';

type GroupedMessage = {
  chatJid: string;
  messageId: string;
  sender: string;
  senderName: string;
  sourceContent: string;
  loggedAt: string;
  occurredAt: string;
  existingTypes: Set<BabyEventType>;
};

function parseArgs(argv: string[]): { apply: boolean } {
  const apply = argv.includes('--apply');
  return { apply };
}

function keyFor(chatJid: string, messageId: string): string {
  return `${chatJid}::${messageId}`;
}

function toEventTypes(raw: ReturnType<typeof extractBabyEvents>): BabyEventType[] {
  return raw.map((event) => event.eventType);
}

function main(): void {
  const { apply } = parseArgs(process.argv.slice(2));
  initDatabase();

  const rows = getAllBabyEventsForBackfill();
  const grouped = new Map<string, GroupedMessage>();

  for (const row of rows) {
    if (!row.chat_jid || !row.message_id || !row.sender || !row.source_content) {
      continue;
    }
    const key = keyFor(row.chat_jid, row.message_id);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        chatJid: row.chat_jid,
        messageId: row.message_id,
        sender: row.sender,
        senderName: row.sender_name,
        sourceContent: row.source_content,
        loggedAt: row.logged_at || row.occurred_at,
        occurredAt: row.occurred_at,
        existingTypes: new Set([row.event_type]),
      });
      continue;
    }
    existing.existingTypes.add(row.event_type);
  }

  let scannedMessages = 0;
  let candidates = 0;
  let inserted = 0;

  for (const group of grouped.values()) {
    scannedMessages += 1;
    const extracted = extractBabyEvents(group.sourceContent, group.occurredAt);
    const types = [...new Set(toEventTypes(extracted))];
    const singleTypeUpgradeFromNote =
      types.length === 1 &&
      types[0] !== 'note' &&
      group.existingTypes.size === 1 &&
      group.existingTypes.has('note');
    if (types.length <= 1 && !singleTypeUpgradeFromNote) {
      continue;
    }

    const missing = extracted.filter(
      (event) => !group.existingTypes.has(event.eventType),
    );

    if (missing.length === 0) {
      continue;
    }

    candidates += missing.length;

    if (!apply) {
      continue;
    }

    for (const event of missing) {
      insertBabyEvent({
        chat_jid: group.chatJid,
        message_id: group.messageId,
        sender: group.sender,
        sender_name: group.senderName,
        event_type: event.eventType,
        logged_at: group.loggedAt,
        occurred_at: event.occurredAt,
        summary: `Backfill: ${event.summary}`,
        source_content: group.sourceContent,
        confidence: event.confidence,
        attributes: {
          ...event.attributes,
          backfilled_multi_event: true,
        },
      });
      inserted += 1;
    }
  }

  console.log(`Scanned messages: ${scannedMessages}`);
  console.log(`Candidate missing events: ${candidates}`);
  if (apply) {
    console.log(`Inserted events: ${inserted}`);
  } else {
    console.log('Dry run only. Re-run with --apply to write changes.');
  }
}

main();
