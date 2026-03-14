// PKCE OAuth flow for Anthropic/Claude accounts.
// Replicates what opencode-anthropic-auth@0.0.13 does internally.
// Stores OAuth tokens in opencode auth.json — OpenCode handles them natively.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLIENT_ID      = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTH_URL_MAX   = 'https://claude.ai/oauth/authorize'
const TOKEN_URL      = 'https://console.anthropic.com/v1/oauth/token'
const CREATE_KEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key'
const REDIRECT_URI   = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES         = 'org:create_api_key user:profile user:inference'
const OPENCODE_AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
const HYDRA_OAUTH_FILE   = path.join(os.homedir(), '.hydra', 'credentials', 'claude-oauth.json')

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export type PendingOAuth = {
  verifier: string
  createdAt: number
}

/** Build the authorization URL. Returns url + verifier (keep for code exchange). */
export function buildAuthUrl(): { url: string; verifier: string } {
  const { verifier, challenge } = generatePKCE()
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  })
  return { url: `${AUTH_URL_MAX}?${params}`, verifier }
}

export type OAuthResult = {
  type: 'api_key'
  apiKey: string
} | {
  type: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/**
 * Exchange authorization code for tokens. Tries to create an API key first;
 * if the account lacks org:create_api_key scope, falls back to storing
 * the OAuth tokens directly (OpenCode supports this natively).
 *
 * The callback page shows `<code>#<state>` — paste the whole string.
 */
export async function exchangeCode(rawCode: string, verifier: string): Promise<OAuthResult> {
  const trimmed = rawCode.trim()
  const hashIdx = trimmed.indexOf('#')
  const code  = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed
  const state = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : verifier

  // Step 1: exchange code → OAuth tokens
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body.slice(0, 300)}`)
  }

  const tokens = (await tokenRes.json()) as any
  const accessToken: string  = tokens.access_token
  const refreshToken: string = tokens.refresh_token
  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000

  // Step 2: try to create a permanent API key (requires org:create_api_key scope)
  try {
    const createKeyRes = await fetch(CREATE_KEY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name: 'hydra-bot' }),
    })

    if (createKeyRes.ok) {
      const keyData = (await createKeyRes.json()) as any
      const apiKey: string =
        keyData?.raw_key ?? keyData?.api_key?.secret_key ?? keyData?.secret_key ?? keyData?.key ?? ''
      if (apiKey.startsWith('sk-ant-')) {
        return { type: 'api_key', apiKey }
      }
    }
    // 403 or bad response — fall through to OAuth token storage
  } catch {
    // network error creating key — fall through
  }

  // Fallback: store OAuth tokens directly (works for Claude Max accounts)
  return { type: 'oauth', accessToken, refreshToken, expiresAt }
}

/** Persist result to all relevant credential stores. */
export function saveResult(result: OAuthResult): void {
  const credDir = path.join(os.homedir(), '.hydra', 'credentials')
  fs.mkdirSync(credDir, { recursive: true })

  if (result.type === 'api_key') {
    // API key — store in hydra + opencode
    fs.writeFileSync(
      path.join(credDir, 'anthropic.json'),
      JSON.stringify({ key: result.apiKey, savedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    )
    writeOpencodeAuth({ type: 'api', key: result.apiKey })
  } else {
    // OAuth tokens — store in hydra + opencode (opencode handles refresh natively)
    fs.writeFileSync(
      HYDRA_OAUTH_FILE,
      JSON.stringify({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_at: result.expiresAt,
        savedAt: new Date().toISOString(),
      }, null, 2),
      { mode: 0o600 },
    )
    writeOpencodeAuth({
      type: 'oauth',
      access: result.accessToken,
      refresh: result.refreshToken,
      expires: result.expiresAt,
    })
  }
}

function writeOpencodeAuth(entry: Record<string, unknown>): void {
  const opencodeDir = path.dirname(OPENCODE_AUTH_FILE)
  fs.mkdirSync(opencodeDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8')) } catch {}
  existing.anthropic = entry
  fs.writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 })
}

/** Get the current OAuth access token for direct API calls (if stored) */
export function getStoredOAuthToken(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(HYDRA_OAUTH_FILE, 'utf8'))
    if (data.expires_at && Date.now() > data.expires_at - 60_000) return null
    return data.access_token ?? null
  } catch { return null }
}

/** Legacy: save a raw API key directly */
export function saveApiKey(apiKey: string): void {
  saveResult({ type: 'api_key', apiKey })
}
