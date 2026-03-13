// Session manager — tracks active thread sessions across all channels.
// Each session maps a channel+thread to a workdir and OpenCode session ID.
// Supports per-thread git worktrees for isolated coding branches.

import type { InboundMessage } from '@hydra/core'
import { SubagentRegistry } from '@hydra/core'
import { createWorktree, deleteWorktree, isGitRepo, type WorktreeInfo } from './worktree-manager.js'
import { createLogger } from './logger.js'

const log = createLogger('sessions')

export type SessionKey = string

export function buildSessionKey(channelId: string, threadId: string): SessionKey {
  return `${channelId}:${threadId}`
}

export type ActiveSession = {
  key: SessionKey
  channelId: string
  threadId: string
  workdir: string
  worktree?: WorktreeInfo
  opencodeSessionId?: string
  startedAt: Date
  lastActivityAt: Date
}

export class SessionManager {
  private sessions = new Map<SessionKey, ActiveSession>()
  private subagentRegistry = new SubagentRegistry()
  private defaultWorkdir: string
  private worktreesEnabled: boolean

  constructor(opts: { defaultWorkdir: string; worktreesEnabled?: boolean }) {
    this.defaultWorkdir = opts.defaultWorkdir
    this.worktreesEnabled = opts.worktreesEnabled ?? false
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

  // Provision a git worktree for a session (call after getOrCreate)
  async ensureWorktree(session: ActiveSession): Promise<void> {
    if (!this.worktreesEnabled || session.worktree) return

    const gitRepo = await isGitRepo(this.defaultWorkdir)
    if (!gitRepo) return

    // Worktree name: safe slug from session key
    const name = `hydra-${session.channelId}-${session.threadId.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`
    const result = await createWorktree({ baseDirectory: this.defaultWorkdir, name })

    if (result instanceof Error) {
      log.warn(`Worktree creation failed for ${session.key}: ${result.message}`)
      return
    }

    session.worktree = result
    session.workdir = result.directory
    log.info(`Worktree provisioned for ${session.key}: ${result.directory}`)
  }

  get(key: SessionKey): ActiveSession | undefined {
    return this.sessions.get(key)
  }

  async deleteSession(key: SessionKey): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return

    if (session.worktree) {
      await deleteWorktree({
        baseDirectory: this.defaultWorkdir,
        name: session.worktree.name,
      }).catch((e) => log.warn(`Worktree cleanup failed: ${e}`))
    }

    this.sessions.delete(key)
  }

  get subagents(): SubagentRegistry {
    return this.subagentRegistry
  }

  async sweepIdle(maxIdleMs: number): Promise<void> {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > maxIdleMs) {
        await this.deleteSession(key)
      }
    }
  }
}
