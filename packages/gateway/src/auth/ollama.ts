// Ollama provider — local and cloud.
//
// LOCAL (default):
//   brew install ollama && ollama serve && ollama pull nemotron-mini
//   OLLAMA_HOST=http://localhost:11434 (default)
//
// CLOUD (Ollama hosted inference):
//   OLLAMA_CLOUD_API_KEY=your-key  (get from https://ollama.com)
//   Cloud automatically used when key is set — no local install needed.
//   Same models available: nemotron-mini, llama3.2, etc.
//
// REMOTE self-hosted:
//   OLLAMA_HOST=http://192.168.1.x:11434

import { createLogger } from '../logger.js'

const log = createLogger('ollama')

const OLLAMA_CLOUD_BASE = 'https://api.ollama.com'

export function getOllamaBaseUrl(): string {
  // Cloud takes priority if API key is set
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

/** Default model for chat — override with HYDRA_OLLAMA_MODEL */
export function getOllamaModel(): string {
  return process.env.HYDRA_OLLAMA_MODEL ?? 'nemotron-mini'
}

let _availableCache: { models: string[]; checkedAt: number } | null = null

/** Check if Ollama is reachable and return available model names */
export async function listOllamaModels(): Promise<string[]> {
  const now = Date.now()
  if (_availableCache && now - _availableCache.checkedAt < 60_000) {
    return _availableCache.models
  }

  try {
    const baseUrl = getOllamaBaseUrl()
    const res = await fetch(`${baseUrl}/api/tags`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(3000),
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

/** True if Ollama (local or cloud) is reachable and has models */
export async function isOllamaAvailable(): Promise<boolean> {
  // Cloud: if key is set, assume available (validate lazily on first call)
  if (isOllamaCloud()) return true
  const models = await listOllamaModels()
  return models.length > 0
}

/** Sync check for routing decisions (uses cache) */
export function isOllamaConfigured(): boolean {
  if (process.env.OLLAMA_DISABLED === 'true') return false
  if (isOllamaCloud()) return true
  if (_availableCache && _availableCache.models.length > 0) return true
  // Optimistic: check on first real call
  return !!process.env.OLLAMA_HOST
}

/** Call Ollama for a chat completion */
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
  // Cloud is fast, local can be slow
  const timeoutMs = isOllamaCloud() ? 30_000 : 120_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        stream: false,
        ...(isOllamaCloud() ? {} : {
          options: { temperature: 0.7, num_predict: 2048 },
        }),
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`Ollama${isOllamaCloud() ? ' Cloud' : ''} error ${res.status}: ${err.slice(0, 200)}`)
    }

    const data = (await res.json()) as any
    return data.choices?.[0]?.message?.content ?? '[No response from Ollama]'
  } finally {
    clearTimeout(timeout)
  }
}

export function refreshOllamaCache(): void {
  _availableCache = null
}
