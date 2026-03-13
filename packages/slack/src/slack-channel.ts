// Slack channel adapter for Hydra.
// Uses Bolt with Socket Mode (no public URL needed) — same pattern as OpenClaw.
// Falls back to HTTP webhook mode if SLACK_SIGNING_SECRET + port are provided.

import { App } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import { BaseChannel } from '@hydra/core'
import type { InboundMessage, OutboundMessage } from '@hydra/core'

export type SlackChannelConfig = {
  botToken: string
  // Socket Mode (recommended — no public URL needed)
  appToken?: string
  // HTTP webhook mode (alternative)
  signingSecret?: string
  port?: number
  // Restrict to specific Slack user IDs
  allowFrom?: string[]
}

const SLACK_MAX_MESSAGE_LENGTH = 3000

export class SlackChannel extends BaseChannel {
  readonly id = 'slack' as const
  readonly name = 'Slack'

  private app: App
  private web: WebClient
  private config: SlackChannelConfig

  constructor(config: SlackChannelConfig) {
    super()
    this.config = config
    this.web = new WebClient(config.botToken, {
      retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 3000, randomize: true },
    })

    if (config.appToken) {
      this.app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
      })
    } else {
      this.app = new App({
        token: config.botToken,
        signingSecret: config.signingSecret ?? '',
        port: config.port ?? 3000,
      })
    }

    this.setupHandlers()
  }

  private setupHandlers(): void {
    this.app.message(async ({ message }) => {
      const msg = message as any
      if (!msg.text && !msg.files) return
      if (msg.subtype) return // ignore edits, joins, bot messages etc.

      const userId: string | undefined = msg.user
      if (!this.isAllowed(userId)) return

      const inbound: InboundMessage = {
        id: msg.ts as string,
        channelId: this.id,
        threadId: (msg.thread_ts ?? msg.channel ?? msg.ts) as string,
        senderId: userId ?? 'unknown',
        text: (msg.text ?? '') as string,
        timestamp: new Date(Number(msg.ts) * 1000),
        raw: msg,
        attachments: Array.isArray(msg.files)
          ? msg.files.map((f: any) => ({
              type: 'file' as const,
              url: f.url_private as string,
              mimeType: f.mimetype as string,
              name: f.name as string,
            }))
          : [],
      }

      await this.emitMessage(inbound)
    })

    this.app.error(async (error) => {
      this.emitEvent({ type: 'error', channelId: this.id, error })
    })
  }

  async start(): Promise<void> {
    await this.app.start()
    this.emitEvent({ type: 'connected', channelId: this.id })
  }

  async stop(): Promise<void> {
    await this.app.stop()
    this.emitEvent({ type: 'disconnected', channelId: this.id })
  }

  async send(message: OutboundMessage): Promise<void> {
    const chunks = this.splitMessage(message.text)
    for (const chunk of chunks) {
      await this.web.chat.postMessage({
        channel: message.threadId,
        text: chunk,
        thread_ts: message.replyToId,
        mrkdwn: true,
      })
    }
  }

  async sendTyping(_threadId: string): Promise<void> {
    // Slack doesn't expose a typing indicator API for bots
  }

  private isAllowed(userId?: string): boolean {
    const { allowFrom } = this.config
    if (!allowFrom || allowFrom.length === 0) return true
    return !!userId && allowFrom.includes(userId)
  }

  private splitMessage(text: string, limit = SLACK_MAX_MESSAGE_LENGTH): string[] {
    if (text.length <= limit) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      let cutAt = limit
      const newline = remaining.lastIndexOf('\n', limit)
      if (newline > limit * 0.5) cutAt = newline + 1
      chunks.push(remaining.slice(0, cutAt))
      remaining = remaining.slice(cutAt)
    }
    return chunks
  }
}
