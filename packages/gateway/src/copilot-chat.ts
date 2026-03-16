// Direct AI chat — without OpenCode overhead.
// Priority: 1) ANTHROPIC_API_KEY (API key or OAuth) 2) Claude Code keychain OAuth
//           3) OpenCode auth.json OAuth (with auto-refresh) 4) GitHub Copilot 5) throw

export { isCodexConfigured, callCodexDirect, startCodexLogin } from './auth/chatgpt-codex.js'

export {
  isCopilotConfigured,
  githubCopilotLogin,
  resolveCopilotCredentials,
  DEFAULT_COPILOT_BASE_URL,
} from './auth/github-copilot.js'

export { isClaudeOAuthAvailable, getValidClaudeToken } from './auth/claude-keychain.js'

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveCopilotCredentials } from './auth/github-copilot.js'
import { getValidClaudeToken } from './auth/claude-keychain.js'
import { getVisionUsage } from '@hydra/computer-use'
import { createLogger } from './logger.js'

const log = createLogger('claude-auth')

const OPENCODE_AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
// Anthropic OAuth token endpoint (same one OpenCode/pi-ai use)
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// Extra headers required for OAuth-issued access tokens (sk-ant-oat01-)
const OAUTH_BETA_HEADERS = 'claude-code-20250219,oauth-2025-04-20'

type AnthropicAuth = { token: string; isOAuth: boolean }

let _openCodeCache: { auth: AnthropicAuth; cachedAt: number } | null = null

/** Refresh an Anthropic OAuth access token using a refresh token */
async function refreshOpenCodeToken(
  refreshToken: string
): Promise<{ access: string; refresh: string; expires: number } | null> {
  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      log.warn(`OAuth refresh failed ${res.status}: ${err.slice(0, 200)}`)
      return null
    }
    const data = (await res.json()) as any
    return {
      access: data.access_token,
      refresh: data.refresh_token ?? refreshToken,
      // 5-minute buffer, matching pi-ai convention
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    }
  } catch (e) {
    log.warn(`OAuth refresh error: ${e}`)
    return null
  }
}

/** Read OpenCode's auth.json and return a valid access token (refreshing if needed) */
async function getOpenCodeAuth(): Promise<AnthropicAuth | null> {
  const now = Date.now()
  // Use cache if still fresh (5 min)
  if (_openCodeCache && now - _openCodeCache.cachedAt < 5 * 60 * 1000) {
    return _openCodeCache.auth
  }

  try {
    if (!fs.existsSync(OPENCODE_AUTH_FILE)) return null
    const data = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8'))
    const ant = data?.anthropic
    if (!ant || ant.type !== 'oauth') return null

    let { access, refresh, expires } = ant as {
      access: string
      refresh: string
      expires: number
    }

    // Refresh if expired (60s buffer)
    if (expires - now < 60_000) {
      if (!refresh) {
        log.warn('OpenCode OAuth token expired and no refresh token available')
        return null
      }
      log.info('OpenCode OAuth token expired — refreshing...')
      const refreshed = await refreshOpenCodeToken(refresh)
      if (!refreshed) return null
      access = refreshed.access
      refresh = refreshed.refresh
      expires = refreshed.expires
      // Persist refreshed token back to auth.json so OpenCode stays in sync
      fs.writeFileSync(
        OPENCODE_AUTH_FILE,
        JSON.stringify({ anthropic: { type: 'oauth', access, refresh, expires } }, null, 2)
      )
      log.info('OpenCode OAuth token refreshed and saved')
    }

    const auth: AnthropicAuth = { token: access, isOAuth: true }
    _openCodeCache = { auth, cachedAt: now }
    return auth
  } catch (e) {
    log.warn(`Failed to read OpenCode auth: ${e}`)
    return null
  }
}

/**
 * Resolve the best available Anthropic auth credentials.
 * Priority: ANTHROPIC_API_KEY → Claude Code keychain → OpenCode auth.json
 */
