// GitHub Copilot OAuth auth.
// Ported from OpenClaw src/providers/github-copilot-auth.ts + github-copilot-token.ts
// Gives free access to claude-sonnet-4.6 (with vision), gpt-4o, gpt-4.1 etc.
//
// One-time setup: run `node -e "require('./dist/auth/github-copilot.js').githubCopilotLogin()"
// or trigger via /copilot-login bot command.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../logger.js'

const log = createLogger('copilot-auth')

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
export const DEFAULT_COPILOT_BASE_URL = 'https://api.individual.githubcopilot.com'
const CACHE_DIR = path.join(os.homedir(), '.hydra', 'credentials')

fs.mkdirSync(CACHE_DIR, { recursive: true })

const GITHUB_TOKEN_PATH = path.join(CACHE_DIR, 'github-copilot-github.json')
const COPILOT_TOKEN_PATH = path.join(CACHE_DIR, 'github-copilot.token.json')

type GitHubTokenStore = { token: string; savedAt: string }
type CopilotTokenCache = { token: string; expiresAt: number; updatedAt: number }

export type CopilotCredentials = {
  token: string
  baseUrl: string
  expiresAt: number
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return null }
}
function writeJson(p: string, val: unknown) {
  fs.writeFileSync(p + '.tmp', JSON.stringify(val, null, 2))
  fs.renameSync(p + '.tmp', p)
}

function deriveBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)
  const proxyEp = match?.[1]?.trim()
  if (!proxyEp) return DEFAULT_COPILOT_BASE_URL
  const host = proxyEp.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.')
  return `https://${host}`
}

/** One-time interactive GitHub device flow login */
export async function githubCopilotLogin(): Promise<void> {
  // Request device code
  const dcRes = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
  })
  if (!dcRes.ok) throw new Error(`GitHub device code failed: ${dcRes.status}`)
  const dc = await dcRes.json() as any

  log.info(`\n🔗 Visit: ${dc.verification_uri}\n🔑 Enter code: ${dc.user_code}\n`)
  console.log(`\n🔗 Visit: ${dc.verification_uri}\n🔑 Enter code: ${dc.user_code}\n`)

  const expiresAt = Date.now() + dc.expires_in * 1000
  const intervalMs = Math.max(1000, dc.interval * 1000)

  // Poll for token
  let accessToken: string | null = null
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: dc.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const json = await res.json() as any
    if (json.access_token) { accessToken = json.access_token; break }
    if (json.error === 'authorization_pending') continue
    if (json.error === 'slow_down') { await new Promise((r) => setTimeout(r, 2000)); continue }
    throw new Error(`GitHub auth error: ${json.error}`)
  }

  if (!accessToken) throw new Error('GitHub device code expired')
  writeJson(GITHUB_TOKEN_PATH, { token: accessToken, savedAt: new Date().toISOString() })
  log.info('✅ GitHub Copilot login successful — token saved')
  console.log('✅ GitHub Copilot login successful')
}

/** Resolve a valid Copilot API token (auto-refreshes when near expiry) */
export async function resolveCopilotCredentials(): Promise<CopilotCredentials | null> {
  const githubStore = readJson<GitHubTokenStore>(GITHUB_TOKEN_PATH)
  if (!githubStore?.token) {
    log.debug('No GitHub Copilot token found — run /copilot-login first')
    return null
  }

  // Check cached Copilot token (valid if >5min remaining)
  const cached = readJson<CopilotTokenCache>(COPILOT_TOKEN_PATH)
  if (cached && typeof cached.expiresAt === 'number' && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return { token: cached.token, baseUrl: deriveBaseUrl(cached.token), expiresAt: cached.expiresAt }
  }

  // Exchange GitHub token for Copilot token
  log.debug('Refreshing Copilot API token...')
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${githubStore.token}` },
  })
  if (!res.ok) {
    log.warn(`Copilot token exchange failed: ${res.status}`)
    return null
  }
  const json = await res.json() as any
  const token = json.token as string
  // GitHub returns unix timestamp (seconds)
  const expiresAt = (typeof json.expires_at === 'number'
    ? (json.expires_at > 10_000_000_000 ? json.expires_at : json.expires_at * 1000)
    : Date.now() + 25 * 60 * 1000) // default 25 min

  const payload: CopilotTokenCache = { token, expiresAt, updatedAt: Date.now() }
  writeJson(COPILOT_TOKEN_PATH, payload)

  return { token, baseUrl: deriveBaseUrl(token), expiresAt }
}

/** Check if Copilot is configured */
export function isCopilotConfigured(): boolean {
  return fs.existsSync(GITHUB_TOKEN_PATH)
}

/** Available models via Copilot (all cost=0, vision-capable) */
export const COPILOT_MODELS = [
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'o3-mini',
] as const

export type CopilotModel = typeof COPILOT_MODELS[number]
