// Multi-account ChatGPT pool.
// Manages N ChatGPT OAuth accounts with:
//   - Round-robin load balancing (least-recently-used)
//   - Automatic rate-limit avoidance (skip limited accounts)
//   - Parallel fan-out for multi-task execution
//   - Auto-refresh of expired tokens
//
// Commands: /chatgpt-login [label] to add accounts
// Pool file: ~/.hydra/credentials/codex-pool.json

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../logger.js'

const log = createLogger('codex-pool')

const CREDS_DIR = path.join(os.homedir(), '.hydra', 'credentials')
const POOL_FILE = path.join(CREDS_DIR, 'codex-pool.json')

const CLIENT_ID    = 'pdlLIX2Y72MIl2rhLhTE9VV9bVudePEU'
const AUTH0_DOMAIN = 'auth0.openai.com'
const CODEX_BASE   = 'https://chatgpt.com/backend-api'

export type PoolAccount = {
  id: string
  label: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  lastUsedAt: number
  rateLimitedUntil: number
  callCount: number
}

type Pool = { accounts: PoolAccount[] }

// ── Persistence ───────────────────────────────────────────────────────────────

function loadPool(): Pool {
  try {
    if (fs.existsSync(POOL_FILE)) {
      return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')) as Pool
    }
  } catch {}
  return { accounts: [] }
}

function savePool(pool: Pool): void {
  fs.mkdirSync(CREDS_DIR, { recursive: true })
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2))
}

// ── Token management ──────────────────────────────────────────────────────────

async function refreshToken(account: PoolAccount): Promise<boolean> {
  if (!account.refreshToken) return false
  try {
    const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: account.refreshToken,
      }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as any
    if (!data.access_token) return false
    account.accessToken = data.access_token
    if (data.refresh_token) account.refreshToken = data.refresh_token
    account.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
    return true
  } catch {
    return false
  }
}

// ── Account selection ─────────────────────────────────────────────────────────

/** Get the best available account (LRU, skip rate-limited/expired) */
async function getAvailableAccount(): Promise<PoolAccount | null> {
  const pool = loadPool()
  const now = Date.now()

  // Filter out rate-limited accounts
  const candidates = pool.accounts.filter((a) => a.rateLimitedUntil < now)
  if (!candidates.length) return null

  // Sort by least recently used
  candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)

  for (const account of candidates) {
    // Refresh if token expiring soon
    if (account.expiresAt - now < 5 * 60 * 1000) {
      const ok = await refreshToken(account)
      if (!ok) continue
      savePool(pool)
    }
    return account
  }
  return null
}

/** Mark an account as rate-limited for 60 seconds */
function markRateLimited(pool: Pool, accountId: string): void {
  const account = pool.accounts.find((a) => a.id === accountId)
  if (account) {
    account.rateLimitedUntil = Date.now() + 60_000
    savePool(pool)
    log.warn(`Account ${account.label} rate-limited for 60s`)
  }
}

/** Record a successful use of an account */
function recordUse(pool: Pool, accountId: string): void {
  const account = pool.accounts.find((a) => a.id === accountId)
  if (account) {
    account.lastUsedAt = Date.now()
    account.callCount = (account.callCount ?? 0) + 1
    savePool(pool)
  }
}

// ── Single call ───────────────────────────────────────────────────────────────

export async function callCodexPool(
  prompt: string,
  systemPrompt?: string,
  model = 'gpt-4o'
): Promise<string> {
  const pool = loadPool()
  const account = await getAvailableAccount()
  if (!account) throw new Error('No available ChatGPT accounts in pool — run /chatgpt-login to add one')

  try {
    const result = await callWithAccount(account, prompt, systemPrompt, model)
    recordUse(pool, account.id)
    return result
  } catch (e) {
    const msg = String(e)
    if (msg.includes('429') || msg.includes('rate')) {
      markRateLimited(pool, account.id)
      // Try another account
      const fallback = await getAvailableAccount()
      if (fallback && fallback.id !== account.id) {
        const result = await callWithAccount(fallback, prompt, systemPrompt, model)
        recordUse(pool, fallback.id)
        return result
      }
    }
    throw e
  }
}

