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

  const creds = readFromKeychain() ?? readFromFile()
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

/** Get a valid access token, or null if expired/unavailable */
export function getValidClaudeToken(): string | null {
  const creds = readClaudeOAuthCreds()
  if (!creds) return null

  // Allow 60s buffer
  if (creds.expiresAt - Date.now() < 60_000) {
    log.warn('Claude OAuth token expired — open Claude Code to refresh it')
    return null
  }

  return creds.accessToken
}
