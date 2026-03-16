// ChatGPT Codex OAuth — free GPT access via OpenAI Codex CLI OAuth flow.
// Same approach used by OpenClaw (openai-codex provider, chatgpt.com/backend-api).
// Run /chatgpt-login to authenticate interactively.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../logger.js'

const log = createLogger('chatgpt-codex')

const CREDS_DIR  = path.join(os.homedir(), '.hydra', 'credentials')
const CREDS_FILE = path.join(CREDS_DIR, 'chatgpt-codex.json')

// OAuth endpoints for OpenAI Codex CLI
const CLIENT_ID   = 'pdlLIX2Y72MIl2rhLhTE9VV9bVudePEU'
const AUDIENCE    = 'https://api.openai.com/v1'
const AUTH0_DOMAIN = 'auth0.openai.com'
const SCOPE       = 'openid profile email offline_access'

// ChatGPT backend API base
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

type CodexCredentials = {
  accessToken: string
  refreshToken?: string
  expiresAt: number  // Unix ms
  accountId?: string
}

function loadCreds(): CodexCredentials | null {
  // Also check OpenClaw's auth store as a source
  const openclaw = path.join(os.homedir(), '.openclaw', 'auth-profiles.json')
  try {
    if (fs.existsSync(openclaw)) {
      const store = JSON.parse(fs.readFileSync(openclaw, 'utf8'))
      const profile = store['openai-codex:codex-cli'] ?? store['openai-codex:default']
      if (profile?.access) {
        return {
          accessToken: profile.access,
          refreshToken: profile.refresh,
          expiresAt: profile.expiresAt ?? (Date.now() + 3600_000),
          accountId: profile.accountId,
        }
      }
    }
  } catch {}

  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) as CodexCredentials
    }
  } catch {}
  return null
}

function saveCreds(creds: CodexCredentials): void {
  fs.mkdirSync(CREDS_DIR, { recursive: true })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2))
}

async function refreshAccessToken(refreshToken: string): Promise<CodexCredentials | null> {
  try {
    const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) return null
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
  } catch { return null }
}

/** Get a valid access token, refreshing if needed */
export async function getCodexToken(): Promise<{ token: string; accountId?: string } | null> {
  let creds = loadCreds()
  if (!creds) return null

  // Refresh if expiring within 5 min
  if (creds.expiresAt - Date.now() < 5 * 60_000 && creds.refreshToken) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (refreshed) {
      creds = { ...refreshed, accountId: creds.accountId }
      saveCreds(creds)
    }
  }

  if (Date.now() > creds.expiresAt) return null
  return { token: creds.accessToken, accountId: creds.accountId }
}

export function isCodexConfigured(): boolean {
  return loadCreds() !== null
}

/** Device auth flow — call this interactively for /chatgpt-login */
export async function startCodexLogin(): Promise<{
  verificationUri: string
  userCode: string
  poll: () => Promise<boolean>
}> {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      audience: AUDIENCE,
      scope: SCOPE,
    }),
  })
  if (!res.ok) throw new Error(`Device code request failed: ${res.status}`)
  const data = await res.json() as {
    device_code: string
    user_code: string
    verification_uri_complete: string
    verification_uri: string
    interval: number
    expires_in: number
  }

  const poll = async (): Promise<boolean> => {
    const maxAttempts = Math.floor(data.expires_in / (data.interval + 1))
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, data.interval * 1000))
      try {
        const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: data.device_code,
            client_id: CLIENT_ID,
          }),
        })
        if (!tokenRes.ok) continue
        const token = await tokenRes.json() as {
          access_token?: string
          refresh_token?: string
          expires_in?: number
          error?: string
        }
        if (token.error === 'authorization_pending') continue
        if (!token.access_token) continue

        const creds: CodexCredentials = {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
        }
        saveCreds(creds)
        log.info('ChatGPT Codex OAuth login successful')
        return true
      } catch {}
    }
    return false
  }

  return {
    verificationUri: data.verification_uri_complete ?? data.verification_uri,
    userCode: data.user_code,
    poll,
  }
}

/** Call ChatGPT via Codex backend API — returns text response */
export async function callCodexDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string
): Promise<string> {
  const auth = await getCodexToken()
  if (!auth) throw new Error('ChatGPT not authenticated. Run /chatgpt-login first.')

  const messages: Array<{ role: string; content: unknown }> = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })

  // Build content with optional images
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  if (images?.length) {
    for (const img of images) userContent.push({ type: 'image_url', image_url: { url: img } })
  }
  userContent.push({ type: 'text', text: prompt })
  messages.push({ role: 'user', content: userContent.length === 1 ? prompt : userContent })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.token}`,
  }
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const res = await fetch(`${CODEX_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`ChatGPT API error ${res.status}: ${err.slice(0, 200)}`)
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content?.trim() ?? ''
  } finally {
    clearTimeout(timeout)
  }
}
