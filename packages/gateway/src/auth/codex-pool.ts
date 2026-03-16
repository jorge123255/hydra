// Multi-account OpenAI subagent pool.
// ChatGPT accounts added via /chatgpt_login label sk-...
// agent_smith fans out [SUBAGENT: task] tags to these accounts in parallel.
//
// Pool file: ~/.hydra/credentials/codex-pool.json

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../logger.js'

const log = createLogger('codex-pool')

const CREDS_DIR = path.join(os.homedir(), '.hydra', 'credentials')
const POOL_FILE = path.join(CREDS_DIR, 'codex-pool.json')
const SUBAGENT_MODEL = process.env.HYDRA_SUBAGENT_MODEL ?? 'gpt-4o-mini'

export type PoolAccount = {
  id: string
  label: string
  apiKey: string
  callCount: number
  lastUsedAt: number
  rateLimitedUntil: number
}

function loadPool(): PoolAccount[] {
  try {
    if (!fs.existsSync(POOL_FILE)) return []
    return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'))
  } catch { return [] }
}

function savePool(accounts: PoolAccount[]): void {
  fs.mkdirSync(CREDS_DIR, { recursive: true })
  fs.writeFileSync(POOL_FILE, JSON.stringify(accounts, null, 2))
}

export function isCodexPoolConfigured(): boolean {
  return loadPool().length > 0
}

export function listPoolAccounts(): Array<{ id: string; label: string; callCount: number; rateLimitedUntil: number }> {
  return loadPool().map(({ id, label, callCount, rateLimitedUntil }) => ({ id, label, callCount, rateLimitedUntil }))
}

export async function addKeyToPool(label: string, apiKey: string): Promise<void> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`Invalid API key — OpenAI returned ${res.status}`)
  const pool = loadPool()
  const existing = pool.find(a => a.label === label)
  if (existing) {
    existing.apiKey = apiKey
    log.info(`Updated account "${label}"`)
  } else {
    pool.push({ id: Math.random().toString(36).slice(2, 8), label, apiKey, callCount: 0, lastUsedAt: 0, rateLimitedUntil: 0 })
    log.info(`Added account "${label}" to pool (${pool.length} total)`)
  }
  savePool(pool)
}

export function removeAccountFromPool(idOrLabel: string): boolean {
  const pool = loadPool()
  const idx = pool.findIndex(a => a.id === idOrLabel || a.label === idOrLabel)
  if (idx === -1) return false
  pool.splice(idx, 1)
  savePool(pool)
  return true
}

// Pick the least-recently-used non-rate-limited account
function pickAccount(pool: PoolAccount[]): PoolAccount | null {
  const now = Date.now()
  const available = pool.filter(a => a.rateLimitedUntil < now)
  if (available.length === 0) return null
  return available.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
}

// Call one subagent task on the best available account
export async function callSubagent(task: string, systemPrompt?: string): Promise<string> {
  const pool = loadPool()
  const account = pickAccount(pool)
  if (!account) throw new Error('No available ChatGPT accounts (all rate-limited)')

  account.lastUsedAt = Date.now()
  account.callCount++
  savePool(pool)

  const messages: Array<{ role: string; content: string }> = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: task })

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SUBAGENT_MODEL, messages, max_tokens: 4096 }),
  })

  if (res.status === 429) {
    account.rateLimitedUntil = Date.now() + 60_000
    savePool(pool)
    throw new Error(`Account "${account.label}" rate-limited, try again in 60s`)
  }
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`)
  const data = (await res.json()) as any
  return data.choices?.[0]?.message?.content ?? ''
}

// Fan out N tasks to N accounts in parallel
export async function callSubagentsParallel(tasks: string[], systemPrompt?: string): Promise<string[]> {
  return Promise.all(tasks.map(task => callSubagent(task, systemPrompt)))
}
