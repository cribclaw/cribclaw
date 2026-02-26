# CribClaw Quickstart

This is the shortest safe setup for one family, running locally.
Telegram is the default channel.

## 1. Install and run setup

```bash
cd /path/to/cribclaw
npm run cribclaw:setup
```

If setup says Docker is missing, run:

```bash
brew install --cask docker
sudo mkdir -p /usr/local/cli-plugins && sudo chown $(whoami) /usr/local/cli-plugins
open -a Docker
docker info
```

Then run `npm run cribclaw:setup` again.

## 2. Create a Telegram bot

In Telegram:
1. Open `@BotFather`
2. Run `/newbot`
3. Copy the bot token
4. Run `/setprivacy` and disable privacy mode for this bot
5. Paste that token into setup when prompted

## 3. Let setup discover chats

Setup will ask you to do this:
1. Open a DM with your bot and send `/start`
2. Add the bot to your caregivers group
3. In the group, send `/cribclaw`

Then setup lists chats and asks you to select:
1. Main control chat
2. Family caregivers group

If you do not want a group yet:
1. Select your bot DM as main
2. Skip family group selection
3. Setup will automatically run DM-only mode (`CRIBCLAW_FAMILY_FOLDER=main`)

## 4. Start CribClaw

```bash
npm run dev
```

## 5. Test in family group

Send:

```text
fed 4oz at 8:15am
summary today
```

If both work, setup is complete.

## 6. Useful command

```bash
tail -f logs/nanoclaw.log
```

CSV exports auto-update after each new log:

```bash
ls store/exports
```

Per-chat files include:
- `all-events.csv`
- `feed.csv`
- `diaper.csv`
- `sleep.csv`
- `milestone.csv`
- `note.csv`

## 7. Generate phone-friendly graph screenshots (9:16)

First, list chats that have baby events:

```bash
npm run cribclaw:report -- --listChats
```

Then generate a report for your chat (`day`, `week`, `list`, or `summary`):

```bash
npm run cribclaw:report -- --chat tg:YOUR_CHAT_ID --view day --png --phone
```

This writes HTML + PNG to `store/reports/<chat_id>/`.

It also writes an SVG timeline chart in the same folder (phone-friendly and easy to share).

Examples:

```bash
npm run cribclaw:report -- --chat tg:YOUR_CHAT_ID --view week --png --phone
npm run cribclaw:report -- --chat tg:YOUR_CHAT_ID --view list --png --phone
npm run cribclaw:report -- --chat tg:YOUR_CHAT_ID --view summary --png --phone
```
