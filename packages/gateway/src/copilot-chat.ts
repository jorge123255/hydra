// Direct AI chat — without OpenCode overhead.
//
// Provider priority (cost-aware):
//   model override → MetaClaw proxy (127.0.0.1:30000) — Opus/Sonnet/any model
//   chat/fast      → Claude OAuth → Ollama → Codex pool → Copilot
//   vision         → Claude OAuth / Copilot (only options with vision)
//
// MetaClaw: local OpenAI-compatible proxy that routes to all providers
// including Claude Opus/Sonnet with proper auth + RL skill injection.
// Set HYDRA_METACLAW_URL (default: http://127.0.0.1:30000/v1) to use it.

export { isCodexConfigured, callCodexDirect, startCodexLogin } from './auth/chatgpt-codex.js'

export {
  isCopilotConfigured,
  githubCopilotLogin,
  resolveCopilotCredentials,
  DEFAULT_COPILOT_BASE_URL,
} from './auth/github-copilot.js'

export { isClaudeOAuthAvailable, getValidClaudeToken } from './auth/claude-keychain.js'
export {
  isCodexPoolConfigured,
  listPoolAccounts,
  addKeyToPool,
  removeAccountFromPool,
  callSubagent,
  callSubagentsParallel,
} from './auth/codex-pool.js'
export {
  isOllamaCloud,
  isOllamaConfigured,
  isOllamaAvailable,
  listOllamaModels,
  callOllama,
  getOllamaModel,
  getOllamaBaseUrl,
  refreshOllamaCache,
} from './auth/ollama.js'


import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveCopilotCredentials } from './auth/github-copilot.js'
import { getValidClaudeToken, getValidClaudeTokenAsync } from './auth/claude-keychain.js'
import { isOllamaAvailable, callOllama } from './auth/ollama.js'
import { isCodexPoolConfigured, callSubagent } from './auth/codex-pool.js'
import { getVisionUsage } from '@hydra/computer-use'
import { createLogger } from './logger.js'

const log = createLogger('claude-auth')

const OPENCODE_AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_BETA_HEADERS = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14'

// MetaClaw: local OpenAI-compatible proxy at port 30000
// Routes requests to all providers (Claude Opus/Sonnet, Ollama, etc.) with skill injection
const METACLAW_DEFAULT_URL = 'http://127.0.0.1:30000/v1'
const METACLAW_DEFAULT_KEY = 'metaclaw'

type AnthropicAuth = { token: string; isOAuth: boolean }

let _openCodeCache: { auth: AnthropicAuth; cachedAt: number } | null = null
let _metaClawAvailable: boolean | null = null
let _metaClawCheckedAt = 0

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
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    }
  } catch (e) {
    log.warn(`OAuth refresh error: ${e}`)
    return null
  }
}

async function getOpenCodeAuth(): Promise<AnthropicAuth | null> {
  const now = Date.now()
  if (_openCodeCache && now - _openCodeCache.cachedAt < 5 * 60 * 1000) {
    return _openCodeCache.auth
  }

  try {
    if (!fs.existsSync(OPENCODE_AUTH_FILE)) return null
    const data = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8'))
    const ant = data?.anthropic
    if (!ant || ant.type !== 'oauth') return null

    let { access, refresh, expires } = ant as {
      access: string; refresh: string; expires: number
    }

    if (expires - now < 60_000) {
      if (!refresh) { log.warn('OpenCode OAuth token expired and no refresh token'); return null }
      log.info('OpenCode OAuth token expired — refreshing...')
      const refreshed = await refreshOpenCodeToken(refresh)
      if (!refreshed) return null
      access = refreshed.access
      refresh = refreshed.refresh
      expires = refreshed.expires
      try {
        fs.writeFileSync(
          OPENCODE_AUTH_FILE,
          JSON.stringify({ anthropic: { type: 'oauth', access, refresh, expires } }, null, 2)
        )
        log.info('OpenCode OAuth token refreshed and saved')
      } catch (e) {
        log.error(`Failed to save refreshed OpenCode token: ${e}`)
        return null
      }
    }

    const auth: AnthropicAuth = { token: access, isOAuth: true }
    _openCodeCache = { auth, cachedAt: now }
    return auth
  } catch (e) {
    log.warn(`Failed to read OpenCode auth: ${e}`)
    return null
  }
}

