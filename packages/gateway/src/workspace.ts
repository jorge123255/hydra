// Bootstrap workspace files manager — ported from OpenClaw (feature 2).
// Ensures SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md, BOOTSTRAP.md exist in workdir.
// These files get injected into the system prompt so the agent has persistent context.

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('workspace')

export type WorkspaceContext = {
  channelId: string
  senderId: string
  senderName?: string
  location?: string
  timezone?: string
}

const BOOTSTRAP_CONTENT = `# Hydra Bootstrap

This is your workspace. The following files provide persistent context:
- SOUL.md — your identity and purpose
- USER.md — information about the user
- MEMORY.md — accumulated notes and context
- HEARTBEAT.md — proactive check-in log

Read these files at the start of each session to restore context.
`

const SOUL_CONTENT = `# Soul

You are Hydra — a personal AI assistant built for deep work.

You live across multiple messaging channels (Telegram, Discord, Slack) and share
a persistent workspace on this machine. You have filesystem, bash, and tool access.

Your purpose:
- Help the owner get things done efficiently
- Remember context across conversations
- Proactively surface useful information when checking in
- Be direct, capable, and low-ceremony
- Never be sycophantic — be useful
`

/** Ensure all bootstrap files exist in workdir. Creates defaults if missing. */
export function ensureWorkspaceFiles(workdir: string, ctx: WorkspaceContext): void {
  try {
    fs.mkdirSync(workdir, { recursive: true })

    const defaults: Record<string, string> = {
      'BOOTSTRAP.md': BOOTSTRAP_CONTENT,
      'SOUL.md': SOUL_CONTENT,
      'USER.md': buildUserFile(ctx),
      'MEMORY.md': '# Memory\n\n(No notes yet.)\n',
      'HEARTBEAT.md': '# Heartbeat Log\n\n(No check-ins yet.)\n',
    }

    for (const [filename, content] of Object.entries(defaults)) {
      const filePath = path.join(workdir, filename)
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content)
        log.debug(`Created ${filename} in ${workdir}`)
      }
    }
  } catch (e) {
    log.warn(`Could not ensure workspace files: ${e}`)
  }
}

/** Read all bootstrap files from workdir, return as filename -> content map */
export function readWorkspaceFiles(workdir: string): Record<string, string> {
  const filenames = ['SOUL.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']
  const result: Record<string, string> = {}
  for (const filename of filenames) {
    const filePath = path.join(workdir, filename)
    try {
      if (fs.existsSync(filePath)) {
        result[filename] = fs.readFileSync(filePath, 'utf8').trim()
      }
    } catch {}
  }
  return result
}

/** Append a note to MEMORY.md in workdir */
export function appendWorkspaceMemory(workdir: string, entry: string): void {
  const filePath = path.join(workdir, 'MEMORY.md')
  const timestamp = new Date().toISOString().slice(0, 10)
  let existing = '# Memory\n\n'
  try { existing = fs.readFileSync(filePath, 'utf8') } catch {}
  const updated = `${existing.trim()}\n- [${timestamp}] ${entry.trim()}\n`
  try { fs.writeFileSync(filePath, updated) } catch (e) { log.warn(`MEMORY.md write failed: ${e}`) }
}

/** Append to HEARTBEAT.md */
export function logHeartbeat(workdir: string, status: string): void {
  const filePath = path.join(workdir, 'HEARTBEAT.md')
  const timestamp = new Date().toISOString()
  let existing = '# Heartbeat Log\n\n'
  try { existing = fs.readFileSync(filePath, 'utf8') } catch {}
  const updated = `${existing.trim()}\n- [${timestamp}] ${status}\n`
  try { fs.writeFileSync(filePath, updated) } catch (e) { log.warn(`HEARTBEAT.md write failed: ${e}`) }
}

function buildUserFile(ctx: WorkspaceContext): string {
  const lines = ['# User Profile', '']
  lines.push(`Channel: ${ctx.channelId}`)
  if (ctx.senderName) lines.push(`Name: ${ctx.senderName}`)
  if (ctx.location) lines.push(`Location: ${ctx.location}`)
  if (ctx.timezone) lines.push(`Timezone: ${ctx.timezone}`)
  lines.push('')
  return lines.join('\n')
}
