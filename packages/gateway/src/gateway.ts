// The Hydra Gateway — central orchestrator.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ChannelRegistry,
  type InboundMessage,
  type ChannelEvent,
} from "@hydra/core";
import { SessionManager, buildSessionKey } from "./session-manager.js";
import { runSession } from "./opencode-session.js";
import { stopServer } from "./opencode-server.js";
import { Scheduler, type ScheduledTask } from "./scheduler.js";
import {
  buildMemoryPrompt,
  appendMemory,
  writeMemory,
  searchMemory,
  buildEnvelope,
  getCurrentTime,
  readMemory,
} from "./memory.js";
import { createLogger } from "./logger.js";
import {
  isAllowed,
  upsertPairingRequest,
  approvePairing,
  revokePairing,
  listPendingRequests,
} from "./pairing.js";
import { classifyIntent, stripIntentPrefix, getOllamaModelForIntent } from "./router.js";
import {
  isCopilotConfigured,
  isClaudeConfigured,
  getValidClaudeToken,
  githubCopilotLogin,
  resolveCopilotCredentials,
  getVisionUsageStatus,
  isCodexConfigured,
  isOllamaCloud,
} from "./copilot-chat.js";
import {
  buildAuthUrl,
  exchangeCode,
  saveResult,
  saveApiKey,
  type PendingOAuth,
} from "./auth/anthropic-oauth.js";
import {
  createFromPR,
  getWorktreeDiff,
  rollbackWorktree,
} from "./worktree-manager.js";
import { buildSystemPrompt, NO_REPLY, HEARTBEAT_OK } from "./system-prompt.js";
import { runSelfReview, getReviewStats } from "./self-review.js";
import { writeSelfAwareness } from "./self-awareness.js";
import {
  listPoolAccounts,
  removeAccountFromPool,
  addKeyToPool,
  callSubagentsParallel,
  isCodexPoolConfigured,
  startDeviceFlow,
  pollForToken,
  saveOAuthAccount,
  syncFromCodexCli,
} from "./auth/codex-pool.js";
import { ensureWorkspaceFiles, readWorkspaceFiles } from "./workspace.js";
import { HeartbeatManager, HEARTBEAT_PROMPT } from "./heartbeat.js";
import {
  parseSaveTags,
  applySaveTag,
  detectAutoUpdates,
  scheduleSelfRestart,
} from "./self-update.js";
import { transcribeAudio, isTranscriptionConfigured } from "./transcribe.js";
import { extractUrls, buildWebContext } from "./webfetch.js";
import { compressMemoryIfNeeded } from "./memory.js";
import {
  appendHistory,
  buildPromptWithHistory,
  clearHistory,
} from "./history.js";
import { logCall } from "./metrics.js";
import { extractFeedback, getLessonsContent } from "./lessons.js";
import { startHealthCheckLoop, runHealthChecks, formatHealthReport, getLastHealthState } from "./health-checker.js";
import { extractConfidence, logConfidence, getConfidenceSummary, CONFIDENCE_INSTRUCTION } from "./confidence.js";
import { extractGoalTags, writeGoalsFile, formatGoalsList, listGoals, addGoal, completeGoal, GOALS_INSTRUCTION } from "./goals.js";
import { getAutoTunePrefix, getTuningStatus } from "./prompt-tuner.js";
import { logAudit, extractDecisionTags, getRecentAudit, formatAuditLog, DECISION_INSTRUCTION } from "./audit.js";
import { extractFactTags, writeFactsFile, listActiveFacts, formatFactsList, startFactSweepLoop, FACTS_INSTRUCTION } from "./knowledge.js";
import { buildCapabilities, formatCapabilities, writeCapabilitiesFile } from "./capabilities.js";

const log = createLogger("gateway");

function hasOpencodeAuth(): boolean {
  try {
    const data = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
        "utf8",
      ),
    );
    return !!data?.anthropic;
  } catch {
    return false;
  }
}

function hasAnyCredentials(): boolean {
  return (
    isClaudeConfigured() ||
    isCodexConfigured() ||
    isCopilotConfigured() ||
    hasOpencodeAuth()
  );
}

export type GatewayConfig = {
  workdir: string;
  sessionIdleMs?: number;
  worktrees?: boolean;
};

const CMD_REMEMBER = /^\/remember\s+(.+)/i;
const CMD_FORGET = /^\/forget$/i;
const CMD_SEARCH = /^\/search\s+(.+)/i;
const CMD_SCHEDULE = /^\/schedule\s+(.+)/i;
const CMD_UNSCHEDULE = /^\/unschedule\s+(\S+)/i;
const CMD_TASKS = /^\/tasks$/i;
const CMD_HELP = /^\/help$/i;
const CMD_APPROVE = /^\/approve\s+(\S+)\s+(\S+)/i;
const CMD_REVOKE = /^\/revoke\s+(\S+)\s+(\S+)/i;
const CMD_PENDING = /^\/pending(?:\s+(\S+))?$/i;
const CMD_COPILOT = /^\/copilot[-_]login$/i;
const CMD_CHATGPT = /^\/chatgpt[-_]login(?:\s+(.+))?$/i;
const CMD_CHATGPT_STATUS = /^\/chatgpt[-_]status$/i;
const CMD_CHATGPT_ACCOUNTS = /^\/chatgpt[-_]accounts$/i;
const CMD_CHATGPT_REMOVE = /^\/chatgpt[-_]remove\s+(\S+)/i;
const CMD_CHATGPT_SYNC = /^\/chatgpt[-_]sync$/i;
const CMD_CHATGPT_TOKEN = /^\/chatgpt[-_]token\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i;
const CMD_CHATGPT_KEY = /^\/chatgpt[-_](?:login|key)\s+(\S+)\s+(sk-\S+)/i;
const CMD_COPILOT_STATUS = /^\/copilot[-_]status$/i;
const CMD_CLAUDE_STATUS = /^\/claude[-_]status$/i;
const CMD_CLAUDE_KEY = /^\/claude[-_]key\s+(\S+)/i;
const CMD_MODEL = /^\/model(?:\s+(\S+))?$/i;
const CMD_VISION_USAGE = /^\/vision[-_]usage$/i;
const CMD_STATUS = /^\/status$/i;
const CMD_LINK = /^\/link(?:\s+(\S+))?$/i;
const CMD_HANDOFF = /^\/handoff\s+(\S+)/i;
const CMD_DIFF = /^\/diff$/i;
const CMD_ROLLBACK = /^\/rollback$/i;
const PR_PATTERN = /\bpr\s*#(\d+)/i;
const CMD_LOGIN = /^\/opencode[-_]login$/i;
const CMD_OAUTH_CODE = /^\/opencode[-_]code\s+(\S+)/i;
const CMD_PROVIDERS  = /^\/providers$/i
const CMD_RESTART    = /^\/restart$/i
const CMD_PING = /^\/ping$/i;
const CMD_REVIEW = /^\/review$/i;
const CMD_REVIEW_STATS = /^\/review[-_]stats$/i;
const CMD_STATS = /^\/stats$/i;
const CMD_HEALTH = /^\/health$/i;
const CMD_GOALS = /^\/goals$/i;
const CMD_GOAL_ADD = /^\/goal\s+(?!done\b)(.+)/i;
const CMD_GOAL_DONE = /^\/goal[-_\s]done\s+(\d+)/i;
const CMD_TUNE = /^\/tune$/i;
const CMD_AUDIT = /^\/audit$/i;
const CMD_FACTS = /^\/facts$/i;
const CMD_CAN = /^\/can$/i;

const NO_CREDS_MSG = [
  "No AI credentials configured.",
  "",
  "To get started:",
  "• Run /opencode-login to connect your Claude account (recommended)",
  "• Or run /claude-key sk-ant-... to paste an API key directly",
].join("\n");

