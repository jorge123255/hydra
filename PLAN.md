# Hydra Roadmap — Full Build Plan

> Updated: 2026-03-13  
> Status: Bot live on Telegram (agent_smith). Foundation complete.

---

## Phase 4 — Vision + Streaming (High Impact, Low Effort)

### 4A. Vision / Image Support
**What:** When a user sends a photo, file, or link to any channel, analyze it with the AI model before running the agent.  
**How:** OpenCode's `promptAsync` accepts `FilePartInput` in the parts array with `{ type: "file", mime, url }`. The `url` can be a data URL (`data:image/jpeg;base64,...`). We download the attachment in the channel adapter, base64-encode it, and pass it alongside the text part.  
**Free model note:** `opencode/big-pickle` (OpenCode's free hosted model) does NOT support vision. We need a separate vision call using a free vision API (options: OpenRouter free tier, Google Gemini free API, or Groq llava). We call the vision provider first, inject the description as text into the OpenCode prompt. Cost: zero, latency ~1s.  
**Scope:** `@hydra/core` (add image field to InboundMessage), `@hydra/telegram` (download + base64), `@hydra/discord` (same), `@hydra/gateway` (vision pre-pass before agent run).

### 4B. Streaming Replies (Live Message Editing)
**What:** Instead of waiting for the full agent response, send a "thinking..." message immediately, then edit it live as chunks arrive from OpenCode.  
**How:** OpenCode's event stream fires `message.part.updated` events with partial text. The `onChunk` callback in `RunOptions` is already wired — just unused. Telegram: `bot.api.editMessageText(chatId, msgId, chunk)`. Discord: `message.edit(chunk)`. Debounce edits to 1/sec to avoid rate limits.  
**Why this matters:** Makes the bot feel instant. Users see progress on long coding tasks.  
**Scope:** `@hydra/telegram` + `@hydra/discord` (send placeholder, expose edit callback), `@hydra/gateway` (pass onChunk through), `@hydra/core` (add `onChunk` to OutboundMessage or separate streaming interface).

---

## Phase 5 — Security + Access Control

### 5A. Pairing / Security Codes for Unknown Senders
**What:** Unknown user DMs the bot → bot replies with 8-char code → owner runs `/hydra pairing approve telegram CODE` to whitelist them. Per-channel allow-from list stored in `~/.hydra/pairing/`.  
**Port from:** `clawdbot-fix/src/pairing/pairing-store.ts`, `pairing-challenge.ts`  
**Key details:**
- Code alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous chars)
- Codes expire after 1 hour, max 3 pending per sender
- Allow-from list is a flat JSON array of approved sender IDs per channel
- File-locked writes to prevent concurrent corruption
**Scope:** new `@hydra/gateway/src/pairing.ts`, hook into all channel adapters' message handlers.

### 5B. Telegram Webhook Secret Validation *(security fix from OpenClaw)*
**What:** Validate the `X-Telegram-Bot-Api-Secret-Token` header before reading the request body.  
**Why:** OpenClaw just patched this (GHSA-jq3f-vjww-8rq7). Currently Hydra uses grammy's polling (not webhooks) so this is low priority, but needed before any webhook deployment.

### 5C. Device Bootstrap Tokens — Single Use *(security fix from OpenClaw)*
**What:** If Hydra ever exposes an HTTP setup/pairing API, ensure setup tokens are invalidated after first use.  
**Port from:** OpenClaw GHSA-63f5-hhc7-cx6p fix.

---

## Phase 6 — Multi-Model Routing + Free Model Strategy

### 6A. Smart Model Routing
**What:** Route messages to different models based on task type:
- Quick questions / classification → `opencode/big-pickle` (free, fast)
- Code tasks → claude-sonnet or gpt-4o (configured via env)
- Vision pre-pass → Gemini Flash (free tier, supports images)
- Long reasoning → claude-opus (on demand, `/deep` prefix)

**How:** Add `HYDRA_CODE_MODEL`, `HYDRA_FAST_MODEL`, `HYDRA_VISION_MODEL` env vars. Gateway classifies message intent before dispatching (simple regex heuristics first, then upgrade if needed).

