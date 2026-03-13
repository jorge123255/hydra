// The Hydra Gateway — central orchestrator.
// Integrates: channels, OpenCode sessions, worktrees, scheduler, memory.

import { ChannelRegistry, type InboundMessage, type ChannelEvent } from '@hydra/core'
import { SessionManager } from './session-manager.js'
import { runSession } from './opencode-session.js'
import { stopServer } from './opencode-server.js'
import { Scheduler, type ScheduledTask } from './scheduler.js'
import { buildMemoryPrompt, appendMemory } from './memory.js'
import { createLogger } from './logger.js'

const log = createLogger('gateway')

export type GatewayConfig = {
  workdir: string
  sessionIdleMs?: number
  worktrees?: boolean
}

// Built-in commands parsed from messages
const CMD_REMEMBER  = /^\/remember\s+(.+)/i
const CMD_FORGET    = /^\/forget$/i
const CMD_SCHEDULE  = /^\/schedule\s+(.+)/i
const CMD_UNSCHEDULE = /^\/unschedule\s+(\S+)/i
const CMD_TASKS     = /^\/tasks$/i
const CMD_HELP      = /^\/help$/i

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
    for (const [key, ctrl] of this.activeRuns) {
      log.debug(`Aborting run: ${key}`)
      ctrl.abort()
    }
    await this.registry.stopAll()
    await stopServer()
    log.info('Gateway stopped.')
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const channel = this.registry.get(message.channelId)
    if (!channel) return

    const text = message.text.trim()

    // ── Built-in commands ────────────────────────────────────────
    if (CMD_HELP.test(text)) {
      await channel.send({
        threadId: message.threadId,
        text: [
          '**Hydra commands:**',
          '`/remember <note>` — save something to memory',
          '`/forget` — clear memory for this thread',
          '`/schedule <cron|ISO> <prompt>` — schedule a task',
          '`/unschedule <id>` — remove a scheduled task',
          '`/tasks` — list scheduled tasks',
          '',
          'Or just send any message to talk to the agent.',
        ].join('\n'),
      })
      return
    }

    const rememberMatch = CMD_REMEMBER.exec(text)
    if (rememberMatch) {
      appendMemory(message.channelId, message.threadId, rememberMatch[1])
      await channel.send({ threadId: message.threadId, text: '✅ Remembered.' })
      return
    }

    if (CMD_FORGET.test(text)) {
      const { writeMemory } = await import('./memory.js')
      writeMemory(message.channelId, message.threadId, '')
      await channel.send({ threadId: message.threadId, text: '🗑️ Memory cleared.' })
      return
    }

    if (CMD_TASKS.test(text)) {
      const tasks = this.scheduler.list(message.channelId, message.threadId)
      if (tasks.length === 0) {
        await channel.send({ threadId: message.threadId, text: 'No scheduled tasks.' })
      } else {
        const lines = tasks.map(
          (t) => `• \`${t.id}\` — _${t.prompt.slice(0, 60)}_ — next: ${t.nextRunAt.toISOString()}`
        )
        await channel.send({ threadId: message.threadId, text: lines.join('\n') })
      }
      return
    }

    const unschedMatch = CMD_UNSCHEDULE.exec(text)
    if (unschedMatch) {
      const removed = this.scheduler.remove(unschedMatch[1])
      await channel.send({
        threadId: message.threadId,
        text: removed ? '✅ Task removed.' : '❌ Task not found.',
      })
      return
    }

    const schedMatch = CMD_SCHEDULE.exec(text)
    if (schedMatch) {
      await this.handleScheduleCommand(message, schedMatch[1])
      return
    }

    // ── Route to OpenCode ────────────────────────────────────────
    await this.runAgentMessage(message)
  }

  private async runAgentMessage(message: InboundMessage, overridePrompt?: string): Promise<void> {
    const session = this.sessions.getOrCreate(message)
    const channel = this.registry.get(message.channelId)
    if (!channel) return
    const { key } = session

    await this.sessions.ensureWorktree(session)

    const existing = this.activeRuns.get(key)
    if (existing) {
      log.debug(`[${key}] Aborting previous run`)
      existing.abort()
    }

    const ctrl = new AbortController()
    this.activeRuns.set(key, ctrl)

    const prompt = overridePrompt ?? message.text

    // Prepend memory context to prompt
    const memoryPrefix = buildMemoryPrompt(message.channelId, message.threadId)
    const fullPrompt = memoryPrefix ? `${memoryPrefix}${prompt}` : prompt

    log.info(`[${key}] "${prompt.slice(0, 100)}"`)

    try {
      await channel.sendTyping(message.threadId)

      let pending = ''
      let lastSentAt = Date.now()

      const result = await runSession({
        sessionId: session.opencodeSessionId,
        directory: session.workdir,
        prompt: fullPrompt,
        signal: ctrl.signal,
        onChunk: async (chunk) => {
          pending += chunk
          if (pending.length >= 400 || Date.now() - lastSentAt > 3000) {
            await channel.send({ threadId: message.threadId, text: pending })
            pending = ''
            lastSentAt = Date.now()
          }
        },
      })

      session.opencodeSessionId = result.sessionId

      const finalText = pending + (result.error ? `\n\n⚠️ ${result.error}` : '')
      if (finalText.trim()) {
        await channel.send({ threadId: message.threadId, text: finalText })
      } else if (!result.text && !result.error) {
        await channel.send({ threadId: message.threadId, text: '_(no response)_' })
      }

      if (result.compacted) {
        await channel.send({
          threadId: message.threadId,
          text: '_(context compacted to stay within limits)_',
        })
      }

    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      log.error(`[${key}] Error:`, err)
      await channel.send({
        threadId: message.threadId,
        text: '❌ Something went wrong. Please try again.',
        replyToId: message.id,
      }).catch(() => {})
    } finally {
      this.activeRuns.delete(key)
    }
  }

  private async handleScheduleCommand(message: InboundMessage, args: string): Promise<void> {
    const channel = this.registry.get(message.channelId)
    if (!channel) return

    // Format: /schedule 0 9 * * * check deployments
    // Or: /schedule 2026-04-01T09:00:00 deploy release
    const parts = args.trim().split(/\s+/)
    let scheduleStr: string
    let promptStr: string

    // ISO date check
    if (/^\d{4}-\d{2}-\d{2}/.test(parts[0])) {
      scheduleStr = parts[0]
      promptStr = parts.slice(1).join(' ')
    } else {
      // Assume 5-part cron expression
      scheduleStr = parts.slice(0, 5).join(' ')
      promptStr = parts.slice(5).join(' ')
    }

    if (!promptStr.trim()) {
      await channel.send({ threadId: message.threadId, text: '❌ Usage: `/schedule <cron|ISO> <prompt>`' })
      return
    }

    const id = `task_${Date.now()}`
    const isISO = /^\d{4}/.test(scheduleStr)

    this.scheduler.add({
      id,
      channelId: message.channelId,
      threadId: message.threadId,
      prompt: promptStr,
      schedule: isISO
        ? { type: 'once', at: new Date(scheduleStr) }
        : { type: 'cron', expr: scheduleStr },
    })

    await channel.send({
      threadId: message.threadId,
      text: `✅ Task \`${id}\` scheduled.\nPrompt: _${promptStr}_\nSchedule: \`${scheduleStr}\``,
    })
  }

  private async fireScheduledTask(task: ScheduledTask): Promise<void> {
    const channel = this.registry.get(task.channelId as any)
    if (!channel) {
      log.warn(`Scheduled task ${task.id}: channel ${task.channelId} not found`)
      return
    }

    // Create a synthetic message to reuse runAgentMessage
    const syntheticMessage = {
      id: `scheduled_${task.id}_${Date.now()}`,
      channelId: task.channelId as any,
      threadId: task.threadId,
      senderId: 'scheduler',
      text: task.prompt,
      timestamp: new Date(),
    }

    await this.runAgentMessage(syntheticMessage, task.prompt)
  }

  private handleEvent(event: ChannelEvent): void {
    switch (event.type) {
      case 'connected':
        log.info(`✓ ${event.channelId} connected`)
        break
      case 'disconnected':
        log.warn(`✗ ${event.channelId} disconnected${event.reason ? ` — ${event.reason}` : ''}`)
        break
      case 'error':
        log.error(`[${event.channelId}] error:`, event.error.message)
        break
    }
  }
}
