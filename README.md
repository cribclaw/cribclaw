# CribClaw

<p align="center">
  <img src="site/img/cribclaw-hero.png" alt="CribClaw" width="600">
</p>

**Your newborn's 24/7 AI agent.**

CribClaw is an open-source, self-hosted baby tracking assistant that runs on Telegram. Instead of tapping buttons in an app at 3am, just send a message — CribClaw's AI extracts events, tracks patterns, and sends you visual summaries.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw). Powered by Claude.

---

## Why CribClaw?

| | Baby Apps (Huckleberry, Glow, etc.) | **CribClaw** |
|---|---|---|
| **Input** | Tap buttons, fill forms | Just talk — *"fed 4oz at 3pm, changed diaper"* |
| **Multi-event** | One at a time | One message, multiple events |
| **Voice notes** | Paid / limited | Built-in (local Whisper, no cloud) |
| **Reminders** | Fixed timers | You set them — *"remind me 3 hours after each feed"* |
| **Predictions** | Premium / basic | Median-based, improves with data |
| **Privacy** | Your data on their cloud | 100% self-hosted, SQLite on your machine |
| **Exports** | Premium CSV | Auto-generated CSVs, always free |
| **Visual reports** | In-app only | PNG calendars sent to your chat |
| **Open source** | No | Yes (AGPL-3.0) |
| **Cost** | Free tier + $5-10/mo premium | Free forever |

---

## Features

- **Natural language logging** — 12 event types: feed, diaper, sleep, milestone, pump, tummy time, solids, supplement, growth, bath, note
- **Multi-event extraction** — *"fed 4oz, changed diaper, started tummy time"* logs 3 events from one message
- **Custom reminders** — *"set reminder to feed 3 hours after each feed"* — you choose the interval
- **Visual calendar summaries** — daily and weekly PNG timeline charts sent directly to your chat
- **Pattern detection and alerts** — flags deviations from your baby's normal patterns
- **Pattern detection** — observational stats from your baby's own logged data
- **Voice note transcription** — local-first via Whisper (no cloud required)
- **Multi-caregiver support** — every event attributed to the caregiver who logged it
- **Retroactive corrections** — *"actually that was at 2:15pm"* with full audit trail
- **Auto-generated CSV exports** — dynamic columns that expand as new data is observed
- **Growth tracking** — weight, height, head circumference logging

---

## Medical Disclaimer