export class Gateway {
  private registry: ChannelRegistry;
  private sessions: SessionManager;
  private config: GatewayConfig;
  private sweepTimer?: NodeJS.Timeout;
  private activeRuns = new Map<string, AbortController>();
  private scheduler: Scheduler;
  private pendingOAuth = new Map<string, PendingOAuth>();
  private heartbeat: HeartbeatManager;
  private debounceMap = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; messages: InboundMessage[] }
  >();
  private readonly DEBOUNCE_MS = 600;
  private lastMessageAt = new Map<string, Date>();

  constructor(registry: ChannelRegistry, config: GatewayConfig) {
    this.registry = registry;
    this.config = config;
    this.sessions = new SessionManager({
      defaultWorkdir: config.workdir,
      worktreesEnabled: config.worktrees ?? false,
    });
    this.scheduler = new Scheduler(this.fireScheduledTask.bind(this));
    this.heartbeat = new HeartbeatManager(this.fireHeartbeat.bind(this));
  }

  async start(): Promise<void> {
    log.info("Starting Hydra gateway...");
    this.registry.onMessage(this.handleMessage.bind(this));
    this.registry.onEvent(this.handleEvent.bind(this));
    await this.registry.startAll();
    this.scheduler.start();
    this.heartbeat.start();
    this.startSelfReviewLoop();
    this.startSelfAwarenessRefresh();
    this.startHealthCheckLoop();
    startFactSweepLoop();
    // Auto-load tokens from codex CLI if available
    const synced = syncFromCodexCli();
    if (synced) log.info(`[chatgpt] Auto-synced account "${synced.label}" from ~/.codex/auth.json`);
    const idleMs = this.config.sessionIdleMs ?? 30 * 60 * 1000;
    this.sweepTimer = setInterval(
      () => this.sessions.sweepIdle(idleMs),
      5 * 60 * 1000,
    );
    log.info(
      `Gateway running — channels: [${this.registry
        .getAll()
        .map((c) => c.id)
        .join(", ")}]`,
    );
  }

  private selfReviewTimer?: NodeJS.Timeout;

  private selfAwarenessWorkdir?: string;

  private startSelfAwarenessRefresh(): void {
    setInterval(() => {
      if (this.selfAwarenessWorkdir) writeSelfAwareness(this.selfAwarenessWorkdir);
    }, 15 * 60 * 1000);
  }

  private startHealthCheckLoop(): void {
    startHealthCheckLoop((report) => {
      const ownerIds = (process.env.HYDRA_OWNER_IDS ?? "").split(",").filter(Boolean);
      for (const ownerId of ownerIds) {
        const [channelId, senderId] = ownerId.split(":");
        const ch = this.registry.get(channelId as any);
        if (!ch) continue;
        ch.send({ threadId: senderId, text: `🏥 Health alert:
${report}` }).catch(() => {});
      }
    });
  }

  private startSelfReviewLoop(): void {
    const intervalHours = parseInt(process.env.HYDRA_REVIEW_INTERVAL_HOURS ?? "6", 10);
    if (intervalHours <= 0) return;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    log.info(`Self-review loop: every ${intervalHours}h`);
    this.selfReviewTimer = setInterval(async () => {
      log.info("[self-review] scheduled review starting");
      try {
        const result = await runSelfReview();
        if (!result.changed) return;
        // Notify owner on all registered channels
        const ownerIds = (process.env.HYDRA_OWNER_IDS ?? "").split(",").filter(Boolean);
        for (const ownerId of ownerIds) {
          const [channelId, senderId] = ownerId.split(":");
          const channel = this.registry.get(channelId as any);
          if (!channel) continue;
          const msg = `🤖 Self-review complete — I improved myself:\n\n${result.summary}${result.willRestart ? "\n\n♻️ Restarting to apply changes..." : ""}`.slice(0, 3800);
          await channel.send({ threadId: senderId, text: msg }).catch(() => {});
        }
      } catch (e) {
        log.error(`[self-review] scheduled review failed: ${e}`);
      }
    }, intervalMs);
  }

  async stop(): Promise<void> {
    log.info("Stopping Hydra gateway...");
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.selfReviewTimer) clearInterval(this.selfReviewTimer);
    this.scheduler.stop();
    this.heartbeat.stop();
    for (const [, ctrl] of this.activeRuns) ctrl.abort();
    await this.registry.stopAll();
    await stopServer();
    log.info("Gateway stopped.");
  }

  private isOwner(channelId: string, senderId: string): boolean {
    const owners = (process.env.HYDRA_OWNER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return owners.some(
      (o) => o === `${channelId}:${senderId}` || o === senderId,
    );
  }

  private getOwnerIds(): string[] {
    return (process.env.HYDRA_OWNER_IDS ?? "")
      .split(",")
      .map((s) => {
        const parts = s.trim().split(":");
        return parts[parts.length - 1];
      })
      .filter(Boolean);
  }

  /** Strip [SAVE:], [RESTART], [SUBAGENT:] tags, apply them, return clean text */
  private async processAiResponse(
    text: string,
    workdir: string,
    channelId: string,
    threadId: string,
  ): Promise<string> {
    const { clean, tags, shouldRestart } = parseSaveTags(text);
    for (const tag of tags) {
      applySaveTag(tag, workdir, channelId, threadId);
    }
    if (shouldRestart) scheduleSelfRestart();

    // Strip [CONFIDENCE: N%] tag and log score
    const { score: confScore, clean: afterConf } = extractConfidence(clean);
    if (confScore !== null) {
      logConfidence(confScore, "response", "ai", channelId, "");
    }

    // Extract [GOAL:] / [GOAL_DONE:] tags
    const { clean: afterGoals } = extractGoalTags(afterConf, channelId, threadId);

    // Extract [DECISION:] tags
    const { clean: afterDecisions } = extractDecisionTags(afterGoals, channelId);

    // Extract [FACT:] tags
    const { clean: afterFacts } = extractFactTags(afterDecisions, channelId, threadId);

    // Run [SUBAGENT: task1 | task2 | task3] fan-outs
    const subagentPattern = /\[SUBAGENT:\s*([^\]]+)\]/gi;
    let result = afterFacts;
    const subagentMatches = [...afterFacts.matchAll(subagentPattern)];
    for (const match of subagentMatches) {
      const tasks = match[1].split('|').map(t => t.trim()).filter(Boolean);
      if (tasks.length === 0 || !isCodexPoolConfigured()) continue;
      try {
        log.info(`[subagent] fanning out ${tasks.length} task(s) to ChatGPT pool`);
        const results = await callSubagentsParallel(tasks);
        const formatted = results.map((r, i) => `**Subagent ${i+1}:** ${r}`).join('\n\n');
        result = result.replace(match[0], `\n\n---\n${formatted}\n---`);
      } catch (e) {
        result = result.replace(match[0], `[subagent error: ${e}]`);
      }
    }
    return result;
  }

  // ── Inbound debounce ─────────────────────────────────────────────────────────
  private async handleMessage(message: InboundMessage): Promise<void> {
    const text = message.text.trim();
    if (text.startsWith("/")) return this.processMessage(message);

    const key = `${message.channelId}:${message.senderId}`;
    const existing = this.debounceMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
    } else {
      this.debounceMap.set(key, { messages: [message], timer: 0 as any });
    }

    const entry = this.debounceMap.get(key)!;
    entry.timer = setTimeout(() => {
      this.debounceMap.delete(key);
      const combined = entry.messages;
      if (combined.length === 1) {
        this.processMessage(combined[0]).catch((e) =>
          log.error("processMessage error:", e),
        );
      } else {
        const merged: InboundMessage = {
          ...combined[combined.length - 1],
          text: combined
            .map((m) => m.text)
            .filter(Boolean)
            .join("\n"),
          images: combined.flatMap((m) => m.images ?? []),
        };
        this.processMessage(merged).catch((e) =>
          log.error("processMessage error:", e),
        );
      }
    }, this.DEBOUNCE_MS);
  }

  private async processMessage(message: InboundMessage): Promise<void> {
    const channel = this.registry.get(message.channelId);
    if (!channel) return;
    const text = message.text.trim();

    // ── Pairing check ─────────────────────────────────────────────────────────
    if (
      !this.isOwner(message.channelId, message.senderId) &&
      !CMD_APPROVE.test(text)
    ) {
      if (!isAllowed(message.channelId, message.senderId)) {
        const { code, isNew } = upsertPairingRequest(
          message.channelId,
          message.senderId,
        );
        if (isNew) {
          await channel.send({
            threadId: message.threadId,
            text: `Hi! I don't recognize you.\n\nTo get access, share this code with the bot owner:\n${code}\n\nTell them to run:\n/approve ${message.channelId} ${code}\n\nYour ID: ${message.senderId}`,
          });
        }
        return;
      }
    }

    await message.setReaction?.("👀").catch(() => {});

    // ── Built-in commands ─────────────────────────────────────────────────────
    if (CMD_HELP.test(text)) {
      await channel.send({
        threadId: message.threadId,
        text: [
          "Hydra commands:",
          "/remember <note> — save to memory",
          "/forget — clear memory for this thread",
          "/search <query> — search memory",
          "/schedule <cron|ISO> <prompt> — schedule a task",
          "/unschedule <id> — remove scheduled task",
          "/tasks — list scheduled tasks",
          "/approve <channelId> <code> — approve a pairing request",
          "/revoke <channelId> <userId> — revoke access",
          "/pending [channelId] — list pending pairing requests",
          "/opencode-login — connect Claude account via OAuth (owner only)",
          "/opencode-code <code> — complete Claude OAuth login",
          "/claude-key <sk-ant-...> — set Anthropic API key (owner only)",
          "/claude-status — check auth status",
          "/copilot-login — connect GitHub Copilot",
          "/copilot-status — check Copilot auth status",
          "/model [name] — show or switch AI model",
          "/vision-usage — check vision budget usage",
          "/status — show active provider, model, memory stats",
          "/link [accountId] — link identity for cross-channel sessions",
          "/handoff <channelId> — send session summary to another channel",
          "/diff — show git diff of current worktree",
          "/rollback — git stash pop in current worktree",
          "/restart — restart the bot daemon (applies code changes)",
          "/ping — check if the bot is alive",
          "/fast <msg> — quick chat (no OpenCode overhead)",
          "/code <msg> — force code route",
          "/computer <task> — control the Mac desktop",
          "",
          "Or just send any message to talk to the AI.",
        ].join("\n"),
      });
      return;
    }

    if (CMD_FORGET.test(text)) {
      writeMemory(message.channelId, message.threadId, "");
      clearHistory(message.channelId, message.threadId);
      await channel.send({
        threadId: message.threadId,
        text: "Memory cleared.",
      });
      return;
    }

    const searchMatch = CMD_SEARCH.exec(text);
    if (searchMatch) {
      const results = searchMemory(message.channelId, searchMatch[1]);
      await channel.send({ threadId: message.threadId, text: results });
      return;
    }

    const rememberMatch = CMD_REMEMBER.exec(text);
    if (rememberMatch) {
      appendMemory(message.channelId, message.threadId, rememberMatch[1]);
      await channel.send({ threadId: message.threadId, text: "Remembered." });
      return;
    }

    if (CMD_TASKS.test(text)) {
      const tasks = this.scheduler.list(message.channelId, message.threadId);
      if (!tasks.length)
        await channel.send({
          threadId: message.threadId,
          text: "No scheduled tasks.",
        });
      else
        await channel.send({
          threadId: message.threadId,
          text: tasks
            .map(
              (t) =>
                `${t.id} — ${t.prompt.slice(0, 60)} — next: ${t.nextRunAt.toISOString()}`,
            )
            .join("\n"),
        });
      return;
    }

    const unschedMatch = CMD_UNSCHEDULE.exec(text);
    if (unschedMatch) {
      const removed = this.scheduler.remove(unschedMatch[1]);
      await channel.send({
        threadId: message.threadId,
        text: removed ? "Task removed." : "Task not found.",
      });
      return;
    }

    const schedMatch = CMD_SCHEDULE.exec(text);
    if (schedMatch) {
      await this.handleScheduleCommand(message, schedMatch[1]);
      return;
    }

    const approveMatch = CMD_APPROVE.exec(text);
    if (approveMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can approve pairing.",
        });
        return;
      }
      const result = approvePairing(approveMatch[1], approveMatch[2]);
      await channel.send({
        threadId: message.threadId,
        text: result.ok
          ? `Approved sender ${result.senderId} on ${approveMatch[1]}.`
          : "Code not found or expired.",
      });
      return;
    }

    const revokeMatch = CMD_REVOKE.exec(text);
    if (revokeMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can revoke access.",
        });
        return;
      }
      const ok = revokePairing(revokeMatch[1], revokeMatch[2]);
      await channel.send({
        threadId: message.threadId,
        text: ok ? "Access revoked." : "Sender not found.",
      });
      return;
    }

    const pendingMatch = CMD_PENDING.exec(text);
    if (pendingMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can list pending requests.",
        });
        return;
      }
      const cid = pendingMatch[1] ?? message.channelId;
      const requests = listPendingRequests(cid);
      if (!requests.length)
        await channel.send({
          threadId: message.threadId,
          text: `No pending requests for ${cid}.`,
        });
      else
        await channel.send({
          threadId: message.threadId,
          text: requests
            .map((r) => `${r.id} — code: ${r.code} — expires: ${r.expiresAt}`)
            .join("\n"),
        });
      return;
    }

    if (CMD_LOGIN.test(text)) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can run this command.",
        });
        return;
      }
      const { url, verifier } = buildAuthUrl();
      const oauthKey = `${message.channelId}:${message.senderId}`;
      this.pendingOAuth.set(oauthKey, { verifier, createdAt: Date.now() });
      await channel.send({
        threadId: message.threadId,
        text: [
          "Claude Account Login",
          "",
          "1. Open this URL and sign in:",
          url,
          "",
          "2. Send the code back with:",
          "/opencode-code <paste-the-code>",
        ].join("\n"),
      });
      return;
    }

    const oauthCodeMatch = CMD_OAUTH_CODE.exec(text);
    if (oauthCodeMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can run this command.",
        });
        return;
      }
      const oauthKey = `${message.channelId}:${message.senderId}`;
      const pending = this.pendingOAuth.get(oauthKey);
      if (!pending) {
        await channel.send({
          threadId: message.threadId,
          text: "No pending login. Run /opencode-login first.",
        });
        return;
      }
      if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
        this.pendingOAuth.delete(oauthKey);
        await channel.send({
          threadId: message.threadId,
          text: "Login expired. Run /opencode-login again.",
        });
        return;
      }
      await channel.send({
        threadId: message.threadId,
        text: "Exchanging code...",
      });
      try {
        const result = await exchangeCode(oauthCodeMatch[1], pending.verifier);
        this.pendingOAuth.delete(oauthKey);
        saveResult(result);
        if (result.type === "api_key") {
          process.env.ANTHROPIC_API_KEY = result.apiKey;
          await channel.send({
            threadId: message.threadId,
            text: `Claude API key saved!\nKey: ...${result.apiKey.slice(-8)}\n\nDelete this message for security.`,
          });
        } else {
          await channel.send({
            threadId: message.threadId,
            text: "Claude OAuth tokens saved! OpenCode is now authenticated.",
          });
        }
      } catch (e) {
        await channel.send({
          threadId: message.threadId,
          text: `Login failed: ${e instanceof Error ? e.message : e}`,
        });
      }
      return;
    }

    // /chatgpt_login label sk-...  OR  /chatgpt_key label sk-...
    const chatgptKeyMatch = CMD_CHATGPT_KEY.exec(text);
    if (chatgptKeyMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: "Only the bot owner can add ChatGPT accounts." });
        return;
      }
      const [, label, apiKey] = chatgptKeyMatch;
      try {
        await addKeyToPool(label, apiKey);
        const accounts = listPoolAccounts();
        await channel.send({ threadId: message.threadId, text: `✅ ChatGPT subagent "${label}" added! Pool: ${accounts.length} account(s).\nUse /chatgpt_accounts to list all.` });
      } catch (e) {
        await channel.send({ threadId: message.threadId, text: `Failed to add account: ${e}` });
      }
      return;
    }

    // /chatgpt_login — show Mac terminal script (Cloudflare blocks server-side auth)
    const chatgptLoginMatch = CMD_CHATGPT.exec(text);
    if (chatgptLoginMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: "Only the bot owner can add ChatGPT accounts." });
        return;
      }
      const label = chatgptLoginMatch[1]?.trim() || "account1";
      const script = [
        "node --input-type=module << 'EOF'",
        "const r1=await fetch('https://auth.openai.com/codex/device',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'client_id=app_EMoamEEZ73f0CkXaXp7hrann&scope=openid+profile+email+offline_access'});",
        "const d=await r1.json();",
        "console.log('Visit: '+d.verification_uri+'  Code: '+d.user_code);",
        "console.log('Press Enter after approving...');",
        "await new Promise(r=>process.stdin.once('data',r));",
        "let t={};for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,3000));const r2=await fetch('https://auth.openai.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'client_id=app_EMoamEEZ73f0CkXaXp7hrann&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code='+d.device_code});t=await r2.json();if(t.access_token)break;}",
        `if(t.access_token){console.log('/chatgpt_token ${label} '+t.access_token+(t.refresh_token?' '+t.refresh_token:''));}else{console.log('Error:',t.error);}`,
        "EOF",
      ].join("\n");
      await channel.send({
        threadId: message.threadId,
        text: `ChatGPT OAuth for "${label}"\n\nRun this in your Mac terminal, then paste the /chatgpt_token command it prints:\n\n\`\`\`\n${script}\n\`\`\``,
      });
      return;
    }

    // /chatgpt_token label <accessToken> [refreshToken] — save token from Mac auth script
    const CMD_CHATGPT_TOKEN_RE = /^\/chatgpt[-_]token\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i;
    const chatgptTokenMatch = CMD_CHATGPT_TOKEN_RE.exec(text);
    if (chatgptTokenMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: "Only the bot owner can add ChatGPT accounts." });
        return;
      }
      const [, tLabel, accessToken, refreshToken] = chatgptTokenMatch;
      saveOAuthAccount(tLabel, { accessToken, refreshToken, expiresAt: Date.now() + 3600 * 1000 });
      const accounts = listPoolAccounts();
      await channel.send({ threadId: message.threadId, text: `✅ ChatGPT "${tLabel}" connected! Pool: ${accounts.length} account(s).` });
      return;
    }


    if (CMD_CHATGPT_SYNC.test(text)) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: "Only the bot owner can sync accounts." });
        return;
      }
      const account = syncFromCodexCli();
      if (!account) {
        await channel.send({ threadId: message.threadId, text: "~/.codex/auth.json not found on bob.\n\nRun `codex login` on the Mac Mini terminal first, then /chatgpt_sync." });
        return;
      }
      const accounts = listPoolAccounts();
      const exp = account.expiresAt ? new Date(account.expiresAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
      await channel.send({ threadId: message.threadId, text: `✅ Synced "${account.label}" from codex CLI\nToken expires: ${exp} UTC\nPool: ${accounts.length} account(s)` });
      return;
    }

    if (CMD_CHATGPT_STATUS.test(text)) {
      if (isCodexConfigured()) {
        await channel.send({
          threadId: message.threadId,
          text: "ChatGPT (GPT-4o): connected via OAuth",
        });
      } else {
        await channel.send({
          threadId: message.threadId,
          text: "ChatGPT not configured. Run /chatgpt_login",
        });
      }
      return;
    }

    if (CMD_CHATGPT_ACCOUNTS.test(text)) {
      const accounts = listPoolAccounts();
      if (accounts.length === 0) {
        await channel.send({ threadId: message.threadId, text: "No ChatGPT accounts in pool. Add one with /chatgpt_login" });
      } else {
        const lines = accounts.map((a, i) =>
          `${i + 1}. [${a.id.slice(0, 6)}] ${a.label} — ${a.callCount} calls${a.rateLimitedUntil ? ' ⚠️ rate-limited' : ''}`
        );
        await channel.send({ threadId: message.threadId, text: `ChatGPT pool (${accounts.length} accounts):\n${lines.join('\n')}` });
      }
      return;
    }

    const chatgptRemoveMatch = CMD_CHATGPT_REMOVE.exec(text);
    if (chatgptRemoveMatch) {
      const removed = removeAccountFromPool(chatgptRemoveMatch[1]);
      await channel.send({ threadId: message.threadId, text: removed ? `Removed account ${chatgptRemoveMatch[1]}` : `Account ${chatgptRemoveMatch[1]} not found` });
      return;
    }

    if (CMD_COPILOT.test(text)) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can configure Copilot.",
        });
        return;
      }
      await channel.send({
        threadId: message.threadId,
        text: "Starting GitHub Copilot login...\n(check the server terminal for the device code)",
      });
      githubCopilotLogin()
        .then(() =>
          channel
            .send({
              threadId: message.threadId,
              text: "GitHub Copilot connected!",
            })
            .catch(() => {}),
        )
        .catch((e) =>
          channel
            .send({
              threadId: message.threadId,
              text: `Copilot login failed: ${e}`,
            })
            .catch(() => {}),
        );
      return;
    }

    if (CMD_COPILOT_STATUS.test(text)) {
      if (!isCopilotConfigured()) {
        await channel.send({
          threadId: message.threadId,
          text: "Copilot not configured. Run /copilot-login first.",
        });
      } else {
        const creds = await resolveCopilotCredentials().catch(() => null);
        if (creds) {
          const expiresIn = Math.round((creds.expiresAt - Date.now()) / 60_000);
          await channel.send({
            threadId: message.threadId,
            text: `Copilot active\nModel: ${process.env.HYDRA_COPILOT_MODEL ?? "claude-sonnet-4.6"}\nToken expires in: ${expiresIn} min`,
          });
        } else {
          await channel.send({
            threadId: message.threadId,
            text: "Copilot configured but token refresh failed.",
          });
        }
      }
      return;
    }

    const modelMatch = CMD_MODEL.exec(text);
    if (modelMatch) {
      const CLAUDE_MODELS = [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-sonnet-4-5",
        "claude-haiku-4-5-20251001",
      ];
      const COPILOT_MODELS = [
        "claude-sonnet-4.6",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4.1-mini",
        "o3-mini",
      ];
      const OLLAMA_MODELS = [
        "nemotron-3-super",      // 120B MoE, 12B active, 256K ctx — research
        "devstral-2:123b",       // 123B — coding specialist
        "devstral-small-2:24b",  // 24B — fast coding
        "deepseek-v3.2",         // deep reasoning
        "deepseek-v3.1:671b",    // 671B deepseek
        "gpt-oss:120b",          // OpenAI open-source 120B (codex)
        "gpt-oss:20b",           // OpenAI open-source 20B (codex, fast)
        "qwen3-next:80b",        // 80B — fast + smart
        "qwen3-coder:480b",      // 480B coding model
        "mistral-large-3:675b",  // 675B — most capable
        "kimi-k2:1t",            // 1T params — hardest problems
        "cogito-2.1:671b",       // 671B reasoning
        "nemotron-3-nano:30b",   // 30B — fast
        "nemotron-mini",         // local only
      ];
      const usingCopilot = isCopilotConfigured() && !isClaudeConfigured();
      const currentClaude = process.env.HYDRA_CLAUDE_MODEL ?? (usingCopilot ? "claude-sonnet-4.6" : "claude-sonnet-4-6");
      const currentOllama = process.env.HYDRA_OLLAMA_MODEL ?? (isOllamaCloud() ? "nemotron-3-super" : "nemotron-mini");
      const fmtC = (m: string) => (m === currentClaude ? `${m} ← active` : m);
      const fmtO = (m: string) => (m === currentOllama ? `${m} ← active` : m);
      if (!modelMatch[1]) {
        await channel.send({
          threadId: message.threadId,
          text: [
            "── Claude (coding/chat) ──",
            ...CLAUDE_MODELS.map(fmtC),
            "",
            "── GitHub Copilot ──",
            ...COPILOT_MODELS.map(fmtC),
            "",
            `── Ollama ${isOllamaCloud() ? "Cloud" : "Local"} (research) ──`,
            ...OLLAMA_MODELS.map(fmtO),
            "",
            "Switch: /model <name>",
            "Example: /model nemotron-3-super:120b",
          ].join("\n"),
        });
        return;
      }
      const requested = modelMatch[1].toLowerCase();
      // Check Ollama models first
      const ollamaMatch = OLLAMA_MODELS.find(
        (m) => m.toLowerCase() === requested || m.toLowerCase().includes(requested)
      );
      if (ollamaMatch) {
        process.env.HYDRA_OLLAMA_MODEL = ollamaMatch;
        const prefPath = path.join(os.homedir(), ".hydra", "preferences.json");
        let prefs: Record<string, string> = {};
        try { prefs = JSON.parse(fs.readFileSync(prefPath, "utf8")); } catch {}
        prefs.HYDRA_OLLAMA_MODEL = ollamaMatch;
        fs.mkdirSync(path.dirname(prefPath), { recursive: true });
        fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2));
        await channel.send({ threadId: message.threadId, text: `Ollama model → ${ollamaMatch}` });
        return;
      }
      // Check Claude/Copilot models
      const claudeMatch = [...CLAUDE_MODELS, ...COPILOT_MODELS].find(
        (m) => m.toLowerCase() === requested || m.toLowerCase().includes(requested),
      );
      if (!claudeMatch) {
        await channel.send({ threadId: message.threadId, text: `Unknown model "${requested}". Run /model to see options.` });
        return;
      }
      process.env.HYDRA_CLAUDE_MODEL = claudeMatch;
      const prefPath = path.join(os.homedir(), ".hydra", "preferences.json");
      let prefs: Record<string, string> = {};
      try { prefs = JSON.parse(fs.readFileSync(prefPath, "utf8")); } catch {}
      prefs.HYDRA_CLAUDE_MODEL = claudeMatch;
      fs.mkdirSync(path.dirname(prefPath), { recursive: true });
      fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2));
      await channel.send({ threadId: message.threadId, text: `Claude model → ${claudeMatch}` });
      return;
    }

    const claudeKeyMatch = CMD_CLAUDE_KEY.exec(text);
    if (claudeKeyMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can set the API key.",
        });
        return;
      }
      const key = claudeKeyMatch[1].trim();
      if (!key.startsWith("sk-ant-")) {
        await channel.send({
          threadId: message.threadId,
          text: "Invalid key format — should start with sk-ant-",
        });
        return;
      }
      saveApiKey(key);
      process.env.ANTHROPIC_API_KEY = key;
      await channel.send({
        threadId: message.threadId,
        text: `Claude API key saved! Key ends in: ...${key.slice(-6)}\n\nDelete this message for security.`,
      });
      return;
    }

    if (CMD_CLAUDE_STATUS.test(text)) {
      const model = process.env.HYDRA_CLAUDE_MODEL ?? "claude-sonnet-4-6";
      if (isClaudeConfigured()) {
        const apiKey = process.env.ANTHROPIC_API_KEY
        await channel.send({
          threadId: message.threadId,
          text: apiKey
            ? `Claude active (API key)\nModel: ${model}\nKey: ...${apiKey.slice(-6)}`
            : `Claude active (OAuth via opencode)\nModel: ${model}`,
        });
      } else if (hasOpencodeAuth()) {
        await channel.send({
          threadId: message.threadId,
          text: `Claude OAuth tokens active (via opencode)\nModel: ${model}`,
        });
      } else {
        const oauthToken = getValidClaudeToken();
        await channel.send({
          threadId: message.threadId,
          text: oauthToken
            ? "OAuth token found but cannot call API directly.\nRun /opencode-login."
            : "No Claude credentials\n• /opencode-login — log in with Claude\n• /claude-key sk-ant-... — paste a key",
        });
      }
      return;
    }

    if (CMD_VISION_USAGE.test(text)) {
      const { count, budget, remaining } = getVisionUsageStatus();
      await channel.send({
        threadId: message.threadId,
        text: `Vision usage today: ${count}/${budget} calls used, ${remaining} remaining.`,
      });
      return;
    }

    if (CMD_STATUS.test(text)) {
      const botName = process.env.HYDRA_BOT_NAME ?? "Hydra";
      const model = process.env.HYDRA_CLAUDE_MODEL ?? "claude-sonnet-4-6";
      const lines: string[] = [`${botName} — status`];
      if (isClaudeConfigured()) {
        lines.push(`Provider: Claude API (${model})`);
        const key = process.env.ANTHROPIC_API_KEY; lines.push(key ? `Key: ...${key.slice(-6)}` : "Auth: OAuth (opencode)");
      } else if (isCodexConfigured()) {
        lines.push("Provider: ChatGPT OAuth");
      } else if (isCopilotConfigured()) {
        lines.push(
          `Provider: GitHub Copilot (${process.env.HYDRA_COPILOT_MODEL ?? "claude-sonnet-4.6"})`,
        );
      } else {
        lines.push("Provider: OpenCode (big-pickle)");
      }
      const { getHistoryLength } = await import("./history.js");
      const histLen = getHistoryLength(message.channelId, message.threadId);
      const memContent = readMemory(message.channelId, message.threadId);
      const memLines = memContent
        ? memContent.split("\n").filter(Boolean).length
        : 0;
      lines.push(`History: ${histLen} messages this session`);
      lines.push(`Memory: ${memLines} lines`);
      lines.push(`Channel: ${message.channelId}`);
      lines.push(
        `Owner: ${this.isOwner(message.channelId, message.senderId) ? "yes" : "no"}`,
      );
      await channel.send({
        threadId: message.threadId,
        text: lines.join("\n"),
      });
      return;
    }

    const linkMatch = CMD_LINK.exec(text);
    if (linkMatch) {
      const accountId =
        linkMatch[1] ?? `${message.channelId}:${message.senderId}`;
      this.sessions.linkAccount(message.channelId, message.senderId, accountId);
      await channel.send({
        threadId: message.threadId,
        text: `Linked! Account ID: ${accountId}`,
      });
      return;
    }

    const handoffMatch = CMD_HANDOFF.exec(text);
    if (handoffMatch) {
      const targetChannel = this.registry.get(handoffMatch[1] as any);
      if (!targetChannel) {
        await channel.send({
          threadId: message.threadId,
          text: `Channel ${handoffMatch[1]} not found.`,
        });
        return;
      }
      const session = this.sessions.getOrCreate(message);
      const summary = session.opencodeSessionId
        ? `Session handoff from ${message.channelId}\nSession: ${session.opencodeSessionId}\nWorkdir: ${session.workdir}`
        : `Handoff from ${message.channelId} — no active session yet.`;
      await targetChannel.send({ threadId: message.threadId, text: summary });
      await channel.send({
        threadId: message.threadId,
        text: `Summary sent to ${handoffMatch[1]}.`,
      });
      return;
    }

    if (CMD_PROVIDERS.test(text)) {
      const lines: string[] = ['Providers:']
      // Ollama
      const { isOllamaAvailable, listOllamaModels, getOllamaModel, getOllamaBaseUrl } = await import('./copilot-chat.js')
      const ollamaUp = await isOllamaAvailable()
      if (ollamaUp) {
        const models = await listOllamaModels()
        lines.push(`✅ Ollama (${getOllamaBaseUrl()}) — ${models.length} model(s): ${models.slice(0, 3).join(', ')}`)
        lines.push(`   Chat/fast model: ${getOllamaModel()}`)
      } else {
        lines.push(`❌ Ollama — not running (brew install ollama && ollama serve)`)
        lines.push(`   Set OLLAMA_HOST=http://host:11434 for remote`)
      }
      // Claude OAuth
      if (isClaudeConfigured()) {
        const apiKey = process.env.ANTHROPIC_API_KEY
        lines.push(`✅ Claude — ${apiKey ? 'API key' : 'OAuth (opencode)'}`)
      } else {
        lines.push('❌ Claude — not configured')
      }
      // Codex
      if (isCodexConfigured()) lines.push('✅ ChatGPT (Codex OAuth)')
      else lines.push('❌ ChatGPT — not configured')
      // Copilot
      if (isCopilotConfigured()) lines.push('✅ GitHub Copilot')
      else lines.push('❌ GitHub Copilot — not configured')
      // Routing summary
      lines.push('')
      lines.push('Active routing:')
      lines.push(`  chat/fast → ${ollamaUp ? 'Ollama' : isClaudeConfigured() ? 'Claude OAuth' : 'first available'}`)
      lines.push(`  code → OpenCode (Claude OAuth)`)
      lines.push(`  vision → ${isClaudeConfigured() ? 'Claude OAuth' : isCopilotConfigured() ? 'Copilot' : 'none'}`)
      await channel.send({ threadId: message.threadId, text: lines.join('\n') })
      return
    }

        if (CMD_RESTART.test(text)) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({
          threadId: message.threadId,
          text: "Only the bot owner can restart.",
        });
        return;
      }
      await channel.send({
        threadId: message.threadId,
        text: "Restarting in 2s...",
      });
      scheduleSelfRestart();
      return;
    }

    if (CMD_PING.test(text)) {
      await channel.send({ threadId: message.threadId, text: "pong" });
      return;
    }

    if (CMD_DIFF.test(text)) {
      const session = this.sessions.getOrCreate(message);
      const diff = await getWorktreeDiff(session.workdir);
      const truncated =
        diff.length > 3000 ? diff.slice(0, 3000) + "\n...(truncated)" : diff;
      await channel.send({
        threadId: message.threadId,
        text: `\`\`\`diff\n${truncated}\n\`\`\``,
      });
      return;
    }

    if (CMD_ROLLBACK.test(text)) {
      const session = this.sessions.getOrCreate(message);
      await channel.send({
        threadId: message.threadId,
        text: await rollbackWorktree(session.workdir),
      });
      return;
    }

    const prMatch = PR_PATTERN.exec(text);
    if (prMatch && this.config.worktrees) {
      await this.handlePRCheckout(message, parseInt(prMatch[1], 10));
      return;
    }

    if (CMD_REVIEW.test(text)) {
      const session = this.sessions.getOrCreate(message);
      await channel.send({ threadId: message.threadId, text: "🔍 Starting self-review..." });
      const result = await runSelfReview(session.workdir);
      const msg = result.changed
        ? `✅ Self-review complete — ${result.filesModified.length} file(s) improved${result.willRestart ? "\n♻️ Restarting to apply changes..." : ""}\n\n${result.summary}`.slice(0, 3800)
        : `✅ ${result.summary}`.slice(0, 3800);
      await channel.send({ threadId: message.threadId, text: msg });
      return;
    }

    if (CMD_REVIEW_STATS.test(text)) {
      const stats = getReviewStats();
      const lines = [
        `Total reviews run: ${stats.totalReviews}`,
        `Last review: ${stats.lastRunAt}`,
        '',
        'Recent improvements:',
        ...stats.recentImprovements.map((s, i) => `${i + 1}. ${s}`),
      ];
      await channel.send({ threadId: message.threadId, text: lines.join('\n') || 'No reviews run yet.' });
      return;
    }

    // Extract feedback/corrections before routing to AI
    const prevBot = undefined; // future: pass last bot message
    extractFeedback(message.senderId, message.channelId, text, prevBot);

    if (CMD_STATS.test(text)) {
      const { getStatsSummary } = await import("./metrics.js");
      const conf = getConfidenceSummary();
      await channel.send({ threadId: message.threadId, text: conf ? getStatsSummary() + `

${conf}` : getStatsSummary() });
      return;
    }

    if (CMD_HEALTH.test(text)) {
      await channel.send({ threadId: message.threadId, text: "🔍 Running health checks..." });
      const tools = await runHealthChecks();
      await channel.send({ threadId: message.threadId, text: formatHealthReport(tools) });
      return;
    }

    if (CMD_GOALS.test(text)) {
      const goals = listGoals(message.channelId, message.threadId);
      await channel.send({ threadId: message.threadId, text: formatGoalsList(goals) });
      return;
    }

    const goalDoneMatch = CMD_GOAL_DONE.exec(text);
    if (goalDoneMatch) {
      const ok = completeGoal(parseInt(goalDoneMatch[1], 10));
      await channel.send({ threadId: message.threadId, text: ok ? `✅ Goal ${goalDoneMatch[1]} done!` : "Goal not found." });
      return;
    }

    const goalAddMatch = CMD_GOAL_ADD.exec(text);
    if (goalAddMatch) {
      const g = addGoal(goalAddMatch[1], message.channelId, message.threadId);
      await channel.send({ threadId: message.threadId, text: `🎯 Goal [${g.id}] added: ${g.text}` });
      return;
    }

    if (CMD_TUNE.test(text)) {
      await channel.send({ threadId: message.threadId, text: getTuningStatus() });
      return;
    }

    if (CMD_AUDIT.test(text)) {
      const entries = getRecentAudit(15);
      await channel.send({ threadId: message.threadId, text: formatAuditLog(entries) });
      return;
    }

    if (CMD_FACTS.test(text)) {
      const facts = listActiveFacts(message.channelId, message.threadId);
      await channel.send({ threadId: message.threadId, text: formatFactsList(facts) });
      return;
    }

    if (CMD_CAN.test(text)) {
      const caps = buildCapabilities();
      await channel.send({ threadId: message.threadId, text: formatCapabilities(caps) });
      return;
    }

    await this.runAgentMessage(message);
  }

  private async runAgentMessage(
    message: InboundMessage,
    overridePrompt?: string,
  ): Promise<void> {
    const channel = this.registry.get(message.channelId);
    if (!channel) return;

    if (!hasAnyCredentials()) {
      await channel.send({ threadId: message.threadId, text: NO_CREDS_MSG });
      return;
    }

    const session = this.sessions.getOrCreate(message);
    const { key } = session;

    await this.sessions.ensureWorktree(session);

    this.selfAwarenessWorkdir = session.workdir;
    // Inject LESSONS.md and GOALS.md so AI sees accumulated context
    try {
      const lessonsContent = getLessonsContent();
      fs.writeFileSync(path.join(session.workdir, "LESSONS.md"), lessonsContent);
    } catch {}
    try { writeGoalsFile(session.workdir, message.channelId, message.threadId); } catch {}
    try { writeFactsFile(session.workdir, message.channelId, message.threadId); } catch {}
    try { writeCapabilitiesFile(session.workdir); } catch {}
    ensureWorkspaceFiles(session.workdir, {
      channelId: message.channelId,
      senderId: message.senderId,
      senderName: message.senderName,
      location: process.env.HYDRA_USER_LOCATION,
      timezone: process.env.HYDRA_USER_TIMEZONE,
    });

    this.heartbeat.register({
      channelId: message.channelId,
      threadId: message.threadId,
      senderId: message.senderId,
      workdir: session.workdir,
    });

    // Auto-detect self-updates from user's message (before asking AI)
    const autoTags = detectAutoUpdates(message.text);
    for (const tag of autoTags) {
      applySaveTag(tag, session.workdir, message.channelId, message.threadId);
    }

    // Voice message transcription
    if (message.voiceBase64 && !message.text) {
      await message.setReaction?.("👀").catch(() => {});
      if (!isTranscriptionConfigured()) {
        await channel.send({
          threadId: message.threadId,
          text: "🎤 Voice received but transcription not configured. Set GROQ_API_KEY for free transcription.",
        });
        return;
      }
      const transcript = await transcribeAudio(
        message.voiceBase64,
        message.voiceMimeType ?? "audio/ogg",
      );
      if (!transcript) {
        await channel.send({
          threadId: message.threadId,
          text: "🎤 Could not transcribe voice message.",
        });
        return;
      }
      log.info(`[${key}] Voice transcribed: "${transcript.slice(0, 80)}"`);
      (message as any).text = `🎤 ${transcript}`;
    }

    // Compress memory if it's grown large (async, non-blocking)
    compressMemoryIfNeeded(message.channelId, message.threadId, async (p) => {
      const { callDirect } = await import("./copilot-chat.js");
      return callDirect(p);
    }).catch(() => {});

    const existing = this.activeRuns.get(key);
    if (existing) {
      existing.abort();
    }
    const ctrl = new AbortController();
    this.activeRuns.set(key, ctrl);

    const rawPrompt = overridePrompt ?? message.text;
    const intent = classifyIntent(rawPrompt, !!message.images?.length);
    const prompt = stripIntentPrefix(rawPrompt);
    const ollamaModel = getOllamaModelForIntent(intent);

    const threadKey = `${message.channelId}:${message.threadId}`;
    const lastAt = this.lastMessageAt.get(threadKey);
    const envelope = buildEnvelope(
      message.channelId,
      message.senderName,
      message.timestamp,
      lastAt,
    );
    this.lastMessageAt.set(threadKey, message.timestamp);

    const autoTunePrefix = getAutoTunePrefix();
    const goesToOpenCode = !(
      intent === "fast" ||
      intent === "computer" ||
      ((intent === "chat" || intent === "vision") &&
        (isClaudeConfigured() || isCodexConfigured() || isCopilotConfigured()))
    );
    const memory = readMemory(message.channelId, message.threadId);

    const promptMode =
      intent === "computer" ? "computer" : goesToOpenCode ? "code" : "chat";
    const systemPrompt = (autoTunePrefix ? autoTunePrefix : '') + buildSystemPrompt({
      mode: promptMode,
      channelId: message.channelId,
      senderId: message.senderId,
      senderName: message.senderName,
      ownerIds: this.getOwnerIds(),
      bootstrapFiles: readWorkspaceFiles(session.workdir),
      memory,
      location: process.env.HYDRA_USER_LOCATION,
      timezone: process.env.HYDRA_USER_TIMEZONE,
      currentTime: getCurrentTime(process.env.HYDRA_USER_TIMEZONE),
      includeToolHint: goesToOpenCode,
    }) + CONFIDENCE_INSTRUCTION + GOALS_INSTRUCTION + DECISION_INSTRUCTION + FACTS_INSTRUCTION;

    const contextPrefix = goesToOpenCode
      ? buildMemoryPrompt(message.channelId, message.threadId, true)
      : "";

    // Record user message in conversation history
    appendHistory(
      message.channelId,
      message.threadId,
      message.senderName ?? "user",
      prompt,
    );

    // Fetch web content for any URLs in the message (non-blocking with 15s timeout)
    const urls = extractUrls(prompt);
    const webContext = urls.length ? await buildWebContext(urls) : "";

    // For direct chat, inject conversation history context into the prompt
    const historyPrompt = !goesToOpenCode
      ? buildPromptWithHistory(
          message.channelId,
          message.threadId,
          prompt,
          message.senderName,
        )
      : prompt;

    const fullPrompt = `${envelope}\n${contextPrefix}${webContext}${historyPrompt}`;

    log.info(
      `[${key}] intent=${intent} route=${goesToOpenCode ? "opencode" : ollamaModel ? `ollama:${ollamaModel}` : "direct"} "${prompt.slice(0, 100)}"`,
    );
    logAudit({ type: 'route', action: `${intent} → ${goesToOpenCode ? 'opencode' : ollamaModel ?? 'claude'}`, reason: `provider selected for intent`, channel: message.channelId });
    await message.setReaction?.("🤔").catch(() => {});

    try {
      if (intent === "computer") {
        await this.runComputerTask(message, fullPrompt, channel);
        await message.setReaction?.("👍").catch(() => {});
        return;
      }

      if (!goesToOpenCode) {
        await channel.sendTyping(message.threadId);
        await this.runDirectChat(
          message,
          fullPrompt,
          message.images,
          channel,
          systemPrompt,
          session.workdir,
          ollamaModel,
        );
        await message.setReaction?.("👍").catch(() => {});
        return;
      }

      await channel.sendTyping(message.threadId);
      const placeholderId = await channel.sendAndGetId({
        threadId: message.threadId,
        text: "⏳ working...",
      });

      let accumulated = "";
      let lastEditAt = 0;
      const taskStartedAt = Date.now();

      // Update placeholder every 10s so user knows it's alive
      const taskTicker = setInterval(async () => {
        if (!accumulated && placeholderId) {
          const elapsed = Math.round((Date.now() - taskStartedAt) / 1000);
          await channel.editMessage(message.threadId, placeholderId, `⏳ working... ${elapsed}s`).catch(() => {});
        }
      }, 10_000);

      const _oc_t0 = Date.now();
      let result: Awaited<ReturnType<typeof runSession>>;
      try {
        result = await runSession({
          sessionId: session.opencodeSessionId,
          directory: session.workdir,
          prompt: fullPrompt,
          images: message.images,
          signal: ctrl.signal,
          onChunk: async (text) => {
            accumulated = text;
            const now = Date.now();
            if (placeholderId && now - lastEditAt > 800) {
              await channel
                .editMessage(message.threadId, placeholderId, accumulated + " ▋")
                .catch(() => {});
              lastEditAt = now;
            }
          },
        });
        logCall({ ts: new Date().toISOString(), model: "opencode", provider: "opencode", route: intent, latencyMs: Date.now() - _oc_t0, success: !result.error, errorType: result.error ? "other" : undefined, channel: message.channelId });
      } catch (_ocErr: any) {
        clearInterval(taskTicker);
        logCall({ ts: new Date().toISOString(), model: "opencode", provider: "opencode", route: intent, latencyMs: Date.now() - _oc_t0, success: false, errorType: String(_ocErr).includes("timeout") || String(_ocErr).includes("AbortError") ? "timeout" : "other", channel: message.channelId });
        throw _ocErr;
      }

      clearInterval(taskTicker);
      session.opencodeSessionId = result.sessionId;

      let finalText =
        (result.text || accumulated) +
        (result.error ? `\n\n⚠️ ${result.error}` : "");

      // Strip [SAVE:...] tags from OpenCode response and persist them
      finalText = await this.processAiResponse(
        finalText,
        session.workdir,
        message.channelId,
        message.threadId,
      );

      // Record AI response in conversation history
      appendHistory(
        message.channelId,
        message.threadId,
        process.env.HYDRA_BOT_NAME ?? "agent_smith",
        finalText,
      );

      if (finalText.trim() === NO_REPLY || finalText.trim() === HEARTBEAT_OK) {
        if (placeholderId)
          await channel.deleteMessage?.(message.threadId, placeholderId);
        await message.setReaction?.("👍").catch(() => {});
        return;
      }

      if (placeholderId && finalText.trim()) {
        if (finalText.length > 4000) {
          // Too long to edit — delete placeholder and send chunked
          await channel.deleteMessage?.(message.threadId, placeholderId);
          await channel.send({ threadId: message.threadId, text: finalText });
        } else {
          await channel
            .editMessage(message.threadId, placeholderId, finalText)
            .catch(() => {});
        }
      } else if (finalText.trim()) {
        await channel.send({ threadId: message.threadId, text: finalText });
      } else {
        await channel
          .editMessage(message.threadId, placeholderId, "(no response)")
          .catch(() => {});
      }

      if (result.compacted) {
        await channel.send({
          threadId: message.threadId,
          text: "(context compacted to stay within limits)",
        });
      }

      await message.setReaction?.("👍").catch(() => {});
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      log.error(`[${key}] Error:`, err);
      await message.setReaction?.("👎").catch(() => {});
      await channel
        .send({
          threadId: message.threadId,
          text: "Something went wrong. Please try again.",
          replyToId: message.id,
        })
        .catch(() => {});
    } finally {
      this.activeRuns.delete(key);
    }
  }

  private async runDirectChat(
    message: InboundMessage,
    prompt: string,
    images: string[] | undefined,
    channel: any,
    systemPrompt: string | undefined,
    workdir: string,
    ollamaModel?: string,
  ): Promise<void> {
    const placeholderId = await channel.sendAndGetId({
      threadId: message.threadId,
      text: "⏳",
    });
    try {
      const { callDirect } = await import("./copilot-chat.js");
      const _t0 = Date.now();
      let text: string;
      try {
        text = await callDirect(prompt, images, systemPrompt, ollamaModel);
        logCall({ ts: new Date().toISOString(), model: ollamaModel ?? process.env.HYDRA_CLAUDE_MODEL ?? "unknown", provider: ollamaModel ? "ollama" : "claude", route: "chat", latencyMs: Date.now() - _t0, success: true, channel: message.channelId });
      } catch (_err) {
        const errMsg = String(_err);
        logCall({ ts: new Date().toISOString(), model: ollamaModel ?? "unknown", provider: ollamaModel ? "ollama" : "claude", route: "chat", latencyMs: Date.now() - _t0, success: false, errorType: errMsg.includes("timeout") || errMsg.includes("AbortError") ? "timeout" : errMsg.includes("401") || errMsg.includes("auth") ? "auth" : "other", channel: message.channelId });
        throw _err;
      }

      // Strip [SAVE:...] tags and persist them
      text = await this.processAiResponse(
        text,
        workdir,
        message.channelId,
        message.threadId,
      );

      // Record AI response in conversation history
      appendHistory(
        message.channelId,
        message.threadId,
        process.env.HYDRA_BOT_NAME ?? "agent_smith",
        text,
      );

      if (text.trim() === NO_REPLY || text.trim() === HEARTBEAT_OK) {
        await channel.deleteMessage?.(message.threadId, placeholderId);
        return;
      }

      await channel
        .editMessage(message.threadId, placeholderId, text)
        .catch(() => {
          channel.send({ threadId: message.threadId, text });
        });
    } catch (e) {
      log.error(`[runDirectChat] ${e}`);
      await channel
        .editMessage(message.threadId, placeholderId, `Error: ${e}`)
        .catch(() => {});
    }
  }

  private async runComputerTask(
    message: InboundMessage,
    prompt: string,
    channel: any,
  ): Promise<void> {
    const placeholderId = await channel.sendAndGetId({
      threadId: message.threadId,
      text: "🖥️ starting computer task...",
    });
    try {
      const { runComputerTask } = await import("@hydra/computer-use");
      const result = await runComputerTask({
        instruction: prompt,
        maxIterations: 10,
        onStatus: async (msg) => {
          await channel
            .editMessage(message.threadId, placeholderId, `🖥️ ${msg}`)
            .catch(() => {});
        },
      });
      const summary = result.success
        ? `Done!\n${result.output}`
        : `Failed: ${result.output}`;
      const stats = `\n(${result.iterations} steps, ${result.visionCallsUsed} vision calls)`;
      await channel
        .editMessage(message.threadId, placeholderId, summary + stats)
        .catch(() => {
          channel.send({ threadId: message.threadId, text: summary + stats });
        });
    } catch (e) {
      await channel
        .editMessage(
          message.threadId,
          placeholderId,
          `Computer task error: ${e}`,
        )
        .catch(() => {});
    }
  }

  private async fireHeartbeat(
    target: {
      channelId: string;
      threadId: string;
      senderId: string;
      workdir: string;
    },
    _sendResponse: (text: string) => Promise<void>,
  ): Promise<void> {
    const channel = this.registry.get(target.channelId as any);
    if (!channel || !hasAnyCredentials()) return;

    const session = this.sessions.get(
      buildSessionKey(target.channelId, target.threadId),
    );
    if (!session) return;

    const memory = readMemory(target.channelId, target.threadId);
    const systemPrompt = buildSystemPrompt({
      mode: "chat",
      channelId: target.channelId,
      senderId: target.senderId,
      ownerIds: this.getOwnerIds(),
      bootstrapFiles: readWorkspaceFiles(target.workdir),
      memory,
      location: process.env.HYDRA_USER_LOCATION,
      timezone: process.env.HYDRA_USER_TIMEZONE,
      currentTime: getCurrentTime(process.env.HYDRA_USER_TIMEZONE),
    });

    try {
      const goesToOpenCode = !isClaudeConfigured() && !isCopilotConfigured();
      let response: string;

      if (goesToOpenCode && session.opencodeSessionId) {
        const result = await runSession({
          sessionId: session.opencodeSessionId,
          directory: target.workdir,
          prompt: HEARTBEAT_PROMPT,
        });
        response = result.text;
      } else {
        const { callDirect } = await import("./copilot-chat.js");
        response = await callDirect(HEARTBEAT_PROMPT, undefined, systemPrompt);
      }

      response = await this.processAiResponse(
        response,
        target.workdir,
        target.channelId,
        target.threadId,
      );
      const trimmed = response.trim();
      if (trimmed === HEARTBEAT_OK || trimmed === NO_REPLY || !trimmed) return;
      await channel.send({ threadId: target.threadId, text: response });
    } catch (e) {
      log.warn(`Heartbeat failed: ${e}`);
    }
  }

  private async handleScheduleCommand(
    message: InboundMessage,
    args: string,
  ): Promise<void> {
    const channel = this.registry.get(message.channelId);
    if (!channel) return;
    const parts = args.trim().split(/\s+/);
    let scheduleStr: string, promptStr: string;
    if (/^\d{4}-\d{2}-\d{2}/.test(parts[0])) {
      scheduleStr = parts[0];
      promptStr = parts.slice(1).join(" ");
    } else {
      scheduleStr = parts.slice(0, 5).join(" ");
      promptStr = parts.slice(5).join(" ");
    }
    if (!promptStr.trim()) {
      await channel.send({
        threadId: message.threadId,
        text: "Usage: /schedule <cron|ISO> <prompt>",
      });
      return;
    }
    const id = `task_${Date.now()}`;
    this.scheduler.add({
      id,
      channelId: message.channelId,
      threadId: message.threadId,
      prompt: promptStr,
      schedule: /^\d{4}/.test(scheduleStr)
        ? { type: "once", at: new Date(scheduleStr) }
        : { type: "cron", expr: scheduleStr },
    });
    await channel.send({
      threadId: message.threadId,
      text: `Task ${id} scheduled.\nPrompt: ${promptStr}\nSchedule: ${scheduleStr}`,
    });
  }

  private async handlePRCheckout(
    message: InboundMessage,
    prNumber: number,
  ): Promise<void> {
    const channel = this.registry.get(message.channelId);
    if (!channel) return;
    const placeholderId = await channel.sendAndGetId({
      threadId: message.threadId,
      text: `⏳ Checking out PR #${prNumber}...`,
    });
    try {
      const result = await createFromPR({
        baseDirectory: this.config.workdir,
        prNumber,
      });
      if (result instanceof Error) {
        await channel
          .editMessage(
            message.threadId,
            placeholderId,
            `PR checkout failed: ${result.message}`,
          )
          .catch(() => {});
        return;
      }
      const session = this.sessions.getOrCreate(message);
      session.worktree = result;
      session.workdir = result.directory;
      this.heartbeat.updateWorkdir(
        message.channelId,
        message.threadId,
        result.directory,
      );
      await channel
        .editMessage(
          message.threadId,
          placeholderId,
          `PR #${prNumber} checked out!\nBranch: ${result.branch}\nWorkdir: ${result.directory}`,
        )
        .catch(() => {});
    } catch (e) {
      await channel
        .editMessage(message.threadId, placeholderId, `Error: ${e}`)
        .catch(() => {});
    }
  }

  private async fireScheduledTask(task: ScheduledTask): Promise<void> {
    const channel = this.registry.get(task.channelId as any);
    if (!channel) {
      log.warn(
        `Scheduled task ${task.id}: channel ${task.channelId} not found`,
      );
      return;
    }
    const syntheticMessage: InboundMessage = {
      id: `scheduled_${task.id}_${Date.now()}`,
      channelId: task.channelId as any,
      threadId: task.threadId,
      senderId: "scheduler",
      text: task.prompt,
      timestamp: new Date(),
    };
    await this.runAgentMessage(syntheticMessage, task.prompt);
  }

  private handleEvent(event: ChannelEvent): void {
    switch (event.type) {
      case "connected":
        log.info(`✓ ${event.channelId} connected`);
        break;
      case "disconnected":
        log.warn(
          `✗ ${event.channelId} disconnected${event.reason ? ` — ${event.reason}` : ""}`,
        );
        break;
      case "error":
        log.error(`[${event.channelId}] error:`, event.error.message);
        break;
    }
  }
}
