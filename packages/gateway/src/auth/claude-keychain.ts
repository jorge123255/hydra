// Read Claude Code's stored OAuth credentials from macOS Keychain or credentials file.
// Claude Code stores its OAuth session under service "Claude Code-credentials".
// The token is used as: Authorization: Bearer <accessToken> with the Anthropic API.
//
// Token refresh is handled by Claude Code itself — if expired, user needs to
// open Claude Code once to refresh, then Hydra picks it up automatically.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../logger.js'

const log = createLogger('claude-auth')

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json')
// Written by scripts/sync-claude-auth.sh (readable by daemon without keychain access)
const SYNCED_FILE = path.join(os.homedir(), '.hydra', 'credentials', 'claude-code-oauth.json')

export type ClaudeOAuthCreds = {
  accessToken: string
  refreshToken?: string
  expiresAt: number   // ms since epoch
}

function parseCredentialJson(raw: unknown): ClaudeOAuthCreds | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const oauth = data.claudeAiOauth as Record<string, unknown> | undefined
  if (!oauth) return null

  const accessToken = oauth.accessToken
  const expiresAt = oauth.expiresAt
  if (typeof accessToken !== 'string' || !accessToken) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null

  return {
    accessToken,
    refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
    expiresAt,
  }
}

/** Read from macOS Keychain (requires unlocked login keychain — works in GUI/launchd session) */
function readFromKeychain(): ClaudeOAuthCreds | null {
  if (process.platform !== 'darwin') return null
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
    if (!raw) return null
    return parseCredentialJson(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Read from ~/.hydra/credentials/claude-code-oauth.json (written by sync-claude-auth.sh) */
function readFromSyncedFile(): ClaudeOAuthCreds | null {
  try {
    if (!fs.existsSync(SYNCED_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(SYNCED_FILE, 'utf8'))
    return parseCredentialJson(raw)
  } catch {
    return null
  }
}

/** Read from ~/.claude/.credentials.json (fallback if keychain unavailable) */
function readFromFile(): ClaudeOAuthCreds | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
    return parseCredentialJson(raw)
  } catch {
    return null
  }
}

let _cached: { creds: ClaudeOAuthCreds; readAt: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // re-read every 5 minutes

/** Get the current Claude OAuth credentials. Returns null if not available. */
export function readClaudeOAuthCreds(forceRefresh = false): ClaudeOAuthCreds | null {
  const now = Date.now()
  if (!forceRefresh && _cached && now - _cached.readAt < CACHE_TTL_MS) {
    return _cached.creds
  }

  const creds = readFromSyncedFile() ?? readFromKeychain() ?? readFromFile()
  if (creds) {
    _cached = { creds, readAt: now }
    log.debug(`Claude OAuth creds loaded (expires ${new Date(creds.expiresAt).toISOString()})`)
  }
  return creds
}

/** True if Claude OAuth credentials exist (may be expired) */
export function isClaudeOAuthAvailable(): boolean {
  return readClaudeOAuthCreds() !== null
}

const TOKEN_URL   = 'https://console.anthropic.com/v1/oauth/token'
const CLIENT_ID   = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** Refresh the OAuth access token using the stored refresh_token */
async function refreshToken(refreshToken: string): Promise<ClaudeOAuthCreds | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn(`Claude token refresh failed (${res.status}): ${body.slice(0, 200)}`)
      return null
    }
    const data = (await res.json()) as any
    const accessToken: string = data.access_token
    const newRefreshToken: string = data.refresh_token ?? refreshToken
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
    if (!accessToken) return null

    const refreshed: ClaudeOAuthCreds = { accessToken, refreshToken: newRefreshToken, expiresAt }

    // Persist back to all credential stores
    _cached = { creds: refreshed, readAt: Date.now() }
    persistRefreshedToken(refreshed)
    log.info(`Claude OAuth token auto-refreshed (expires ${new Date(expiresAt).toISOString()})`)
    return refreshed
  } catch (e) {
    log.warn(`Claude token refresh error: ${e}`)
    return null
  }
}

/** Write refreshed token back to credential files */
function persistRefreshedToken(creds: ClaudeOAuthCreds): void {
  try {
    // Update synced file
    const credDir = path.join(os.homedir(), '.hydra', 'credentials')
    fs.mkdirSync(credDir, { recursive: true })
    const payload = {
      claudeAiOauth: {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      }
    }
    fs.writeFileSync(SYNCED_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 })
    // Also update ~/.claude/.credentials.json if it exists
    if (fs.existsSync(CREDENTIALS_FILE)) {
      let existing: Record<string, unknown> = {}
      try { existing = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')) } catch {}
      existing.claudeAiOauth = payload.claudeAiOauth
      fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 })
    }
  } catch (e) {
    log.warn(`Could not persist refreshed token: ${e}`)
  }
}

let _refreshing: Promise<ClaudeOAuthCreds | null> | null = null

/** Get a valid access token — auto-refreshes using refresh_token if expired */
export async function getValidClaudeTokenAsync(): Promise<string | null> {
  const creds = readClaudeOAuthCreds()
  if (!creds) return null

  // Still valid
  if (creds.expiresAt - Date.now() > 60_000) return creds.accessToken

  // Expired — try to refresh (deduplicate concurrent refresh calls)
  if (!creds.refreshToken) {
    log.warn('Claude OAuth token expired and no refresh_token — run /claude-login')
    return null
  }

  if (!_refreshing) {
    _refreshing = refreshToken(creds.refreshToken).finally(() => { _refreshing = null })
  }
  const refreshed = await _refreshing
  return refreshed?.accessToken ?? null
}

/** Synchronous version — returns null if expired (use async version for auto-refresh) */
export function getValidClaudeToken(): string | null {
  const creds = readClaudeOAuthCreds()
  if (!creds) return null
  if (creds.expiresAt - Date.now() < 60_000) {
    log.warn('Claude OAuth token expired — auto-refresh pending (use getValidClaudeTokenAsync)')
    return null
  }
  return creds.accessToken
}
