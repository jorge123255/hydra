// Knowledge Expiration — facts with TTL that auto-expire.
// AI tags facts: [FACT: content | 7d] or [FACT: content | 2026-03-20]
// Gateway sweeps expired facts on startup + every hour.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const FACTS_FILE = path.join(os.homedir(), '.hydra', 'facts.json')
const MAX_FACTS = 200

export interface Fact {
  id: number
  text: string
  channel: string
  threadId: string
  createdAt: string
  expiresAt: string | null   // ISO or null = permanent
  expired: boolean
}

function ensureDir() {
  const d = path.dirname(FACTS_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

function load(): Fact[] {
  try {
    if (fs.existsSync(FACTS_FILE)) return JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'))
  } catch {}
  return []
}

function save(facts: Fact[]) {
  ensureDir()
  fs.writeFileSync(FACTS_FILE, JSON.stringify(facts, null, 2))
}

function parseTTL(ttl: string): string | null {
  if (!ttl) return null
  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(ttl)) return new Date(ttl).toISOString()
  // Relative: 7d, 24h, 30m
  const m = /^(\d+)(d|h|m)$/.exec(ttl.trim())
  if (!m) return null
  const n = parseInt(m[1], 10)
  const unit = m[2]
  const ms = unit === 'd' ? n * 86400000 : unit === 'h' ? n * 3600000 : n * 60000
  return new Date(Date.now() + ms).toISOString()
}

export function addFact(text: string, ttl: string | null, channel: string, threadId: string): Fact {
  const facts = load()
  const maxId = facts.reduce((m, f) => Math.max(m, f.id), 0)
  const fact: Fact = {
    id: maxId + 1,
    text: text.trim(),
    channel,
    threadId,
    createdAt: new Date().toISOString(),
    expiresAt: ttl ? parseTTL(ttl) : null,
    expired: false,
  }
  facts.push(fact)
  if (facts.length > MAX_FACTS) facts.splice(0, facts.length - MAX_FACTS)
  save(facts)
  return fact
}

/** Remove expired facts, return count removed */
export function sweepExpiredFacts(): number {
  const facts = load()
  const now = Date.now()
  let removed = 0
  for (const f of facts) {
    if (!f.expired && f.expiresAt && new Date(f.expiresAt).getTime() < now) {
      f.expired = true
      removed++
    }
  }
  if (removed > 0) save(facts)
  return removed
}

export function listActiveFacts(channel?: string, threadId?: string): Fact[] {
  sweepExpiredFacts()
  return load().filter(f =>
    !f.expired &&
    (!channel || f.channel === channel) &&
    (!threadId || f.threadId === threadId)
  )
}

export function formatFactsList(facts: Fact[]): string {
  if (!facts.length) return 'No active facts.'
  return facts.map(f => {
    const exp = f.expiresAt
      ? ` _(expires ${new Date(f.expiresAt).toISOString().slice(0, 10)})_`
      : ''
    return `📌 [${f.id}] ${f.text}${exp}`
  }).join('\n')
}

/** Parse [FACT: text | ttl] tags from AI response */
export function extractFactTags(text: string, channel: string, threadId: string): { clean: string; count: number } {
  const FACT_TAG = /\[FACT:\s*([^|\]]+)(?:\|\s*([^\]]+))?\]/gi
  let count = 0
  const clean = text.replace(FACT_TAG, (_, factText, ttl) => {
    addFact(factText.trim(), ttl?.trim() ?? null, channel, threadId)
    count++
    return ''
  })
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), count }
}

/** Write FACTS.md to workspace */
export function writeFactsFile(workdir: string, channel: string, threadId: string): void {
  try {
    const facts = listActiveFacts(channel, threadId)
    const lines = ['# FACTS.md — Known Facts', '']
    if (facts.length) {
      facts.forEach(f => {
        const exp = f.expiresAt ? ` (until ${f.expiresAt.slice(0, 10)})` : ''
        lines.push(`- [${f.id}] ${f.text}${exp}`)
      })
    } else {
      lines.push('_No active facts._')
    }
    fs.writeFileSync(path.join(workdir, 'FACTS.md'), lines.join('\n'))
  } catch {}
}

export const FACTS_INSTRUCTION = `\nTo remember a time-limited fact, include [FACT: the fact | ttl] where ttl is like "7d", "24h", or "2026-04-01". Omit ttl for permanent facts.`

let sweepTimer: ReturnType<typeof setInterval> | null = null
export function startFactSweepLoop(): void {
  if (sweepTimer) return
  sweepExpiredFacts()
  sweepTimer = setInterval(() => sweepExpiredFacts(), 60 * 60 * 1000)
}
