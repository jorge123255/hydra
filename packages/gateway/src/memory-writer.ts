// memory-writer.ts — Hydra learns from conversations and updates its own memory.
//
// After each bot reply, scan the exchange for things worth remembering:
//   - Facts George stated about himself, his setup, preferences
//   - Corrections George made ("no, it's actually...")
//   - New context (new server, new project, new preference)
//   - Things Hydra couldn't do but should note for next time
//
// Uses a lightweight local call (devstral) — doesn't add latency to the reply.
// Runs fire-and-forget in the background.
//
// Memory is written to MEMORY.md in Hydra's workspace.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from './logger.js'

const log = createLogger('memory-writer')

const HYDRA_DIR = process.env.HYDRA_DIR ?? '/Users/gszulc/hydra'
const MEMORY_FILE = path.join(HYDRA_DIR, 'MEMORY.md')
const WRITE_LOG = path.join(os.homedir(), '.hydra', 'memory-writes.log')

// Cooldown: don't update memory more than once per 5 minutes per thread
const writeCooldowns = new Map<string, number>()
const COOLDOWN_MS = 5 * 60 * 1000

// Track recent exchanges per thread (user msg + bot reply pairs)
const recentExchanges = new Map<string, Array<{ user: string; bot: string }>>()
const MAX_EXCHANGES = 5

/** Record a user+bot exchange for a thread */
export function recordExchange(threadKey: string, userMsg: string, botReply: string): void {
  const exchanges = recentExchanges.get(threadKey) ?? []
  exchanges.push({ user: userMsg.slice(0, 400), bot: botReply.slice(0, 400) })
  if (exchanges.length > MAX_EXCHANGES) exchanges.shift()
  recentExchanges.set(threadKey, exchanges)
}

/** Check if a message is worth analyzing for memory (filter out noise) */
function isWorthAnalyzing(userMsg: string, botReply: string): boolean {
  const combined = (userMsg + botReply).toLowerCase()
  // Skip pure commands, very short messages, heartbeats
  if (userMsg.startsWith('/') && userMsg.split(' ').length < 3) return false
  if (combined.length < 80) return false
  if (combined.includes('heartbeat_ok') || combined.includes('no_reply')) return false
  return true
}

/** Fire-and-forget: analyze exchange and maybe update MEMORY.md */
export function maybeUpdateMemory(
  threadKey: string,
  userMsg: string,
  botReply: string,
  callAI: (prompt: string, system: string, model: string) => Promise<string>
): void {
  // Cooldown check
  const lastWrite = writeCooldowns.get(threadKey) ?? 0
  if (Date.now() - lastWrite < COOLDOWN_MS) return
  if (!isWorthAnalyzing(userMsg, botReply)) return

  // Record exchange
  recordExchange(threadKey, userMsg, botReply)

  // Fire and forget
  setImmediate(async () => {
    try {
      await analyzeAndUpdate(threadKey, userMsg, botReply, callAI)
    } catch (e) {
      log.warn(`[memory-writer] background update failed: ${e}`)
    }
  })
}

