// The Hydra Gateway — central orchestrator.
// Phase 4A: vision via images[] on InboundMessage
// Phase 4B: streaming replies via editMessage
// Phase 5A: pairing/security codes for unknown senders
// Phase 6A: GitHub Copilot OAuth (/copilot-login command)
// Phase 6B: intent routing (code/chat/vision/computer)
// Phase 7: computer-use via @hydra/computer-use

import { ChannelRegistry, type InboundMessage, type ChannelEvent } from '@hydra/core'
import { SessionManager } from './session-manager.js'
import { runSession } from './opencode-session.js'
import { stopServer } from './opencode-server.js'
import { Scheduler, type ScheduledTask } from './scheduler.js'
import { buildMemoryPrompt, appendMemory, writeMemory } from './memory.js'
import { createLogger } from './logger.js'
import { isAllowed, upsertPairingRequest, approvePairing, revokePairing, listPendingRequests } from './pairing.js'
import { classifyIntent, stripIntentPrefix } from './router.js'
import { isCopilotConfigured, githubCopilotLogin, resolveCopilotCredentials, getVisionUsageStatus } from './copilot-chat.js'

const log = createLogger('gateway')

export type GatewayConfig = {
  workdir: string
  sessionIdleMs?: number
  worktrees?: boolean
}

const CMD_REMEMBER   = /^\/remember\s+(.+)/i
const CMD_FORGET     = /^\/forget$/i
const CMD_SCHEDULE   = /^\/schedule\s+(.+)/i
const CMD_UNSCHEDULE = /^\/unschedule\s+(\S+)/i
const CMD_TASKS      = /^\/tasks$/i
const CMD_HELP       = /^\/help$/i
const CMD_APPROVE    = /^\/approve\s+(\S+)\s+(\S+)/i  // /approve {channelId} {code}
const CMD_REVOKE     = /^\/revoke\s+(\S+)\s+(\S+)/i   // /revoke {channelId} {senderId}
const CMD_PENDING    = /^\/pending(?:\s+(\S+))?$/i     // /pending [channelId]
const CMD_COPILOT    = /^\/copilot-login$/i
const CMD_COPILOT_STATUS = /^\/copilot-status$/i
const CMD_VISION_USAGE = /^\/vision-usage$/i

export class Gateway {
  private registry: ChannelRegistry
  private sessions: SessionManager
  private config: GatewayConfig
  private sweepTimer?: NodeJS.Timeout
  private activeRuns = new Map<string, AbortController>()
  private scheduler: Scheduler

  constructor(registry: ChannelRegistry, config: GatewayConfig) {
    this.registry = registry
    this.config = config
    this.sessions = new SessionManager({
      defaultWorkdir: config.workdir,
      worktreesEnabled: config.worktrees ?? false,
    })
    this.scheduler = new Scheduler(this.fireScheduledTask.bind(this))
  }

  async start(): Promise<void> {
    log.info('Starting Hydra gateway...')
    this.registry.onMessage(this.handleMessage.bind(this))
    this.registry.onEvent(this.handleEvent.bind(this))
    await this.registry.startAll()
    this.scheduler.start()
    const idleMs = this.config.sessionIdleMs ?? 30 * 60 * 1000
    this.sweepTimer = setInterval(() => this.sessions.sweepIdle(idleMs), 5 * 60 * 1000)
    log.info(`Gateway running — channels: [${this.registry.getAll().map((c) => c.id).join(', ')}]`)
  }

  async stop(): Promise<void> {
    log.info('Stopping Hydra gateway...')
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.scheduler.stop()
    for (const [, ctrl] of this.activeRuns) ctrl.abort()
    await this.registry.stopAll()
    await stopServer()
    log.info('Gateway stopped.')
  }

