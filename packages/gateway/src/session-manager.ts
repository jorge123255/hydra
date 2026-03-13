// Session manager — tracks active thread sessions across all channels.
// Each session maps a channel+thread to a workdir and OpenCode session ID.

import type { InboundMessage } from '@hydra/core'
import { SubagentRegistry } from '@hydra/core'

export type SessionKey = string

export function buildSessionKey(channelId: string, threadId: string): SessionKey {
  return `${channelId}:${threadId}`
}

export type ActiveSession = {
  key: SessionKey
  channelId: string
  threadId: string
  workdir: string
  // Persisted OpenCode session ID — reused across messages in the same thread
  opencodeSessionId?: string
  startedAt: Date
  lastActivityAt: Date
}

export class SessionManager {
  private sessions = new Map<SessionKey, ActiveSession>()
  private subagentRegistry = new SubagentRegistry()
  private defaultWorkdir: string

  constructor(opts: { defaultWorkdir: string }) {
    this.defaultWorkdir = opts.defaultWorkdir
  }

  getOrCreate(message: InboundMessage): ActiveSession {
    const key = buildSessionKey(message.channelId, message.threadId)
    let session = this.sessions.get(key)

    if (!session) {
      session = {
        key,
        channelId: message.channelId,
        threadId: message.threadId,
        workdir: this.defaultWorkdir,
        startedAt: new Date(),
        lastActivityAt: new Date(),
      }
      this.sessions.set(key, session)
    } else {
      session.lastActivityAt = new Date()
    }

    return session
  }

  get(key: SessionKey): ActiveSession | undefined {
    return this.sessions.get(key)
  }

  delete(key: SessionKey): void {
    this.sessions.delete(key)
  }

  get subagents(): SubagentRegistry {
    return this.subagentRegistry
  }

  sweepIdle(maxIdleMs: number): void {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > maxIdleMs) {
        this.sessions.delete(key)
      }
    }
  }
}
