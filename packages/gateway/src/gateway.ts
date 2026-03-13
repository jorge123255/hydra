// The Hydra Gateway — central orchestrator.
// Wires ChannelRegistry → SessionManager → OpenCode.

import { ChannelRegistry, type InboundMessage, type ChannelEvent } from '@hydra/core'
import { SessionManager } from './session-manager.js'
import { runSession } from './opencode-session.js'
import { stopServer } from './opencode-server.js'
import { createLogger } from './logger.js'

const log = createLogger('gateway')

export type GatewayConfig = {
  workdir: string
  sessionIdleMs?: number
}

export class Gateway {
  private registry: ChannelRegistry
  private sessions: SessionManager
  private config: GatewayConfig
  private sweepTimer?: NodeJS.Timeout
  // Track in-flight abort controllers per session key
  private activeRuns = new Map<string, AbortController>()

  constructor(registry: ChannelRegistry, config: GatewayConfig) {
    this.registry = registry
    this.config = config
    this.sessions = new SessionManager({ defaultWorkdir: config.workdir })
  }

  async start(): Promise<void> {
    log.info('Starting Hydra gateway...')
    this.registry.onMessage(this.handleMessage.bind(this))
    this.registry.onEvent(this.handleEvent.bind(this))
    await this.registry.startAll()

    const idleMs = this.config.sessionIdleMs ?? 30 * 60 * 1000
    this.sweepTimer = setInterval(() => this.sessions.sweepIdle(idleMs), 5 * 60 * 1000)

    log.info(`Gateway running — channels: [${this.registry.getAll().map((c) => c.id).join(', ')}]`)
  }

  async stop(): Promise<void> {
    log.info('Stopping Hydra gateway...')
    if (this.sweepTimer) clearInterval(this.sweepTimer)

    // Abort all in-flight runs
    for (const [key, ctrl] of this.activeRuns) {
      log.debug(`Aborting run for session ${key}`)
      ctrl.abort()
    }

    await this.registry.stopAll()
    await stopServer()
    log.info('Gateway stopped.')
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const session = this.sessions.getOrCreate(message)
    const channel = this.registry.get(message.channelId)
    if (!channel) return

    const { key } = session
    log.info(`[${key}] "${message.text.slice(0, 100)}"`)

    // Abort any existing run for this session (new message = interrupt)
    const existing = this.activeRuns.get(key)
    if (existing) {
      log.debug(`[${key}] Aborting previous run`)
      existing.abort()
    }

    const ctrl = new AbortController()
    this.activeRuns.set(key, ctrl)

    try {
      await channel.sendTyping(message.threadId)

      // Accumulate streamed chunks — send partial updates every ~500 chars
      let pending = ''
      let lastSentAt = Date.now()

      const flushPending = async () => {
        if (!pending) return
        await channel.send({ threadId: message.threadId, text: pending })
        pending = ''
        lastSentAt = Date.now()
      }

      const result = await runSession({
        sessionId: session.opencodeSessionId,
        directory: session.workdir,
        prompt: message.text,
        signal: ctrl.signal,
        onChunk: async (chunk) => {
          pending += chunk
          // Flush every ~400 chars or every 3s to keep the user updated
          if (pending.length >= 400 || Date.now() - lastSentAt > 3000) {
            await flushPending()
          }
        },
      })

      // Persist the OpenCode session ID for this thread
      session.opencodeSessionId = result.sessionId

      // Send any remaining text
      const finalText = pending + (result.error ? `\n\n⚠️ ${result.error}` : '')
      if (finalText.trim()) {
        await channel.send({ threadId: message.threadId, text: finalText })
      } else if (!result.text && !result.error) {
        await channel.send({ threadId: message.threadId, text: '_(no response)_' })
      }

    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      log.error(`[${key}] Unhandled error:`, err)
      await channel.send({
        threadId: message.threadId,
        text: '❌ Something went wrong. Please try again.',
        replyToId: message.id,
      }).catch(() => {})
    } finally {
      this.activeRuns.delete(key)
    }
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
