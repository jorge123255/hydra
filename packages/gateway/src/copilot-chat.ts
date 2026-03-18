// Direct AI chat — without OpenCode overhead.
//
// Provider priority (cost-aware):
//   chat/fast  → Ollama local (free, private, instant)
//   vision     → Claude OAuth / Copilot (only options with vision)
//   fallback   → Claude OAuth → Codex → Copilot → error
//
// Set OLLAMA_HOST=http://192.168.1.x:11434 for remote Ollama.
// Set HYDRA_OLLAMA_MODEL=nemotron-mini (default) for chat model.

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
const OAUTH_BETA_HEADERS = 'claude-code-20250219,oauth-2025-04-20'

type AnthropicAuth = { token: string; isOAuth: boolean }

let _openCodeCache: { auth: AnthropicAuth; cachedAt: number } | null = null

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

/** Call Claude via Anthropic API (supports vision) */
export async function callClaudeDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string,
  modelOverride?: string,
): Promise<string> {
  const auth = await resolveAnthropicAuth()
  if (!auth) throw new Error('No Anthropic credentials — set ANTHROPIC_API_KEY or log in via Claude Code')

  const model = modelOverride ?? process.env.HYDRA_CLAUDE_MODEL ?? 'claude-sonnet-4-6'

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
    if (res.status === 401) _openCodeCache = null
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

/**
 * Call the best available direct provider.
 * Cost-aware routing:
 *   - Vision (images) → Claude or Copilot only (Ollama has no vision)
 *   - Chat/fast → Ollama first (free, local), then cloud fallback
 *   - Fallback chain: Claude OAuth → Codex → Copilot
 */
export async function callDirect(
  prompt: string,
  images?: string[],
  systemPrompt?: string,
  ollamaModelOverride?: string,  // specific Ollama model for this intent
): Promise<string> {
  const hasImages = !!(images?.length)

  // Vision: needs a cloud provider with multimodal support
  if (hasImages) {
    if (isClaudeConfigured()) return callClaudeDirect(prompt, images, systemPrompt)
    const { isCopilotConfigured: isCopilot } = await import('./auth/github-copilot.js')
    if (isCopilot()) return callCopilotDirect(prompt, images, systemPrompt)
    throw new Error('Vision requires Claude or Copilot — no vision-capable provider configured')
  }

  // Priority 1: Claude (primary — auto-refreshes OAuth token)
  if (isClaudeConfigured()) {
    log.debug('Routing to Claude')
    return callClaudeDirect(prompt, images, systemPrompt)
  }

  // Priority 2: Specific Ollama model requested (subagent routing)
  if (ollamaModelOverride && process.env.OLLAMA_DISABLED !== 'true') {
    const ollamaReady = await isOllamaAvailable()
    if (ollamaReady) {
      log.debug(`Routing to Ollama model: ${ollamaModelOverride}`)
      return callOllama(prompt, systemPrompt, ollamaModelOverride)
    }
  }

  // Priority 3: Ollama default model
  if (process.env.OLLAMA_DISABLED !== 'true') {
    const ollamaReady = await isOllamaAvailable()
    if (ollamaReady) {
      log.debug('Routing to Ollama (default model)')
      return callOllama(prompt, systemPrompt)
    }
  }

  // Priority 4: ChatGPT subagent pool → Codex → Copilot
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
  let ollamaModel: string | undefined

  if (modelRouteMatch) {
    const candidate = modelRouteMatch[1].toLowerCase()
    const fullName = MODEL_ALIASES_MAP[candidate] ?? (
      // Accept full model names like "devstral-2:123b"
      Object.values(MODEL_ALIASES_MAP).includes(modelRouteMatch[1]) ? modelRouteMatch[1] : null
    )
    if (fullName) {
      // Agent explicitly chose a model — honor it
      task = modelRouteMatch[2].trim()
      ollamaModel = fullName
    }
  }

  // If no explicit model, let intent classification pick
  if (!ollamaModel) {
    const intent = classifyIntent(task, false)
    ollamaModel = getOllamaModelForIntent(intent as any)
  }

  const modelLabel = ollamaModel ?? 'auto'

  try {
    const result = await callDirect(task, undefined, undefined, ollamaModel)
    return { task, model: modelLabel, result }
  } catch (e) {
    return { task, model: modelLabel, result: '', error: String(e) }
  }
}

export async function callSmartSubagentsParallel(tasks: string[]): Promise<SubagentResult[]> {
  return Promise.all(tasks.map(t => callSmartSubagent(t)))
}