async function resolveAnthropicAuth(): Promise<AnthropicAuth | null> {
  if (process.env.HYDRA_DISABLE_CLAUDE === 'true') return null
  const envKey = process.env.ANTHROPIC_API_KEY
  if (envKey) return { token: envKey, isOAuth: envKey.startsWith('sk-ant-oat') }
  // Use async version — auto-refreshes expired token via refresh_token
  const claudeToken = await getValidClaudeTokenAsync()
  if (claudeToken) return { token: claudeToken, isOAuth: true }
  return getOpenCodeAuth()
}

export function getVisionUsageStatus(): { count: number; budget: number; remaining: number } {
  return getVisionUsage()
}

export function isClaudeConfigured(): boolean {
  if (process.env.HYDRA_DISABLE_CLAUDE === 'true') return false
  if (process.env.ANTHROPIC_API_KEY) return true
  if (getValidClaudeToken()) return true
  try {
    if (!fs.existsSync(OPENCODE_AUTH_FILE)) return false
    const data = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8'))
    const ant = data?.anthropic
    if (!ant || ant.type !== 'oauth') return false
    if (typeof ant.access !== 'string' || !ant.access.length) return false
    // Only report configured if token is valid OR refreshable (has refresh token)
    const expired = typeof ant.expires === 'number' && (ant.expires - Date.now() < 60_000)
    if (expired && !ant.refresh) return false
    return true
  } catch {
    return false
  }
}

// ─── MetaClaw Provider ────────────────────────────────────────────────────────
// Local OpenAI-compatible proxy that routes to any model (including Claude Opus/Sonnet)
// with RL-based skill injection. Runs at 127.0.0.1:30000.

function getMetaClawUrl(): string {
  return process.env.HYDRA_METACLAW_URL ?? METACLAW_DEFAULT_URL
}

function getMetaClawKey(): string {
  return process.env.HYDRA_METACLAW_KEY ?? METACLAW_DEFAULT_KEY
}

export function isMetaClawConfigured(): boolean {
  if (process.env.HYDRA_DISABLE_METACLAW === 'true') return false
  // Explicit URL set → assume configured
  if (process.env.HYDRA_METACLAW_URL) return true
  // Check cache (recheck every 60s)
  if (_metaClawAvailable !== null && Date.now() - _metaClawCheckedAt < 60_000) {
    return _metaClawAvailable
  }
  // Sync check: can't do async here, return last known state or true (optimistic)
  return _metaClawAvailable ?? true
}

/** Probe MetaClaw health once (async) — updates the availability cache */
export async function probeMetaClaw(): Promise<boolean> {
  if (process.env.HYDRA_DISABLE_METACLAW === 'true') return false
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
      // A minimal chat completion to confirm MetaClaw is up
      const res = await fetch(`${getMetaClawUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getMetaClawKey()}`,
        },
        body: JSON.stringify({
          model: 'fast',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      })
      _metaClawAvailable = res.ok || res.status < 500
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    _metaClawAvailable = false
  }
  _metaClawCheckedAt = Date.now()
  if (_metaClawAvailable) log.debug('MetaClaw available at ' + getMetaClawUrl())
  else log.debug('MetaClaw not reachable — skipping')
  return _metaClawAvailable
}

/**
 * Call MetaClaw proxy (OpenAI-compatible).
 * Accepts any model name: claude-opus-4-6, nemotron-3-super, devstral-2:123b, etc.
 * MetaClaw routes to the appropriate backend with skill injection.
 */
export async function callMetaClaw(
  prompt: string,
  systemPrompt?: string,
  modelOverride?: string,
): Promise<string> {
  const model = modelOverride ?? process.env.HYDRA_METACLAW_MODEL ?? 'nemotron-3-super'
  const baseUrl = getMetaClawUrl()
  const apiKey = getMetaClawKey()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 360_000)

  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt ?? defaultSystemPrompt() },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    _metaClawAvailable = false
    _metaClawCheckedAt = Date.now()
    throw new Error(`MetaClaw error ${res.status}: ${body.slice(0, 200)}`)
  }

  _metaClawAvailable = true
  _metaClawCheckedAt = Date.now()
  const json = (await res.json()) as any
  return json.choices?.[0]?.message?.content ?? '[No response from MetaClaw]'
}