**Free tier strategy:**
- `opencode/big-pickle` for all coding tasks (OpenCode's free hosted model — zero cost)  
- Google Gemini 2.0 Flash for vision (free tier: 1500 req/day)  
- Groq llama-3.3-70b for fast chat replies (free tier: 30 req/min)  
- GitHub Copilot OAuth for Claude access (free with GitHub account)

### 6B. GitHub Copilot OAuth Auth Profile
**Port from:** `clawdbot-fix/src/providers/github-copilot-auth.ts`, `github-copilot-token.ts`  
**What:** Authenticate via GitHub OAuth to get Copilot API tokens. Rotates automatically. Gives access to Claude models through Copilot without paying Anthropic directly.  
**Scope:** new `@hydra/gateway/src/auth-profiles/github-copilot.ts`

### 6C. Auth Profile Cooldown System
**What:** Replace simple `HYDRA_API_KEYS` round-robin with proper cooldown tracking. If a key/profile fails → mark on cooldown with expiry time → skip until cooled down → auto-recover.  
**Port from:** `clawdbot-fix/src/agents/auth-profiles.ts` (cooldown logic only, ~150 lines)

---

## Phase 7 — Media Understanding (Full Pipeline)

### 7A. Image Vision Pre-Pass
**Status:** Dependent on Phase 4A  
**Full pipeline:**
1. User sends photo to Telegram/Discord
2. Channel adapter downloads + base64-encodes image
3. Gateway calls vision model (Gemini Flash free API): "Describe this image in detail for a coding assistant"
4. Vision description prepended to user's prompt: `[Image: {description}]\n{user message}`
5. Combined prompt → OpenCode session

### 7B. Link Understanding
**What:** User sends a URL → gateway fetches + extracts text content → inject as context before agent run.  
**Port from:** `clawdbot-fix/src/link-understanding/`  
**Scope:** new `@hydra/gateway/src/link-understanding.ts`

### 7C. Audio Transcription
**What:** Telegram voice messages → transcribe → run as text prompt.  
**Hydra already downloads voice files** (telegram-channel.ts passes them as attachments). Just need transcription.  
**Options:** OpenAI Whisper API (paid), Groq Whisper (free tier: 2hr/day audio), or local whisper.cpp.  
**Env:** `HYDRA_TRANSCRIPTION_PROVIDER=groq|openai|local`

---

## Phase 8 — Always-On Daemon

### 8A. launchd Plist for macOS (bob)
**What:** Install Hydra as a macOS LaunchAgent so it survives reboots and auto-restarts on crash.  
**File:** `~/Library/LaunchAgents/ai.hydra.gateway.plist`  
**Port from:** `clawdbot-fix/src/daemon/` + `fix(launchd): harden macOS launchagent install permissions`  
**Scope:** new `scripts/install-daemon.sh` + plist template

### 8B. systemd Unit for Linux
**What:** Same for Linux servers.  
**File:** `~/.config/systemd/user/hydra-gateway.service`

---

## Phase 9 — Cross-Channel Session Continuity

### 9A. Session Routing by Account
**What:** Same user on Telegram + Discord → same underlying OpenCode session. `/handoff telegram` to transfer active session to another channel.  
**How:** Add `accountId` to session key alongside `channelId+threadId`. Lookup by accountId across channels. Store account↔channel mappings in `~/.hydra/accounts.json`.  
**Port from:** `clawdbot-fix/src/routing/session-key.ts` (account routing concept)

### 9B. `/handoff` Command
**What:** `/handoff discord` — send the current session's context summary to your Discord DM, continue there.

---

## Phase 10 — GitHub Integration + PR-Aware Worktrees

### 10A. GitHub PR Worktrees
**What:** "Fix the bug in PR #42" → bot fetches PR branch → checks out in dedicated worktree → runs session → pushes fix → comments on PR with results.  
**Scope:** extend `worktree-manager.ts` with `createFromPR(owner, repo, prNumber)`. Use `gh` CLI or GitHub API.  
**Env:** `GITHUB_TOKEN` for API access.

### 10B. Checkpoint + Rollback
**What:** Snapshot worktree state before each agent run. `/rollback` to undo.  
**How:** `git stash` before run, expose `/rollback` command to `git stash pop`.

### 10C. `/diff` Command
**What:** Show what the agent changed in the current worktree as a formatted diff sent back to the channel.

---

## Phase 11 — Per-User Usage Tracking

### 11A. Token + Cost Tracking
**What:** Track estimated tokens used per paired user. `/usage` command shows breakdown.  
**Store:** `~/.hydra/usage/<channelId>/<userId>.json`  
**Rate limiting:** Configurable per-user daily token budget via env or config file.

---

## Vision / Computer-Use Summary

| Capability | How | Provider | Cost |
|-----------|-----|----------|------|
| Image understanding | Gemini Flash vision API | Google | Free (1500/day) |
| Voice transcription | Groq Whisper | Groq | Free (2hr/day) |
| Link/URL reading | fetch + cheerio extract | Self-hosted | Free |
| Screen/desktop control | OpenCode already handles via Claude computer-use | Anthropic | Paid only |
| Browser automation | Playwright MCP | Local | Free |

**Computer-use note:** OpenCode's free `big-pickle` model does NOT support computer-use (requires Claude 3.5+). For screen control, we need a paid Anthropic key OR GitHub Copilot OAuth with Claude access. Strategy: add `/screen` command that switches the session to a paid model for that one run only.

---

## Build Order (Recommended)

| Sprint | Work | Delivers |
|--------|------|---------|
| **Now** | 4B (streaming replies) | Instant "feel" improvement |
| **Now** | 4A (vision pre-pass via Gemini) | Send photos, get analysis |
| **Next** | 5A (pairing codes) | Safe to share with others |
| **Next** | 7C (voice transcription via Groq) | Hands-free prompting |
| **Then** | 6A + 6B (model routing + Copilot OAuth) | Free Claude access |
| **Then** | 8A (launchd daemon) | Survives reboots |
| **Later** | 9A/9B (cross-channel continuity) | Power-user feature |
| **Later** | 10A (PR worktrees + GitHub) | Dev workflow |

---

## OpenClaw Latest Updates to Pull (2026-03-13)

Bob's clawdbot-fix is behind remote by at least these security patches:
- `fix(auth): device bootstrap tokens single-use` (GHSA-63f5-hhc7-cx6p)
- `fix(telegram): validate webhook secret` (GHSA-jq3f-vjww-8rq7)
- `fix: stabilize browser existing-session control`
- `fix(browser): normalize batch act dispatch with CSS selector + batch support`
- `perf(build): deduplicate plugin-sdk chunks` (64MB → was 190MB)

Run on bob: `cd /Users/gszulc/clawdbot-fix && git pull origin main`

