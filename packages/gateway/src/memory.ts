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

/** Search memory files for a keyword/phrase. Returns matching lines with file context. */
export function searchMemory(channelId: string, query: string): string {
  const memDir = path.join(DATA_DIR, 'memory', channelId)
  const results: string[] = []
  try {
    if (!fs.existsSync(memDir)) return 'No memory files found.'
    const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md'))
    const lowerQuery = query.toLowerCase()
    for (const file of files) {
      const content = fs.readFileSync(path.join(memDir, file), 'utf8')
      const lines = content.split('\n')
      const matches = lines.filter((l) => l.toLowerCase().includes(lowerQuery))
      if (matches.length) {
        results.push(`[${file}]`, ...matches)
      }
    }
  } catch (e) {
    log.warn(`searchMemory error: ${e}`)
  }
  return results.length ? results.join('\n') : `No results for "${query}".`
}

export function getCurrentTime(timezone?: string): string {
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

/** Build a message envelope header — ported from OpenClaw (feature 3).
 *  Format: [telegram george +2m15s Fri 14-Mar 10:30 CST]
 */
export function buildEnvelope(
  channelId: string,
  senderName: string | undefined,
  timestamp: Date,
  lastMessageAt?: Date
): string {
  const parts: string[] = [channelId]

  if (senderName) parts.push(senderName)

  if (lastMessageAt) {
    const elapsedMs = timestamp.getTime() - lastMessageAt.getTime()
    const elapsed = formatElapsed(elapsedMs)
    if (elapsed) parts.push(`+${elapsed}`)
  }

  const tz = process.env.HYDRA_USER_TIMEZONE ?? 'America/Chicago'
  const dateStr = timestamp.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  })
  parts.push(dateStr)

  return `[${parts.join(' ')}]`
}

function formatElapsed(ms: number): string {
  if (ms < 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins === 0 && secs < 5) return '' // negligible
  if (mins === 0) return `${secs}s`
  if (secs === 0) return `${mins}m`
  return `${mins}m${secs}s`
}

/** Build a prompt prefix with context + memory for direct-chat calls.
 *  For OpenCode queries this also includes a tool-use hint.
 */
export function buildMemoryPrompt(channelId: string, threadId: string, includeToolHint = false): string {
  const parts: string[] = []

  const location = process.env.HYDRA_USER_LOCATION
  const timezone = process.env.HYDRA_USER_TIMEZONE
  const time = getCurrentTime(timezone)

  const contextLines: string[] = [`Current time: ${time}`]
  if (location) contextLines.push(`User location: ${location}`)
  parts.push(`[Context: ${contextLines.join(' | ')}]`)

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

// ── Long-term memory compression ──────────────────────────────────────────────
// When a memory file grows beyond COMPRESS_THRESHOLD lines, summarize older
// entries via AI and replace them with a compact summary, keeping the most
// recent KEEP_RECENT entries verbatim.

const COMPRESS_THRESHOLD = 80  // lines before triggering compression
const KEEP_RECENT = 20         // recent lines to keep verbatim

/** Compress memory if it has grown too large. Pass callAI to summarize old entries. */
export async function compressMemoryIfNeeded(
  channelId: string,
  threadId: string,
  callAI?: (prompt: string) => Promise<string>
): Promise<void> {
  const existing = readMemory(channelId, threadId)
  if (!existing) return

  const lines = existing.split('\n').filter((l) => l.trim())
  if (lines.length < COMPRESS_THRESHOLD) return

  log.info(`Compressing memory for ${channelId}:${threadId} (${lines.length} lines)`)

  const older = lines.slice(0, lines.length - KEEP_RECENT)
  const recent = lines.slice(lines.length - KEEP_RECENT)

  let summary = '(prior history compressed)'
  if (callAI) {
    try {
      summary = await callAI(
        `Summarize these memory entries into a compact bullet-point list (max 10 bullets). ` +
        `Preserve all factual details about the user and important context. Be concise.\n\n` +
        older.join('\n')
      )
    } catch (e) {
      log.warn(`Memory compression AI call failed: ${e}`)
    }
  }

  const archivePath = memoryPath(channelId, threadId).replace('.md', `-archive-${Date.now()}.md`)
  try {
    fs.writeFileSync(archivePath, older.join('\n'))
  } catch {}

  const compressed =
    `# Memory\n\n## Summary of prior history\n${summary}\n\n## Recent\n` +
    recent.join('\n')

  writeMemory(channelId, threadId, compressed)
  log.info(`Memory compressed: ${older.length} lines → summary + ${recent.length} recent`)
}
