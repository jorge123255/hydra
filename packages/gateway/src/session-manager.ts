// Session manager — tracks active thread sessions across all channels.
// Each session maps a channel+thread to a workdir and OpenCode session ID.
// Supports per-thread git worktrees for isolated coding branches.
// Phase 9: accountId for cross-channel session continuity.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { InboundMessage } from '@hydra/core'
import { SubagentRegistry } from '@hydra/core'
import { createWorktree, deleteWorktree, isGitRepo, type WorktreeInfo } from './worktree-manager.js'
import { createLogger } from './logger.js'

const log = createLogger('sessions')

const ACCOUNTS_PATH = path.join(os.homedir(), '.hydra', 'accounts.json')
type AccountStore = Record<string, string> // `${channelId}:${senderId}` → accountId

function readAccounts(): AccountStore {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')) }
  catch { return {} }
}
function writeAccounts(store: AccountStore) {
  fs.mkdirSync(path.dirname(ACCOUNTS_PATH), { recursive: true })
  fs.writeFileSync(ACCOUNTS_PATH + '.tmp', JSON.stringify(store, null, 2))
  fs.renameSync(ACCOUNTS_PATH + '.tmp', ACCOUNTS_PATH)
}

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
  accountId?: string          // Phase 9: links identity across channels
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

  // ── Phase 9: account linking ────────────────────────────────────────────

  /** Associate a channel identity with a cross-channel accountId */
  linkAccount(channelId: string, senderId: string, accountId: string): void {
    const store = readAccounts()
    store[`${channelId}:${senderId}`] = accountId
    writeAccounts(store)
    log.info(`Linked ${channelId}:${senderId} → account ${accountId}`)
  }

  /** Look up the accountId for a given channel+sender */
  getAccountId(channelId: string, senderId: string): string | undefined {
    return readAccounts()[`${channelId}:${senderId}`]
  }

  /** Find an existing session for a given accountId (across all channels) */
  findSessionByAccount(accountId: string): ActiveSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId) return session
    }
    return undefined
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  getOrCreate(message: InboundMessage): ActiveSession {
    const key = buildSessionKey(message.channelId, message.threadId)
    let session = this.sessions.get(key)

    if (!session) {
      // Phase 9: check if sender has an accountId with an existing session
      const accountId = this.getAccountId(message.channelId, message.senderId)
      const linked = accountId ? this.findSessionByAccount(accountId) : undefined

      session = {
        key,
        channelId: message.channelId,
        threadId: message.threadId,
        workdir: linked?.workdir ?? this.defaultWorkdir,
        worktree: linked?.worktree,
        opencodeSessionId: linked?.opencodeSessionId,  // resume same OpenCode session
        accountId,
        startedAt: new Date(),
        lastActivityAt: new Date(),
      }
      this.sessions.set(key, session)

      if (linked) {
        log.info(`Resumed session for account ${accountId} from ${linked.channelId} → ${message.channelId}`)
      }
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
