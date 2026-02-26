# CribClaw Production Runbook

_Last updated: February 25, 2026_

## 1) Baseline

Run from repo root:

```bash
npm install
npm run build
npm test
```

Expected: build passes and tests are green.

## 2) Health Check

```bash
npm run cribclaw:health
```

This verifies:

- Node runtime version
- `.env` presence
- Telegram token presence (if Telegram channel enabled)
- Docker runtime availability
- SQLite DB + required tables
- local STT model presence (warn-level if missing)

## 3) Safe Runtime Defaults

Recommended `.env` values:

```env
PRIMARY_CHANNEL=telegram
CRIBCLAW_LLM_FIRST=true
CRIBCLAW_PARSER_FALLBACK=true
CRIBCLAW_RUNTIME_MODE=locked
CRIBCLAW_ALLOW_ASSISTANT_TASKS=false
```

For stricter LLM-only behavior:

```env
CRIBCLAW_PARSER_FALLBACK=false
```

For summary rendering stability on macOS:

```env
CHROME_BIN=/opt/homebrew/bin/chromium
```

## 4) Backups

Create backup:

```bash
npm run cribclaw:backup
```

Custom location:

```bash
node scripts/cribclaw-backup.mjs --out /absolute/path/to/backup
```

Restore:

```bash
node scripts/cribclaw-restore.mjs --from /absolute/path/to/backup
```

Restore creates a safety snapshot at:

`archive/restore-safety/pre-restore-<timestamp>/`

## 5) Start

```bash
npm run dev
```

## 6) Operational Checks

- If Telegram logs `fetch failed`, check internet/VPN/DNS first.
- Polling now retries with backoff; transient failures should self-heal.
- If voice transcription stalls, run `npm run cribclaw:check-stt`.

## 7) Release Checklist (Open Source)

1. `npm run build` passes.
2. `npm test` passes.
3. `npm run cribclaw:health` passes on clean machine.
4. Backup/restore tested once with real data.
5. Summary image rendering verified.
6. Rotate bot token before publishing screenshots/logs.