async function analyzeAndUpdate(
  threadKey: string,
  userMsg: string,
  botReply: string,
  callAI: (prompt: string, system: string, model: string) => Promise<string>
): Promise<void> {
  const currentMemory = fs.existsSync(MEMORY_FILE)
    ? fs.readFileSync(MEMORY_FILE, 'utf8').slice(0, 6000)
    : '(empty)'

  const exchanges = recentExchanges.get(threadKey) ?? []
  const exchangeText = exchanges
    .map((e, i) => `[${i + 1}] George: ${e.user}\n    me: ${e.bot}`)
    .join('\n\n')

  const system = `You are agent_smith's memory extractor. Your job is to identify new facts worth remembering from a conversation.

Be selective — only extract things that are:
- NEW facts George shared (not already in memory)
- Corrections to existing info
- New preferences, projects, people, systems
- Things Hydra couldn't do but should track
- Meaningful context that will matter in future conversations

DO NOT extract:
- Things already in MEMORY.md
- Casual chitchat
- Temporary questions with no lasting relevance
- Anything George already knows

Output format — ONLY if there's something genuinely new:
LEARN: <one concrete fact to add or update, max 2 sentences>

If nothing new, output exactly: NOTHING

Do not output anything else.`

  const prompt = `## Current MEMORY.md (excerpt):
${currentMemory}

## Recent conversation:
${exchangeText}

## Latest exchange:
George: ${userMsg}
me: ${botReply}

What, if anything, is new and worth remembering?`

  let result: string
  try {
    result = await callAI(prompt, system, 'qwen3:8b')
  } catch {
    // Try smaller model
    try {
      result = await callAI(prompt, system, 'qwen3:8b')
    } catch (e) {
      log.warn(`[memory-writer] AI call failed: ${e}`)
      return
    }
  }

  result = result.trim()
  if (!result || result === 'NOTHING' || !result.startsWith('LEARN:')) return

  const fact = result.replace(/^LEARN:\s*/i, '').trim()
  if (!fact || fact.length < 10) return

  // Append to MEMORY.md
  await writeToMemory(fact)
  writeCooldowns.set(threadKey, Date.now())

  log.info(`[memory-writer] learned: ${fact.slice(0, 80)}`)
  fs.appendFileSync(WRITE_LOG, `[${new Date().toISOString()}] ${fact}\n`)
}

async function writeToMemory(fact: string): Promise<void> {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)

  let content = fs.existsSync(MEMORY_FILE)
    ? fs.readFileSync(MEMORY_FILE, 'utf8')
    : '# MEMORY.md\n\n'

  // Look for an "## Auto-learned" section or create one
  const SECTION = '## Auto-learned'
  if (content.includes(SECTION)) {
    // Append after the section header
    content = content.replace(
      SECTION,
      `${SECTION}\n- [${dateStr}] ${fact}`
    )
  } else {
    content = content.trimEnd() + `\n\n${SECTION}\n- [${dateStr}] ${fact}\n`
  }

  fs.writeFileSync(MEMORY_FILE, content)
}

/** Summarize and compact the auto-learned section if it gets too long */
export async function compactMemoryIfNeeded(
  callAI: (prompt: string, system: string, model: string) => Promise<string>
): Promise<void> {
  if (!fs.existsSync(MEMORY_FILE)) return
  const content = fs.readFileSync(MEMORY_FILE, 'utf8')
  const SECTION = '## Auto-learned'
  const idx = content.indexOf(SECTION)
  if (idx === -1) return

  const autoSection = content.slice(idx)
  const lines = autoSection.split('\n').filter(l => l.startsWith('- ['))
  if (lines.length < 20) return // Only compact when there's enough to work with

  log.info(`[memory-writer] compacting ${lines.length} auto-learned facts`)

  const system = `You are compacting a memory file. Merge, deduplicate, and rewrite these learned facts into a clean organized section. Group related facts. Keep everything important. Output ONLY the new section content starting with "## Auto-learned".`
  const prompt = autoSection

  try {
    const compacted = await callAI(prompt, system, 'qwen3:8b')
    if (compacted.includes(SECTION)) {
      const before = content.slice(0, idx)
      fs.writeFileSync(MEMORY_FILE, before + compacted.trimEnd() + '\n')
      log.info('[memory-writer] memory compacted')
    }
  } catch (e) {
    log.warn(`[memory-writer] compact failed: ${e}`)
  }
}

/** Return recent memory writes for status display */
export function getMemoryWriteLog(limit = 10): string[] {
  try {
    if (!fs.existsSync(WRITE_LOG)) return []
    return fs.readFileSync(WRITE_LOG, 'utf8')
      .trim().split('\n')
      .filter(Boolean)
      .slice(-limit)
  } catch { return [] }
}
