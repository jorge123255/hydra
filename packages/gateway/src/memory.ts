// Per-session memory — inspired by OpenClaw's MEMORY.md pattern.
// Each channel:thread gets a persistent markdown file the agent can read.
// Injected into session system prompt so the agent "remembers" context.

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

// Build a system prompt prefix with memory context
export function buildMemoryPrompt(channelId: string, threadId: string): string {
  const memory = readMemory(channelId, threadId)
  if (!memory) return ''
  return `<memory>\n${memory}\n</memory>\n\n`
}
