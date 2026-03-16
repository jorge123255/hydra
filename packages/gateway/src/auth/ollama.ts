// Ollama provider — local and cloud.
//
// LOCAL (default):
//   brew install ollama && ollama serve && ollama pull nemotron-mini
//   OLLAMA_HOST=http://localhost:11434 (default)
//
// CLOUD (Ollama hosted inference):
//   OLLAMA_CLOUD_API_KEY=your-key  (get from https://ollama.com/settings/keys)
//   Cloud automatically used when key is set — no local install needed.
//   Default cloud model: nemotron-3-super:120b (MoE, activates 12B params, 256K context)
//   Override with: HYDRA_OLLAMA_MODEL=nemotron-3-super:120b
//
// REMOTE self-hosted:
//   OLLAMA_HOST=http://192.168.1.x:11434

import { createLogger } from '../logger.js'

const log = createLogger('ollama')

// Cloud: https://ollama.com/api/chat (Bearer auth)
// Local: http://localhost:11434/api/chat (no auth)
const OLLAMA_CLOUD_BASE = 'https://ollama.com'

export function getOllamaBaseUrl(): string {
  if (process.env.OLLAMA_CLOUD_API_KEY) return OLLAMA_CLOUD_BASE
  return (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')
}

export function isOllamaCloud(): boolean {
  return !!process.env.OLLAMA_CLOUD_API_KEY
}

function getAuthHeaders(): Record<string, string> {
  if (process.env.OLLAMA_CLOUD_API_KEY) {
    return { Authorization: `Bearer ${process.env.OLLAMA_CLOUD_API_KEY}` }
  }
  return {}
}

/** Default model — nemotron-3-super:120b on cloud, nemotron-mini locally */
export function getOllamaModel(): string {
  if (process.env.HYDRA_OLLAMA_MODEL) return process.env.HYDRA_OLLAMA_MODEL
  return isOllamaCloud() ? 'nemotron-3-super:120b' : 'nemotron-mini'
}

let _availableCache: { models: string[]; checkedAt: number } | null = null

/** List available models */
export async function listOllamaModels(): Promise<string[]> {
  const now = Date.now()
  if (_availableCache && now - _availableCache.checkedAt < 60_000) {
    return _availableCache.models
  }
  try {
    const baseUrl = getOllamaBaseUrl()
    const res = await fetch(`${baseUrl}/api/tags`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as any
    const models: string[] = (data.models ?? []).map((m: any) => m.name as string)
    _availableCache = { models, checkedAt: now }
    return models
  } catch {
    return []
  }
}

/** True if Ollama (local or cloud) is reachable */
export async function isOllamaAvailable(): Promise<boolean> {
  if (isOllamaCloud()) return true   // cloud: assume available, fail on first call
  const models = await listOllamaModels()
  return models.length > 0
}

export function isOllamaConfigured(): boolean {
  if (process.env.OLLAMA_DISABLED === 'true') return false
  if (isOllamaCloud()) return true
  if (_availableCache && _availableCache.models.length > 0) return true
  return !!process.env.OLLAMA_HOST
}

/** Call Ollama — uses native /api/chat format (works local + cloud) */
export async function callOllama(
  prompt: string,
  systemPrompt?: string,
  model?: string
): Promise<string> {
  const useModel = model ?? getOllamaModel()
  const baseUrl = getOllamaBaseUrl()

  const messages: Array<{ role: string; content: string }> = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })

  const controller = new AbortController()
  const timeoutMs = isOllamaCloud() ? 60_000 : 120_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  log.debug(`[ollama] ${isOllamaCloud() ? 'cloud' : 'local'} → ${useModel}`)

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ model: useModel, messages, stream: false }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`Ollama${isOllamaCloud() ? ' Cloud' : ''} ${res.status}: ${err.slice(0, 300)}`)
    }

    const data = (await res.json()) as any
    // Native Ollama format: data.message.content
    return data.message?.content ?? data.choices?.[0]?.message?.content ?? '[No response]'
  } finally {
    clearTimeout(timeout)
  }
}

export function refreshOllamaCache(): void {
  _availableCache = null
}
