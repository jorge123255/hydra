// Per-session memory — inspired by OpenClaw's MEMORY.md pattern.
// Each channel:thread gets a persistent markdown file the agent can read.
// Injected into session prompt so the agent "remembers" context.

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('memory')

const DATA_DIR = process.env.HYDRA_DATA_DIR
  ? process.env.HYDRA_DATA_DIR
  : path.join(process.env.HOME ?? '~', '.hydra')

function memoryPath(channelId: string, threadId: string): string {
  const safe = threadId.replace(/[^a-z0-9]/gi, '_').slice(0, 64)
  return path.join(DATA_DIR, 'memory', channelId, `${safe}.md`)
}

export function readMemory(channelId: string, threadId: string): string {
  const file = memoryPath(channelId, threadId)
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8').trim()
  } catch (e) {
    log.warn(`Could not read memory for ${channelId}:${threadId}: ${e}`)
  }
  return ''
}

export function writeMemory(channelId: string, threadId: string, content: string): void {
  const file = memoryPath(channelId, threadId)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content.trim() + '\n')
    log.debug(`Memory updated for ${channelId}:${threadId}`)
  } catch (e) {
    log.warn(`Could not write memory: ${e}`)
  }
}

export function appendMemory(channelId: string, threadId: string, entry: string): void {
  const existing = readMemory(channelId, threadId)
  const timestamp = new Date().toISOString().slice(0, 10)
  const updated = existing
    ? `${existing}\n- [${timestamp}] ${entry.trim()}`
    : `# Memory\n\n- [${timestamp}] ${entry.trim()}`
  writeMemory(channelId, threadId, updated)
}

function getCurrentTime(timezone?: string): string {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: timezone ?? 'America/Chicago',
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    })
  } catch {
    return new Date().toISOString()
  }
}

// Build a prompt prefix with user context + memory.
// For OpenCode queries this also includes a tool-use hint so the agent
// fetches real-time data (weather, news, time) instead of refusing.
export function buildMemoryPrompt(channelId: string, threadId: string, includeToolHint = false): string {
  const parts: string[] = []

  const location = process.env.HYDRA_USER_LOCATION
  const timezone = process.env.HYDRA_USER_TIMEZONE
  const time = getCurrentTime(timezone)

  // Context block: always injected so the model knows who/where/when
  const contextLines: string[] = [`Current time: ${time}`]
  if (location) contextLines.push(`User location: ${location}`)
  parts.push(`[Context: ${contextLines.join(' | ')}]`)

  // Tool hint: tell OpenCode to actually USE bash for real-time data
  if (includeToolHint && location) {
    const city = location.split(',')[0].trim()
    parts.push(
      `[You have full bash/tool access. For real-time data, fetch it — don't say you can't. ` +
      `Weather: run \`curl -s "wttr.in/${encodeURIComponent(city)}?format=3"\`. ` +
      `For time-sensitive info, use bash/webfetch rather than your training data.]`
    )
  }

  const memory = readMemory(channelId, threadId)
  if (memory) parts.push(`<memory>\n${memory}\n</memory>`)

  return parts.join('\n') + '\n\n'
}
