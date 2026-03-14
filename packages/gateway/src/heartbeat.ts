// Heartbeat proactive loop — ported from OpenClaw (feature 6).
// Every 30 minutes, fires a check-in prompt to all registered active sessions.
// If response is HEARTBEAT_OK or NO_REPLY, the reply is suppressed silently.
// Deduplication: won't heartbeat a session more than once per 24 hours.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from './logger.js'
import { NO_REPLY, HEARTBEAT_OK } from './system-prompt.js'

export { NO_REPLY, HEARTBEAT_OK }

const log = createLogger('heartbeat')

const DATA_DIR = process.env.HYDRA_DATA_DIR ?? path.join(os.homedir(), '.hydra')
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const HEARTBEAT_DEDUP_MS = 24 * 60 * 60 * 1000 // 24 hours

export const HEARTBEAT_PROMPT =
  '[HEARTBEAT] Periodic check-in. If you have anything proactive to share — ' +
  'reminders, observations, scheduled tasks due — share them now. ' +
  `Otherwise reply with exactly: ${HEARTBEAT_OK}`

export type HeartbeatTarget = {
  channelId: string
  threadId: string
  senderId: string
  workdir: string
}

/**
 * Callback receives the target and should:
 * 1. Run the heartbeat prompt through the session
 * 2. Return the response text (or null if it failed)
 * The HeartbeatManager will suppress HEARTBEAT_OK / NO_REPLY replies.
 * The callback is responsible for sending non-suppressed replies to the channel.
 */
export type HeartbeatCallback = (
  target: HeartbeatTarget,
  sendResponse: (text: string) => Promise<void>
) => Promise<void>

export class HeartbeatManager {
  private timer?: NodeJS.Timeout
  private targets = new Map<string, HeartbeatTarget>()
  private lastSent = new Map<string, number>()
  private callback: HeartbeatCallback

  constructor(callback: HeartbeatCallback) {
    this.callback = callback
    this.loadState()
  }

  /** Register a session target for heartbeat checks */
  register(target: HeartbeatTarget): void {
    const key = `${target.channelId}:${target.threadId}`
    this.targets.set(key, target)
  }

  /** Update workdir when a session creates a worktree */
  updateWorkdir(channelId: string, threadId: string, workdir: string): void {
    const key = `${channelId}:${threadId}`
    const existing = this.targets.get(key)
    if (existing) this.targets.set(key, { ...existing, workdir })
  }

  /** Unregister a target (call when session is destroyed) */
  unregister(channelId: string, threadId: string): void {
    this.targets.delete(`${channelId}:${threadId}`)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(
      () => this.tick().catch((e) => log.error('Heartbeat tick error:', e)),
      HEARTBEAT_INTERVAL_MS
    )
    log.info('Heartbeat manager started (30min interval)')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const [key, target] of this.targets) {
      const last = this.lastSent.get(key) ?? 0
      if (now - last < HEARTBEAT_DEDUP_MS) continue // already sent within 24h

      log.debug(`Heartbeat -> ${key}`)
      this.lastSent.set(key, now)
      this.saveState()

      try {
        await this.callback(target, async (text) => {
          // Only log here — the gateway callback sends the actual message
          log.debug(`Heartbeat response for ${key}: ${text.slice(0, 80)}`)
        })
      } catch (e) {
        log.warn(`Heartbeat failed for ${key}: ${e}`)
      }
    }
  }

  private statePath(): string {
    return path.join(DATA_DIR, 'heartbeat-state.json')
  }

  private loadState(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'))
      for (const [k, v] of Object.entries(data)) {
        this.lastSent.set(k, v as number)
      }
    } catch {}
  }

  private saveState(): void {
    try {
      const p = this.statePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(Object.fromEntries(this.lastSent), null, 2))
    } catch {}
  }
}