async function resolveAnthropicAuth(): Promise<AnthropicAuth | null> {
  // 1. Env var (can be either sk-ant-api03- key OR sk-ant-oat01- OAuth token)
  const envKey = process.env.ANTHROPIC_API_KEY
  if (envKey) {
    return { token: envKey, isOAuth: envKey.startsWith('sk-ant-oat') }
  }

  // 2. Claude Code keychain OAuth (written by Claude Code GUI app)
  const claudeToken = getValidClaudeToken()
  if (claudeToken) {
    return { token: claudeToken, isOAuth: true }
  }

  // 3. OpenCode's auth.json (with auto-refresh)
  return getOpenCodeAuth()
}

/** Current vision budget status for today */
export function getVisionUsageStatus(): { count: number; budget: number; remaining: number } {
  return getVisionUsage()
}

/**
 * True if Claude is callable — either via ANTHROPIC_API_KEY, Claude Code OAuth,
 * or OpenCode OAuth credentials on disk.
 * Note: async check not possible here; we do a sync best-effort check.
 */
export function isClaudeConfigured(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  // Claude Code keychain sync check
  if (getValidClaudeToken()) return true
  // OpenCode auth.json sync check
  try {
    if (!fs.existsSync(OPENCODE_AUTH_FILE)) return false
    const data = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8'))
    const ant = data?.anthropic
    if (!ant || ant.type !== 'oauth') return false
    // Token must be present (may be expired; refresh happens at call time)
    return typeof ant.access === 'string' && ant.access.length > 0
  } catch {
    return false
  }
}

/** Call Claude via Anthropic API (supports vision via base64 images) */
export async function callClaudeDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string
): Promise<string> {
  const auth = await resolveAnthropicAuth()
  if (!auth) {
    throw new Error('No Anthropic credentials available — set ANTHROPIC_API_KEY or log in via Claude Code')
  }

  const model = process.env.HYDRA_CLAUDE_MODEL ?? 'claude-sonnet-4-6'

  type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  type TextBlock  = { type: 'text'; text: string }
  const content: Array<ImageBlock | TextBlock> = []

  if (images?.length) {
    for (const dataUrl of images) {
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        })
      }
    }
  }
  content.push({ type: 'text', text: prompt })

  // Build headers — OAuth tokens need Bearer auth + beta flags;
  // regular API keys use x-api-key as normal.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (auth.isOAuth) {
    headers['Authorization'] = `Bearer ${auth.token}`
    headers['anthropic-beta'] = OAUTH_BETA_HEADERS
  } else {
    headers['x-api-key'] = auth.token
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt ?? defaultSystemPrompt(),
        messages: [{ role: 'user', content }],
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // If token expired mid-session, clear cache so next call refreshes
    if (res.status === 401) {
      _openCodeCache = null
    }
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`)
  }

  const json = (await res.json()) as any
  return json.content?.[0]?.text ?? '[No response from Claude]'
}

/** Call Copilot directly — used as fallback or for vision when no API key */
export async function callCopilotDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string
): Promise<string> {
  const creds = await resolveCopilotCredentials()
  if (!creds) throw new Error('Copilot not configured — run /copilot-login first')

  const model = process.env.HYDRA_COPILOT_MODEL ?? 'claude-sonnet-4.6'

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }

  const content: ContentPart[] = []
  if (images?.length) {
    for (const dataUrl of images) {
      content.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  content.push({ type: 'text', text: prompt })

  const res = await fetch(`${creds.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
      'Copilot-Integration-Id': 'hydra-gateway',
      'Editor-Version': 'hydra/1.0',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt ?? defaultSystemPrompt() },
        { role: 'user', content },
      ],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Copilot API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as any
  return json.choices?.[0]?.message?.content ?? '[No response from Copilot]'
}

/** Call the best available direct provider: Claude > Codex > Copilot */
export async function callDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string
): Promise<string> {
  if (isClaudeConfigured()) return callClaudeDirect(prompt, images, systemPrompt)
  const { isCodexConfigured, callCodexDirect } = await import('./auth/chatgpt-codex.js')
  if (isCodexConfigured()) return callCodexDirect(prompt, images, systemPrompt)
  return callCopilotDirect(prompt, images, systemPrompt)
}

/** Fallback system prompt when gateway doesn't supply one */
function defaultSystemPrompt(): string {
  return (
    `You are Hydra, a personal AI assistant. ` +
    `Be direct and concise. Lead with the answer. ` +
    `Use plain text. No filler phrases.`
  )
}