async function callWithAccount(
  account: PoolAccount,
  prompt: string,
  systemPrompt?: string,
  model = 'gpt-4o'
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })

  const res = await fetch(`${CODEX_BASE}/conversation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.accessToken}`,
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ChatGPT error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as any
  return (
    data.message?.content?.parts?.[0] ??
    data.choices?.[0]?.message?.content ??
    '[No response from ChatGPT]'
  )
}

// ── Parallel fan-out ──────────────────────────────────────────────────────────

export type ParallelTask = {
  id: string
  prompt: string
  systemPrompt?: string
}

export type ParallelResult = {
  id: string
  result?: string
  error?: string
  accountLabel?: string
}

/**
 * Fan out multiple tasks across all available accounts simultaneously.
 * Each task gets its own account. Extra tasks queue on free accounts.
 */
export async function callCodexParallel(tasks: ParallelTask[]): Promise<ParallelResult[]> {
  const pool = loadPool()
  const now = Date.now()
  const available = pool.accounts
    .filter((a) => a.rateLimitedUntil < now)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)

  if (!available.length) {
    return tasks.map((t) => ({ id: t.id, error: 'No available accounts' }))
  }

  // Assign tasks to accounts round-robin
  const assignments = tasks.map((task, i) => ({
    task,
    account: available[i % available.length],
  }))

  // Refresh tokens for all accounts that need it
  for (const account of available) {
    if (account.expiresAt - now < 5 * 60 * 1000) {
      await refreshToken(account)
    }
  }
  savePool(pool)

  // Execute all in parallel
  const results = await Promise.allSettled(
    assignments.map(async ({ task, account }) => {
      const result = await callWithAccount(account, task.prompt, task.systemPrompt)
      recordUse(pool, account.id)
      return { id: task.id, result, accountLabel: account.label }
    })
  )

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    return { id: tasks[i].id, error: String(r.reason) }
  })
}

// ── Account management ────────────────────────────────────────────────────────

export function isCodexPoolConfigured(): boolean {
  const pool = loadPool()
  return pool.accounts.length > 0
}

export function listPoolAccounts(): Array<{
  id: string; label: string; callCount: number; available: boolean; rateLimitedUntil: number
}> {
  const pool = loadPool()
  const now = Date.now()
  return pool.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    callCount: a.callCount ?? 0,
    available: a.rateLimitedUntil < now,
    rateLimitedUntil: a.rateLimitedUntil,
  }))
}

export function addAccountToPool(account: Omit<PoolAccount, 'id' | 'lastUsedAt' | 'rateLimitedUntil' | 'callCount'>): string {
  const pool = loadPool()
  const id = `account-${Date.now()}`
  pool.accounts.push({
    ...account,
    id,
    lastUsedAt: 0,
    rateLimitedUntil: 0,
    callCount: 0,
  })
  savePool(pool)
  log.info(`Added account ${account.label} to pool (total: ${pool.accounts.length})`)
  return id
}

export function removeAccountFromPool(id: string): boolean {
  const pool = loadPool()
  const before = pool.accounts.length
  pool.accounts = pool.accounts.filter((a) => a.id !== id)
  if (pool.accounts.length < before) { savePool(pool); return true }
  return false
}

// ── OAuth device flow (same as chatgpt-codex.ts) ─────────────────────────────

export async function startCodexPoolLogin(label: string): Promise<{
  verificationUri: string
  userCode: string
  poll: () => Promise<boolean>
}> {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: 'openid profile email offline_access',
      audience: 'https://api.openai.com/v1',
    }),
  })
  if (!res.ok) throw new Error(`Device code request failed: ${res.status}`)
  const data = (await res.json()) as any

  const poll = async (): Promise<boolean> => {
    const deadline = Date.now() + (data.expires_in ?? 300) * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, (data.interval ?? 5) * 1000))
      try {
        const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: CLIENT_ID,
            device_code: data.device_code,
          }),
        })
        if (!tokenRes.ok) continue
        const tokens = (await tokenRes.json()) as any
        if (!tokens.access_token) continue
        addAccountToPool({
          label,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        })
        return true
      } catch {}
    }
    return false
  }

  return { verificationUri: data.verification_uri_complete ?? data.verification_uri, userCode: data.user_code, poll }
}
