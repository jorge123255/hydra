import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const POOL_FILE = path.join(os.homedir(), '.hydra', 'credentials', 'codex-pool.json')

// OpenAI Codex CLI OAuth device flow constants
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEVICE_AUTH_URL = 'https://auth.openai.com/codex/device'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPES = 'openid profile email offline_access'
const OPENAI_API_BASE = 'https://api.openai.com/v1'

export interface PoolAccount {
  id: string
  label: string
  // OAuth token storage
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  // API key fallback
  apiKey?: string
  callCount: number
  rateLimitedUntil?: number
  lastUsedAt?: number
  disabled?: boolean
}

interface PoolFile {
  accounts: PoolAccount[]
}

function ensureDir() {
  const d = path.dirname(POOL_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

function loadPool(): PoolFile {
  try {
    if (fs.existsSync(POOL_FILE)) return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'))
  } catch {}
  return { accounts: [] }
}

function savePool(pool: PoolFile) {
  ensureDir()
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2))
}

// ─── OAuth Device Flow ───────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CODEX_CLIENT_ID,
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Device flow start failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

export async function pollForToken(
  deviceCode: string,
  intervalSec: number,
  timeoutSec = 900,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number } | null> {
  const deadline = Date.now() + timeoutSec * 1000
  const pollMs = Math.max(intervalSec, 5) * 1000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CODEX_CLIENT_ID,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json() as any
      if (data.access_token) {
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        }
      }
      if (data.error === 'authorization_pending') continue
      if (data.error === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue }
      if (data.error === 'expired_token') return null
      if (data.error) throw new Error(`Token poll error: ${data.error}`)
    } catch (e: any) {
      if (e.message?.includes('Token poll error')) throw e
      // network errors — keep polling
    }
  }
  return null // timed out
}

async function refreshAccessToken(account: PoolAccount): Promise<boolean> {
  if (!account.refreshToken) return false
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json() as any
    if (!data.access_token) return false
    account.accessToken = data.access_token
    if (data.refresh_token) account.refreshToken = data.refresh_token
    account.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
    return true
  } catch {
    return false
  }
}

// ─── Account Management ──────────────────────────────────────────────────────

export function saveOAuthAccount(
  label: string,
  tokens: { accessToken: string; refreshToken?: string; expiresAt: number },
): PoolAccount {
  const pool = loadPool()
  const existing = pool.accounts.find(a => a.label === label)
  if (existing) {
    existing.accessToken = tokens.accessToken
    existing.refreshToken = tokens.refreshToken
    existing.expiresAt = tokens.expiresAt
    existing.disabled = false
    savePool(pool)
    return existing
  }
  const account: PoolAccount = {
    id: `codex_${Date.now()}`,
    label,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    callCount: 0,
  }
  pool.accounts.push(account)
  savePool(pool)
  return account
}

export async function addKeyToPool(label: string, apiKey: string): Promise<PoolAccount> {
  // Validate key works
  const res = await fetch(`${OPENAI_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Invalid API key: ${res.status}`)

  const pool = loadPool()
  const existing = pool.accounts.find(a => a.label === label)
  if (existing) {
    existing.apiKey = apiKey
    existing.disabled = false
    savePool(pool)
    return existing
  }
  const account: PoolAccount = { id: `key_${Date.now()}`, label, apiKey, callCount: 0 }
  pool.accounts.push(account)
  savePool(pool)
  return account
}

export function listPoolAccounts(): PoolAccount[] {
  return loadPool().accounts
}

export function removeAccountFromPool(labelOrId: string): boolean {
  const pool = loadPool()
  const before = pool.accounts.length
  pool.accounts = pool.accounts.filter(a => a.label !== labelOrId && a.id !== labelOrId)
  if (pool.accounts.length !== before) { savePool(pool); return true }
  return false
}

export function isCodexPoolConfigured(): boolean {
  return loadPool().accounts.some(a => !a.disabled && (a.apiKey || a.accessToken))
}

// ─── Call Subagent ───────────────────────────────────────────────────────────

function pickAccount(pool: PoolFile): PoolAccount | null {
  const now = Date.now()
  const available = pool.accounts.filter(
    a => !a.disabled && (a.apiKey || a.accessToken) &&
         (!a.rateLimitedUntil || a.rateLimitedUntil < now)
  )
  if (!available.length) return null
  // LRU: pick least recently used
  return available.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0]
}

export async function callSubagent(
  task: string,
  systemPrompt?: string,
): Promise<string> {
  const pool = loadPool()
  const account = pickAccount(pool)
  if (!account) throw new Error('No available ChatGPT accounts in pool')

  // Refresh OAuth token if needed
  if (account.accessToken && account.expiresAt && account.expiresAt < Date.now() + 60000) {
    const refreshed = await refreshAccessToken(account)
    if (!refreshed && !account.apiKey) {
      account.disabled = true
      savePool(pool)
      throw new Error(`Account ${account.label} token expired and refresh failed`)
    }
    savePool(pool)
  }

  const bearer = account.apiKey ?? account.accessToken!
  account.callCount++
  account.lastUsedAt = Date.now()
  savePool(pool)

  const messages: any[] = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: task })

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ model: 'gpt-4o', messages }),
    signal: AbortSignal.timeout(60000),
  })

  if (res.status === 429) {
    account.rateLimitedUntil = Date.now() + 60000
    savePool(pool)
    throw new Error('Rate limited')
  }

  if (!res.ok) {
    const body = await res.text()
    if (res.status === 401) {
      account.disabled = true
      savePool(pool)
    }
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json() as any
  return data.choices?.[0]?.message?.content ?? ''
}

export async function callSubagentsParallel(tasks: string[], systemPrompt?: string): Promise<string[]> {
  return Promise.all(tasks.map(t => callSubagent(t, systemPrompt).catch(e => `[error: ${e}]`)))
}

export function isCodexConfigured(): boolean {
  return isCodexPoolConfigured()
}