> **CribClaw is not a medical device.** It is a behavioral and activity tracker for informational purposes only. It is not a substitute for professional medical advice, diagnosis, or treatment. Always consult a qualified healthcare provider for medical decisions regarding your child.
>
> See [DISCLAIMER.md](DISCLAIMER.md) for full details.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Docker](https://www.docker.com/) (for running the AI agent in isolation)
- A Telegram bot token ([create one via @BotFather](https://t.me/BotFather))
- An [Anthropic API key](https://console.anthropic.com/)
- *(Optional)* [Whisper](https://github.com/ggerganov/whisper.cpp) for local voice note transcription — falls back to OpenAI Whisper API if not installed

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/nathanseltzer/cribclaw.git
cd cribclaw

# 2. Install dependencies
npm install

# 3. Copy and edit the config
cp .env.example .env
# Edit .env: set TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY

# 4. Build the agent container
./container/build.sh

# 5. Start CribClaw
npm run dev
```

Message your Telegram bot to start tracking. No commands needed — just talk naturally.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | *(required)* | Your Telegram bot token |
| `ANTHROPIC_API_KEY` | *(required)* | Anthropic API key (in .env, read at runtime) |
| `CRIBCLAW_BABY_NAME` | | Baby's name (shown in visual summaries) |
| `CRIBCLAW_BABY_DOB` | | Baby's date of birth (ISO format, e.g. `2025-06-15`) |
| `CRIBCLAW_FEED_REMINDERS_ENABLED` | `false` | Fixed-interval feed reminders (off by default — use natural language reminders instead) |
| `CRIBCLAW_FEED_REMINDER_MINUTES` | `120,180` | Minutes after feed to remind (only if enabled above) |
| `CRIBCLAW_DAILY_SUMMARY_ENABLED` | `true` | Send daily visual summary |
| `CRIBCLAW_DAILY_SUMMARY_HOUR` | `20` | Hour (0-23) to send daily summary |
| `CRIBCLAW_PATTERN_ALERTS_ENABLED` | `true` | Alert on pattern deviations |
| `CRIBCLAW_ADAPTIVE_REMINDERS` | `true` | Show predicted next feed time after logging |
| `CRIBCLAW_AUTO_ESCALATION_MINUTES` | `0` | Minutes without feed before alert (0 = disabled) |
| `CRIBCLAW_LLM_FIRST` | `true` | Use AI for event extraction |
| `CRIBCLAW_PARSER_FALLBACK` | `true` | Regex fallback if AI unavailable |

---

## Platform Support

CribClaw runs anywhere Node.js and Docker run:

| Platform | Runtime | Service Manager |
|----------|---------|-----------------|
| **macOS** | Docker Desktop | `launchctl` (plist included) |
| **Linux** | Docker | `systemd` (example below) |
| **Windows** | Docker Desktop (WSL2) | Task Scheduler or WSL service |

<details>
<summary>Example systemd service (Linux)</summary>

```ini
[Unit]
Description=CribClaw
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/cribclaw
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

</details>

---

## Importing Data from Other Apps

Switching from Huckleberry, Glow Baby, or another tracking app? CribClaw can import your CSV exports.

```bash
npm run cribclaw:import -- path/to/export.csv
```

The importer auto-detects the format from column headers. You can also send a CSV file directly in the Telegram chat and it will import automatically.

> **Important:** Send at least one message to your Telegram bot before running the CLI import. The importer needs your chat ID from the database to associate the data with your chat. If you see "No existing chats found", message your bot first, then re-run the import.

Supported formats:
- **Huckleberry** — tap child icon → scroll down → "Export tracking data as CSV"
- **Glow Baby** — contact support@glowing.com for CSV export, or use [glow-export](https://github.com/askerry/glow-export) to convert PDFs
- **Baby Tracker** — export from app settings
- **BabyBuddy** — separate CSVs per event type
- **Generic** — any CSV with recognizable date and event type columns

Options: `--chat-jid <jid>`, `--sender <name>`, `--dry-run`

---

## Scripts

```bash
npm run dev                    # Run with hot reload
npm run build                  # Compile TypeScript
npm test                       # Run tests
npm run cribclaw:setup         # Interactive setup wizard
npm run cribclaw:report        # Generate visual reports
npm run cribclaw:import        # Import CSV from other apps
npm run cribclaw:health        # Health check
npm run cribclaw:backup        # Create backup
npm run cribclaw:restore       # Restore from backup
```

---

## Architecture

```
Telegram Bot → SQLite → Polling Loop → Docker Container (Claude Agent SDK) → Response
```

Single Node.js process. Messages arrive via Telegram, get stored in SQLite, and are processed by Claude running in isolated Docker containers. Each family/group gets its own filesystem and memory.

---

## License

[AGPL-3.0-or-later](LICENSE)

You are free to use, modify, and distribute CribClaw. If you run a modified version as a service, you must release your source code under the same license.

---

## Contributing

Issues and discussions are welcome. Please open an issue before submitting a PR so we can discuss the approach. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Links

- [CribClaw.com](https://cribclaw.com)
- [GitHub](https://github.com/nathanseltzer/cribclaw)
- [YouTube @deepcharts](https://youtube.com/@deepcharts)
- [Twitter @nathanseltzer](https://x.com/nathanseltzer)
- Built on [NanoClaw](https://github.com/qwibitai/nanoclaw)
