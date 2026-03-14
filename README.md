# Hydra 🐍

An AI coding + assistant bot that combines the stability of [Kimaki](https://github.com/kimaki) with the multi-channel power of [OpenClaw](https://github.com/openclaw/openclaw).

**Live on Telegram:** [@agent_smith](https://t.me/agent_smith_bot)

---

## What it does

- **Multi-channel** — Telegram, Discord, Slack from one codebase
- **AI coding sessions** — powered by [OpenCode](https://opencode.ai) (free, runs locally)
- **Free claude-sonnet-4.6** — via GitHub Copilot OAuth (vision-capable)
- **Smart routing** — code questions → OpenCode, quick chat → Copilot, images → vision model, desktop tasks → computer-use
- **Full Mac desktop control** — AppleScript + cliclick + screenshot vision (tiered, token-efficient)
- **Streaming replies** — live message editing as the AI types
- **Security** — pairing codes for unknown senders, owner-only commands
- **Always-on** — launchd daemon, auto-restarts on reboot

---

## Architecture

```
packages/
  core/           — shared types, channel interface, subagent registry
  telegram/       — grammy bot with attachment download + streaming edit
  discord/        — discord.js with role-based access
  slack/          — @slack/bolt with Socket Mode
  gateway/        — central orchestrator (sessions, routing, memory, scheduler)
    src/
      gateway.ts          — main message handler + all commands
      opencode-session.ts — OpenCode SDK integration (streaming, vision)
      opencode-server.ts  — manages `opencode serve` subprocess
      session-manager.ts  — per-thread sessions + cross-channel continuity
      worktree-manager.ts — git worktrees per session + PR checkout
      pairing.ts          — security codes for unknown senders
      router.ts           — intent classifier (code/chat/vision/computer)
      scheduler.ts        — cron + one-shot scheduled tasks
      memory.ts           — per-thread persistent memory
      copilot-chat.ts     — direct Copilot API (fast chat, no OpenCode overhead)
      auth/
        github-copilot.ts — OAuth device flow + token refresh
  computer-use/   — Mac desktop automation
    src/
      agent.ts      — tiered task loop (AppleScript → vision → cliclick)
      ax-tree.ts    — macOS accessibility tree (0 vision tokens)
      applescript.ts — osascript wrapper
      click.ts      — cliclick wrapper
      screenshot.ts — screencapture wrapper
      vision.ts     — Copilot claude-sonnet-4.6 vision analysis
      budget.ts     — daily vision call budget (default 50/day)
scripts/
  install-daemon.sh   — install launchd plist, auto-start on login
  uninstall-daemon.sh — remove daemon
  daemon-status.sh    — show status + recent logs
```

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/jorge123255/hydra.git
cd hydra
pnpm install
```

### 2. Configure `.env`

```env
# Telegram (required)
TELEGRAM_BOT_TOKEN=your_bot_token

# Discord (optional)
DISCORD_TOKEN=your_discord_token
DISCORD_GUILD_ID=your_guild_id
DISCORD_ALLOWED_ROLES=Admin,Bot

# Slack (optional)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Owner — these user IDs bypass pairing and can run /approve
HYDRA_OWNER_IDS=123456789          # Telegram user ID
# HYDRA_OWNER_IDS=telegram:123456,discord:789012  (multi-channel format)

# Working directory for OpenCode sessions
HYDRA_WORKDIR=/Users/yourname/projects

# GitHub Copilot (optional — enables free claude-sonnet-4.6 with vision)
HYDRA_USE_COPILOT=true
HYDRA_COPILOT_MODEL=claude-sonnet-4.6
HYDRA_VISION_BUDGET=50             # max vision calls per day

# GitHub (optional — for PR worktrees)
GITHUB_TOKEN=ghp_xxx

# OpenCode port
OPENCODE_PORT=51050
```

### 3. Run (dev)

```bash
pnpm --filter @hydra/gateway dev
```

### 4. Install as daemon (macOS, always-on)

```bash
bash scripts/install-daemon.sh
```

Logs at `~/.hydra/logs/gateway.log`. Check status:

```bash
bash scripts/daemon-status.sh
```

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/remember <note>` | Save something to memory for this thread |
| `/forget` | Clear thread memory |
| `/schedule <cron\|ISO> <prompt>` | Schedule a task |
| `/unschedule <id>` | Remove a scheduled task |
| `/tasks` | List scheduled tasks |
| **Security** | |
| `/approve <channelId> <code>` | Approve a pairing request *(owner only)* |
| `/revoke <channelId> <userId>` | Revoke someone's access *(owner only)* |
| `/pending [channelId]` | List pending pairing requests *(owner only)* |
| **Copilot** | |
| `/copilot-login` | Connect GitHub Copilot (device code flow) *(owner only)* |
| `/copilot-status` | Check Copilot auth + token expiry |
| `/vision-usage` | Check vision API call budget for today |
| **Routing** | |
| `/fast <msg>` | Quick Copilot chat (no OpenCode overhead) |
| `/code <msg>` | Force OpenCode route |
| `/computer <task>` | Control the Mac desktop |
| **Worktrees** | |
| `/diff` | Show git diff of current session worktree |
| `/rollback` | Git stash pop in current worktree |
| **Cross-channel** | |
| `/link [accountId]` | Link your identity for cross-channel session sharing |
| `/handoff <channelId>` | Send session summary to another channel |

**Auto-detect:** messages containing `PR #N` automatically check out that PR into a worktree.

---

## Pairing / Security

New users who DM the bot get a pairing code:

```
👋 Hi! I don't recognize you.
Share this code with the bot owner:
  K5ZE54NE
Tell them to run: /approve telegram K5ZE54NE
Your ID: 1234567890
```

The bot owner runs `/approve telegram K5ZE54NE` to grant access.

Set your Telegram user ID as owner in `.env`:
```env
HYDRA_OWNER_IDS=your_telegram_user_id
```

---

## GitHub Copilot Setup (free claude-sonnet-4.6)

1. Make sure you have an active GitHub Copilot subscription
2. Message the bot: `/copilot-login`
3. Follow the device code instructions in the server terminal
4. Done — bot now uses `claude-sonnet-4.6` for all chat + vision

---

## Computer Use

The bot can control the Mac desktop using a tiered, token-efficient approach:

1. **AppleScript / ax-tree** — structured UI data, 0 vision tokens
2. **Screenshot + vision** — compressed JPEG to `claude-sonnet-4.6` via Copilot
3. **Action** — `cliclick` for mouse/keyboard, `osascript` for app control
4. **Verify** — ax-tree check (no screenshot needed)

Budget: `HYDRA_VISION_BUDGET=50` (default) caps daily vision API calls.

Requires: `cliclick` installed (`brew install cliclick`), Copilot configured.

---

## Tech Stack

- **Runtime:** Node.js + tsx (TypeScript, no compile step in dev)
- **Monorepo:** pnpm workspaces
- **Telegram:** grammy + apiThrottler + sequentialize
- **Discord:** discord.js
- **Slack:** @slack/bolt (Socket Mode)
- **AI:** OpenCode SDK v2 + GitHub Copilot OAuth
- **Automation:** osascript + cliclick + screencapture

---

## Credits

Built by combining the best of:
- [Kimaki](https://github.com/kimaki) — stable OpenCode + Discord bot foundation
- [OpenClaw](https://github.com/openclaw/openclaw) — multi-channel, subagents, Copilot auth, computer use
