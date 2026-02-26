/**
 * Import baby tracking data from CSV exports (Huckleberry, Glow, Baby Tracker, etc.)
 *
 * Usage:
 *   npx tsx scripts/cribclaw-import-csv.ts <csv-file> [--chat-jid <jid>] [--sender <name>] [--apply]
 *
 * Without --apply, runs in dry-run mode and shows what would be imported.
 *
 * Supported formats (auto-detected from column headers):
 *   - Huckleberry (Type, Start Time, End Time, Duration, ...)
 *   - Glow Baby (Activity, Start, End, Duration, Notes, ...)
 *   - Baby Tracker (Type/Activity, Time/Date, Duration, Amount, ...)
 *   - BabyBuddy (separate CSVs per type)
 *   - Generic (any CSV with recognizable date + event columns)
 *
 * The importer auto-detects the format from column headers and maps rows
 * to CribClaw event types (feed, diaper, sleep_start, sleep_end, etc.).
 */
/**
 * Programmatic import for use from index.ts (CSV sent via Telegram chat).
 * Returns a human-readable result message.
 */
export declare function importCsvFile(csvFilePath: string, chatJid: string, senderName?: string): string;
//# sourceMappingURL=cribclaw-import-csv.d.ts.map