  private isOwner(channelId: string, senderId: string): boolean {
    const owners = (process.env.HYDRA_OWNER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return owners.some((o) => o === `${channelId}:${senderId}` || o === senderId)
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const channel = this.registry.get(message.channelId)
    if (!channel) return
    const text = message.text.trim()

    // ── Pairing check (Phase 5A) ─────────────────────────────────────────────
    // Skip for owners and for /approve commands
    if (!this.isOwner(message.channelId, message.senderId) && !CMD_APPROVE.test(text)) {
      if (!isAllowed(message.channelId, message.senderId)) {
        const { code, isNew } = upsertPairingRequest(message.channelId, message.senderId)
        if (isNew) {
          await channel.send({
            threadId: message.threadId,
            text: `👋 Hi! I don't recognize you.\n\nTo get access, share this code with the bot owner:\n\`\`\`\n${code}\n\`\`\`\nTell them to run:\n\`/approve ${message.channelId} ${code}\`\n\nYour ID: \`${message.senderId}\``,
          })
        }
        return
      }
    }

    // ── Built-in commands ─────────────────────────────────────────────────────
    if (CMD_HELP.test(text)) {
      await channel.send({
        threadId: message.threadId,
        text: [
          '**Hydra commands:**',
          '`/remember <note>` — save to memory',
          '`/forget` — clear memory for this thread',
          '`/schedule <cron|ISO> <prompt>` — schedule a task',
          '`/unschedule <id>` — remove scheduled task',
          '`/tasks` — list scheduled tasks',
          '`/approve <channelId> <code>` — approve a pairing request',
          '`/revoke <channelId> <userId>` — revoke access',
          '`/pending [channelId]` — list pending pairing requests',
          '`/copilot-login` — connect GitHub Copilot (free claude-sonnet-4.6)',
          '`/copilot-status` — check Copilot auth status',
          '`/vision-usage` — check vision budget usage',
          '`/fast <msg>` — quick chat (no OpenCode overhead)',
          '`/code <msg>` — force code route',
          '`/computer <task>` — control the Mac desktop',
          '',
          'Or just send any message to talk to the AI.',
        ].join('\n'),
      })
      return
    }

    if (CMD_FORGET.test(text)) {
      writeMemory(message.channelId, message.threadId, '')
      await channel.send({ threadId: message.threadId, text: '🗑️ Memory cleared.' })
      return
    }

    const rememberMatch = CMD_REMEMBER.exec(text)
    if (rememberMatch) {
      appendMemory(message.channelId, message.threadId, rememberMatch[1])
      await channel.send({ threadId: message.threadId, text: '✅ Remembered.' })
      return
    }

    if (CMD_TASKS.test(text)) {
      const tasks = this.scheduler.list(message.channelId, message.threadId)
      if (!tasks.length) await channel.send({ threadId: message.threadId, text: 'No scheduled tasks.' })
      else await channel.send({
        threadId: message.threadId,
        text: tasks.map((t) => `• \`${t.id}\` — _${t.prompt.slice(0, 60)}_ — next: ${t.nextRunAt.toISOString()}`).join('\n'),
      })
      return
    }

    const unschedMatch = CMD_UNSCHEDULE.exec(text)
    if (unschedMatch) {
      const removed = this.scheduler.remove(unschedMatch[1])
      await channel.send({ threadId: message.threadId, text: removed ? '✅ Task removed.' : '❌ Task not found.' })
      return
    }

    const schedMatch = CMD_SCHEDULE.exec(text)
    if (schedMatch) { await this.handleScheduleCommand(message, schedMatch[1]); return }

    // ── Pairing management (owner only) ──────────────────────────────────────
    const approveMatch = CMD_APPROVE.exec(text)
    if (approveMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: '❌ Only the bot owner can approve pairing.' })
        return
      }
      const result = approvePairing(approveMatch[1], approveMatch[2])
      await channel.send({
        threadId: message.threadId,
        text: result.ok ? `✅ Approved sender \`${result.senderId}\` on ${approveMatch[1]}.` : '❌ Code not found or expired.',
      })
      return
    }

    const revokeMatch = CMD_REVOKE.exec(text)
    if (revokeMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: '❌ Only the bot owner can revoke access.' })
        return
      }
      const ok = revokePairing(revokeMatch[1], revokeMatch[2])
      await channel.send({ threadId: message.threadId, text: ok ? `✅ Access revoked.` : '❌ Sender not found.' })
      return
    }

    const pendingMatch = CMD_PENDING.exec(text)
    if (pendingMatch) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: '❌ Only the bot owner can list pending requests.' })
        return
      }
      const cid = pendingMatch[1] ?? message.channelId
      const requests = listPendingRequests(cid)
      if (!requests.length) await channel.send({ threadId: message.threadId, text: `No pending requests for ${cid}.` })
      else await channel.send({
        threadId: message.threadId,
        text: requests.map((r) => `• \`${r.id}\` — code: \`${r.code}\` — expires: ${r.expiresAt}`).join('\n'),
      })
      return
    }

    // ── Copilot commands ──────────────────────────────────────────────────────
    if (CMD_COPILOT.test(text)) {
      if (!this.isOwner(message.channelId, message.senderId)) {
        await channel.send({ threadId: message.threadId, text: '❌ Only the bot owner can configure Copilot.' })
        return
      }
      await channel.send({ threadId: message.threadId, text: '🔗 Starting GitHub Copilot login...\n(check the server terminal for the device code)' })
      githubCopilotLogin().then(() => {
        channel.send({ threadId: message.threadId, text: '✅ GitHub Copilot connected! Now using claude-sonnet-4.6 for free.' }).catch(() => {})
      }).catch((e) => {
        channel.send({ threadId: message.threadId, text: `❌ Copilot login failed: ${e}` }).catch(() => {})
      })
      return
    }

    if (CMD_COPILOT_STATUS.test(text)) {
      const configured = isCopilotConfigured()
      if (!configured) {
        await channel.send({ threadId: message.threadId, text: '❌ Copilot not configured. Run `/copilot-login` first.' })
      } else {
        const creds = await resolveCopilotCredentials().catch(() => null)
        if (creds) {
          const expiresIn = Math.round((creds.expiresAt - Date.now()) / 60_000)
          await channel.send({ threadId: message.threadId, text: `✅ Copilot active\nModel: \`${process.env.HYDRA_COPILOT_MODEL ?? 'claude-sonnet-4.6'}\`\nToken expires in: ${expiresIn} min` })
        } else {
          await channel.send({ threadId: message.threadId, text: '⚠️ Copilot configured but token refresh failed.' })
        }
      }
      return
    }

    if (CMD_VISION_USAGE.test(text)) {
      const { count, budget, remaining } = getVisionUsageStatus()
      await channel.send({ threadId: message.threadId, text: `👁️ Vision usage today: ${count}/${budget} calls used, ${remaining} remaining.` })
      return
    }

    // ── Route by intent (Phase 6B) ────────────────────────────────────────────
    await this.runAgentMessage(message)
  }

  private async runAgentMessage(message: InboundMessage, overridePrompt?: string): Promise<void> {
    const session = this.sessions.getOrCreate(message)
    const channel = this.registry.get(message.channelId)
    if (!channel) return
    const { key } = session

    await this.sessions.ensureWorktree(session)

    const existing = this.activeRuns.get(key)
    if (existing) { log.debug(`[${key}] Aborting previous run`); existing.abort() }

    const ctrl = new AbortController()
    this.activeRuns.set(key, ctrl)

    const rawPrompt = overridePrompt ?? message.text
    const intent = classifyIntent(rawPrompt, !!(message.images?.length))
    const prompt = stripIntentPrefix(rawPrompt)
    const memoryPrefix = buildMemoryPrompt(message.channelId, message.threadId)
    const fullPrompt = memoryPrefix ? `${memoryPrefix}${prompt}` : prompt

    log.info(`[${key}] intent=${intent} "${prompt.slice(0, 100)}"`)

    try {
      // ── Computer-use path (Phase 7) ──────────────────────────────────────
      if (intent === 'computer') {
        await this.runComputerTask(message, fullPrompt, channel)
        return
      }

      // ── Fast chat via Copilot (Phase 6B) ─────────────────────────────────
      if (intent === 'fast' || (intent === 'chat' && isCopilotConfigured())) {
        await this.runCopilotChat(message, fullPrompt, message.images, channel)
        return
      }

      // ── Default: OpenCode session (code / vision / chat fallback) ─────────
      await channel.sendTyping(message.threadId)

      // Phase 4B: send placeholder, get its ID for live editing
      const placeholderId = await channel.sendAndGetId({
        threadId: message.threadId,
        text: '⏳ _thinking..._',
      })

      let accumulated = ''
      let lastEditAt = 0

      const result = await runSession({
        sessionId: session.opencodeSessionId,
        directory: session.workdir,
        prompt: fullPrompt,
        images: message.images, // Phase 4A
        signal: ctrl.signal,
        onChunk: async (text) => {
          accumulated = text
          const now = Date.now()
          // Debounce: edit at most once per 800ms
          if (placeholderId && now - lastEditAt > 800) {
            await channel.editMessage(message.threadId, placeholderId, accumulated + ' ▋').catch(() => {})
            lastEditAt = now
          }
        },
      })

      session.opencodeSessionId = result.sessionId

      // Final edit with complete text
      const finalText = (result.text || accumulated) + (result.error ? `\n\n⚠️ ${result.error}` : '')
      if (placeholderId && finalText.trim()) {
        await channel.editMessage(message.threadId, placeholderId, finalText).catch(() => {})
      } else if (finalText.trim()) {
        await channel.send({ threadId: message.threadId, text: finalText })
      } else {
        await channel.editMessage(message.threadId, placeholderId, '_(no response)_').catch(() => {})
      }

      if (result.compacted) {
        await channel.send({ threadId: message.threadId, text: '_(context compacted to stay within limits)_' })
      }

    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      log.error(`[${key}] Error:`, err)
      await channel.send({ threadId: message.threadId, text: '❌ Something went wrong. Please try again.', replyToId: message.id }).catch(() => {})
    } finally {
      this.activeRuns.delete(key)
    }
  }

  private async runCopilotChat(
    message: InboundMessage,
    prompt: string,
    images: string[] | undefined,
    channel: any
  ): Promise<void> {
    const placeholderId = await channel.sendAndGetId({ threadId: message.threadId, text: '⏳ _thinking..._' })
    try {
      const { callCopilotDirect } = await import('./copilot-chat.js')
      const memoryPrefix = buildMemoryPrompt(message.channelId, message.threadId)
      const text = await callCopilotDirect(memoryPrefix ? `${memoryPrefix}${prompt}` : prompt, images)
      await channel.editMessage(message.threadId, placeholderId, text).catch(() => {
        channel.send({ threadId: message.threadId, text })
      })
    } catch (e) {
      await channel.editMessage(message.threadId, placeholderId, `❌ ${e}`).catch(() => {})
    }
  }

  private async runComputerTask(message: InboundMessage, prompt: string, channel: any): Promise<void> {
    const placeholderId = await channel.sendAndGetId({ threadId: message.threadId, text: '🖥️ _starting computer task..._' })
    try {
      const { runComputerTask } = await import('@hydra/computer-use')
      const result = await runComputerTask({
        instruction: prompt,
        maxIterations: 10,
        onStatus: async (msg) => {
          await channel.editMessage(message.threadId, placeholderId, `🖥️ ${msg}`).catch(() => {})
        },
      })
      const summary = result.success ? `✅ Done!\n${result.output}` : `❌ Failed: ${result.output}`
      const stats = `\n_(${result.iterations} steps, ${result.visionCallsUsed} vision calls)_`
      await channel.editMessage(message.threadId, placeholderId, summary + stats).catch(() => {
        channel.send({ threadId: message.threadId, text: summary + stats })
      })
    } catch (e) {
      await channel.editMessage(message.threadId, placeholderId, `❌ Computer task error: ${e}`).catch(() => {})
    }
  }

  private async handleScheduleCommand(message: InboundMessage, args: string): Promise<void> {
    const channel = this.registry.get(message.channelId)
    if (!channel) return
    const parts = args.trim().split(/\s+/)
    let scheduleStr: string, promptStr: string
    if (/^\d{4}-\d{2}-\d{2}/.test(parts[0])) {
      scheduleStr = parts[0]; promptStr = parts.slice(1).join(' ')
    } else {
      scheduleStr = parts.slice(0, 5).join(' '); promptStr = parts.slice(5).join(' ')
    }
    if (!promptStr.trim()) {
      await channel.send({ threadId: message.threadId, text: '❌ Usage: `/schedule <cron|ISO> <prompt>`' }); return
    }
    const id = `task_${Date.now()}`
    this.scheduler.add({
      id, channelId: message.channelId, threadId: message.threadId, prompt: promptStr,
      schedule: /^\d{4}/.test(scheduleStr) ? { type: 'once', at: new Date(scheduleStr) } : { type: 'cron', expr: scheduleStr },
    })
    await channel.send({ threadId: message.threadId, text: `✅ Task \`${id}\` scheduled.\nPrompt: _${promptStr}_\nSchedule: \`${scheduleStr}\`` })
  }

  private async fireScheduledTask(task: ScheduledTask): Promise<void> {
    const channel = this.registry.get(task.channelId as any)
    if (!channel) { log.warn(`Scheduled task ${task.id}: channel ${task.channelId} not found`); return }
    const syntheticMessage = {
      id: `scheduled_${task.id}_${Date.now()}`, channelId: task.channelId as any,
      threadId: task.threadId, senderId: 'scheduler', text: task.prompt, timestamp: new Date(),
    }
    await this.runAgentMessage(syntheticMessage, task.prompt)
  }

  private handleEvent(event: ChannelEvent): void {
    switch (event.type) {
      case 'connected': log.info(`✓ ${event.channelId} connected`); break
      case 'disconnected': log.warn(`✗ ${event.channelId} disconnected${event.reason ? ` — ${event.reason}` : ''}`); break
      case 'error': log.error(`[${event.channelId}] error:`, event.error.message); break
    }
  }
}