/** Call Claude via Anthropic API (supports vision) */
export async function callClaudeDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string,
  modelOverride?: string,
): Promise<string> {
  const auth = await resolveAnthropicAuth()
  if (!auth) throw new Error('No Anthropic credentials — set ANTHROPIC_API_KEY or log in via Claude Code')

  const model = modelOverride ?? process.env.HYDRA_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001'

  type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  type TextBlock  = { type: 'text'; text: string }
  const content: Array<ImageBlock | TextBlock> = []

  if (images?.length) {
    for (const dataUrl of images) {
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
      }
    }
  }
  content.push({ type: 'text', text: prompt })

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
  const timeout = setTimeout(() => controller.abort(), 180_000)

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
    // Only invalidate OpenCode cache if we're using OAuth and got a 401
    if (res.status === 401 && auth.isOAuth) {
      _openCodeCache = null
    }
    // 400 = model not available on this Claude Max OAuth plan (only haiku allowed)
    // Use `model` (resolved), not `modelOverride` — covers HYDRA_CLAUDE_MODEL env var too
    // Try MetaClaw first (it has full Opus/Sonnet access), then hard-fall to haiku
    if (res.status === 400 && model !== 'claude-haiku-4-5-20251001') {
      log.warn(`Model ${model} not available via direct API (400) — trying MetaClaw`)
      try {
        return await callMetaClaw(prompt, systemPrompt, model)
      } catch (metaErr) {
        log.warn(`MetaClaw also failed: ${metaErr} — falling back to claude-haiku-4-5-20251001`)
        return callClaudeDirect(prompt, images, systemPrompt, 'claude-haiku-4-5-20251001')
      }
    }
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`)
  }

  const json = (await res.json()) as any
  return json.content?.[0]?.text ?? '[No response from Claude]'
}

/** Call Copilot directly */
export async function callCopilotDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string
): Promise<string> {
  const creds = await resolveCopilotCredentials()
  if (!creds) throw new Error('Copilot not configured — run /copilot-login first')

  const model = process.env.HYDRA_COPILOT_MODEL ?? 'claude-sonnet-4.6'

  type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  const content: ContentPart[] = []
  if (images?.length) {
    for (const dataUrl of images) content.push({ type: 'image_url', image_url: { url: dataUrl } })
  }
  content.push({ type: 'text', text: prompt })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)

  let res: Response
  try {
    res = await fetch(`${creds.baseUrl}/v1/chat/completions`, {
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
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Copilot API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as any
  return json.choices?.[0]?.message?.content ?? '[No response from Copilot]'
}

/**
 * Call the best available direct provider.
 * Cost-aware routing:
 *   - Vision (images) → Claude or Copilot only (Ollama/MetaClaw have no vision)
 *   - Model override  → MetaClaw first (handles Opus/Sonnet/any model)
 *   - Chat/fast       → Claude OAuth → Ollama → Codex pool → Copilot
 */
export async function callDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string,
  ollamaModelOverride?: string,  // specific model for this intent (Ollama or MetaClaw)
): Promise<string> {
  const hasImages = !!(images?.length)

  // Vision: needs a cloud provider with multimodal support
  if (hasImages) {
    if (isClaudeConfigured()) return callClaudeDirect(prompt, images, systemPrompt)
    const { isCopilotConfigured: isCopilot } = await import('./auth/github-copilot.js')
    if (isCopilot()) return callCopilotDirect(prompt, images, systemPrompt)
    throw new Error('Vision requires Claude or Copilot — no vision-capable provider configured')
  }

  // Priority 1: MetaClaw for specific model requests (Claude Opus/Sonnet, devstral, etc.)
  // MetaClaw handles any model including ones that fail via direct API
  if (ollamaModelOverride && process.env.HYDRA_DISABLE_METACLAW !== 'true') {
    const isClaudeModel = ollamaModelOverride.startsWith('claude-')
    const metaOk = isClaudeModel
      ? isMetaClawConfigured()  // Claude models always prefer MetaClaw
      : false                    // Ollama models go to Ollama (Priority 3)
    if (metaOk) {
      log.debug(`Routing ${ollamaModelOverride} to MetaClaw`)
      try {
        return await callMetaClaw(prompt, systemPrompt, ollamaModelOverride)
      } catch (e) {
        log.warn(`MetaClaw failed for ${ollamaModelOverride}: ${e} — falling through`)
      }
    }
  }

  // Priority 2: Claude (primary — auto-refreshes OAuth token)
  if (isClaudeConfigured()) {
    log.debug('Routing to Claude')
    return callClaudeDirect(prompt, images, systemPrompt)
  }

  // Priority 3: Specific Ollama model requested (subagent routing)
  if (ollamaModelOverride && process.env.OLLAMA_DISABLED !== 'true') {
    const ollamaReady = await isOllamaAvailable()
    if (ollamaReady) {
      log.debug(`Routing to Ollama model: ${ollamaModelOverride}`)
      return callOllama(prompt, systemPrompt, ollamaModelOverride)
    }
  }

  // Priority 4: Ollama default model
  if (process.env.OLLAMA_DISABLED !== 'true') {
    const ollamaReady = await isOllamaAvailable()
    if (ollamaReady) {
      log.debug('Routing to Ollama (default model)')
      return callOllama(prompt, systemPrompt)
    }
  }

  // Priority 5: MetaClaw fallback (when Claude direct isn't configured)
  if (isMetaClawConfigured()) {
    log.debug('Routing to MetaClaw (fallback)')
    try {
      return await callMetaClaw(prompt, systemPrompt, ollamaModelOverride)
    } catch (e) {
      log.warn(`MetaClaw fallback failed: ${e}`)
    }
  }

  // Priority 6: ChatGPT subagent pool → Codex → Copilot
  if (isCodexPoolConfigured()) {
    log.debug('Routing to ChatGPT subagent pool')
    return callSubagent(prompt, systemPrompt)
  }
  const { isCodexConfigured, callCodexDirect } = await import('./auth/chatgpt-codex.js')
  if (isCodexConfigured()) return callCodexDirect(prompt, images, systemPrompt)
  return callCopilotDirect(prompt, images, systemPrompt)
}

function defaultSystemPrompt(): string {
  return (
    `You are Hydra, a personal AI assistant. ` +
    `Be direct and concise. Lead with the answer. ` +
    `Use plain text. No filler phrases.`
  )
}

// ─── Smart Subagent Dispatcher ────────────────────────────────────────────────
// The agent decides how to decompose problems and which models to use.
// It can route by model name directly: "devstral-2:123b: write the code"
// Or write plain tasks and let intent classification pick the model.
// All tasks run in parallel.

import { classifyIntent, getOllamaModelForIntent } from './router.js'

// Known available models the agent can route to by name
export const MODEL_ALIASES_MAP: Record<string, string> = {
  'devstral': 'devstral-2:123b',        // coding specialist
  'nemotron': 'nemotron-3-super',        // reasoning/analysis
  'deepseek': 'deepseek-v3.2',           // deep reasoning
  'llava': 'qwen3-vl:235b-instruct',    // vision
  'coder': 'qwen3-coder:480b',           // largest coder
  'fast': 'ministral-3:8b',             // fastest
  'smart': 'kimi-k2:1t',                // strongest general
  'mixtral': 'devstral-2:123b',         // alias
  // Claude models — routed through MetaClaw
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
}

export type SubagentResult = {
  task: string
  model: string
  result: string
  error?: string
}

export async function callSmartSubagent(rawTask: string): Promise<SubagentResult> {
  const trimmed = rawTask.trim()

  // Agent can route by model name: "devstral-2:123b: task" or "devstral: task"
  const modelRouteMatch = trimmed.match(/^([\w.:-]+):\s*(.+)/is)
  let task = trimmed
  let modelOverride: string | undefined

  if (modelRouteMatch) {
    const candidate = modelRouteMatch[1].toLowerCase()
    const fullName = MODEL_ALIASES_MAP[candidate] ?? (
      // Accept full model names like "devstral-2:123b" or "claude-opus-4-6"
      Object.values(MODEL_ALIASES_MAP).includes(modelRouteMatch[1]) ? modelRouteMatch[1] : null
    )
    if (fullName) {
      task = modelRouteMatch[2].trim()
      modelOverride = fullName
    }
  }

  // If no explicit model, let intent classification pick
  if (!modelOverride) {
    const intent = classifyIntent(task, false)
    modelOverride = getOllamaModelForIntent(intent as any)
  }

  const modelLabel = modelOverride ?? 'auto'

  try {
    const result = await callDirect(task, undefined, undefined, modelOverride)
    return { task, model: modelLabel, result }
  } catch (e) {
    return { task, model: modelLabel, result: '', error: String(e) }
  }
}

export async function callSmartSubagentsParallel(tasks: string[]): Promise<SubagentResult[]> {
  return Promise.all(tasks.map(t => callSmartSubagent(t)))
}
