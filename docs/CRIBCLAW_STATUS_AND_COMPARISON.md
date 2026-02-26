# CribClaw Status And NanoClaw Comparison

_As of February 25, 2026_

## Direct Answers

### 1) Is the repeated "Google Chrome quit unexpectedly" popup related?
Yes, likely. CribClaw renders visual summaries by spawning a headless Chrome binary. That code path is in:

- `src/cribclaw-visual-summary.ts`
- `scripts/cribclaw-report.mjs`

If Chrome crashes during repeated renders, macOS can show the crash dialog.

Immediate mitigation:

```bash
echo 'CHROME_BIN=/opt/homebrew/bin/chromium' >> .env
```

Then restart CribClaw. This forces renderer calls to CLI Chromium first, instead of GUI Chrome.app.

### 2) Is this actually LLM-first now, not regex-first?
Yes, it is **LLM-first with parser fallback enabled by default**.

- `CRIBCLAW_LLM_FIRST=true` by default
- `CRIBCLAW_PARSER_FALLBACK=true` by default

Flow:

1. LLM extraction runs first.
2. If LLM output is incomplete/unparseable, parser fallback can augment or recover events.

For strict LLM-only behavior:

```bash
CRIBCLAW_PARSER_FALLBACK=false npm run dev
```

or:

```bash
npm run dev:llm
```

### 3) Are we production-ready for an open-source NanoClaw fork?
Not fully yet. It is usable for local family use, but still in **beta-hardening** stage for open-source production.

Current blocking signal from CI-like check:

- `npm run build`: pass
- `npm test`: **1 failing test** (`src/channels/whatsapp.test.ts`)

Additional hardening still needed:

- Stabilize summary image renderer behavior on macOS.
- Harden voice-note transcription path and timeout behavior.
- Complete end-to-end tests for Telegram voice + visual summaries + reminders.
- Finalize release docs for auth/token/runtime troubleshooting.

## Code Size Delta vs Upstream NanoClaw

Repository baseline:

- `origin` -> `https://github.com/qwibitai/nanoclaw.git`
- compared against `origin/main` commit `6f177adafeea3ae7209f0597bab5d16499886bc4`

Tracked diff vs upstream:

- `+2184 / -51` lines
- net `+2133` lines

Current total code footprint (`src/`, `scripts/`, `container/agent-runner/src`, `.ts/.js/.mjs`):

- current: `14,135` lines in `47` files
- upstream: `8,056` lines in `32` files
- net: **`+6,079` lines** and **`+15` files**

## Full CribClaw Feature List (Current)

### Core platform inherited from NanoClaw

- Containerized agent execution.
- SQLite-backed message and state storage.
- Scheduled task runtime.
- Group/channel registration model.
- Main control chat + isolated group contexts.
- Trigger-based assistant routing.

### CribClaw family assistant capabilities

- Telegram-first setup flow for quick local install.
- Message-first logging (no slash commands required for normal use).
- LLM-first extraction of baby events from free text.
- Multi-event extraction from one message (feed + diaper + note, etc.).
- Event types: `feed`, `diaper`, `sleep_start`, `sleep_end`, `medication`, `milestone`, `note`.
- Dual timestamps:
  - `occurred_at` (event time)
  - `logged_at` (when logged)
- Relative-time interpretation (`N minutes ago`, `half an hour ago`).
- Correction/amend flow to adjust previously logged event time.
- Caregiver attribution (`sender`, `sender_name`) per event.
- Dynamic attributes per event (amount, mood, temp, poop/pee, etc.).
- Attribute registry for newly observed variables.
- Auto-generated CSV snapshots on every write:
  - `all-events.csv`
  - per-type CSVs (`feed.csv`, `diaper.csv`, `sleep.csv`, etc.)
  - dynamic columns added as new attributes appear
- Reminder system:
  - default after-feed reminders (`120`, `180` min)
  - natural-language custom reminders/timers
  - recurring reminders
- Basic predictions:
  - next feed (interval median)
  - next diaper (interval median)
  - likely wake time from sleep sessions
- Daily/weekly summaries (weekly only when explicitly requested).
- Visual summary generation (calendar-style PNG + HTML artifact).
- Voice note ingestion:
  - local STT via `whisper.cpp`/`whisper-cli`
  - optional API fallback
  - agent fallback path
- Builder-mode delegation (owner-only) for controlled agentic tasks.

### Security model (for this fork)

- Local-first runtime by default.
- Container isolation for agent execution.
- Mount allowlist support.
- Dedicated bot token model for Telegram.
- Still requires careful token management and safe host setup.

## CribClaw vs NanoClaw (Direct)

| Area | NanoClaw upstream | CribClaw fork |
|---|---|---|
| Primary use case | General personal assistant | Single-family baby assistant |
| Default channel | WhatsApp-oriented baseline | Telegram-first setup (WhatsApp optional) |
| Input model | Trigger + assistant interactions | Natural family messages first |
| Domain schema | Generic tasks/messages | Structured baby event model + attributes |
| Domain analytics | Generic | Baby summaries, trends, interval predictions |
| Reminders | Generic scheduled tasks | After-feed automation + caregiver reminders |
| CSV exports | Not domain-specific | Auto domain snapshots with dynamic columns |
| Visual reporting | Not domain-specific | Calendar-style day/week summary visuals |
| Voice memo path | Not baby-workflow focused | Voice transcription pipeline integrated |
| Event correction | Not domain-specific | Time amendment workflow + audit trail |
| Data ownership | Local SQLite + container runtime | Same, plus baby-domain data model |
| Complexity/LOC | Smaller baseline | Larger: +~6k lines for family domain features |

## What Is Gained vs Doing "Pure NanoClaw"

Gained:

- Immediate baby-domain UX and schema.
- Family logging workflows out of the box.
- Reminders, summaries, and prediction primitives tuned for baby tracking.
- CSV/reporting artifacts ready for household use.

Lost:

- Minimal baseline simplicity of upstream.
- More moving parts (STT, visuals, schema migration, export surfaces).
- More QA burden to keep production reliability.

## Open-Source Production Checklist (Recommended Next)

1. Make test suite green (`npm test` with 0 failures).
2. Add regression tests for LLM-extraction fallback and multi-event writes.
3. Stabilize summary renderer and document a non-Chrome fallback path.
4. Add end-to-end smoke test (Telegram message -> DB write -> CSV -> summary image).
5. Add release runbook (tokens, env, Docker, migration, backup/restore).
6. Cut tagged beta release, gather user issues, then promote stable.
