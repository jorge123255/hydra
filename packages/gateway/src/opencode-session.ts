// OpenCode session runner.
// Includes OpenClaw's proactive compaction fix + auth key rotation.
// Phase 4A: vision via FilePartInput (images as data URLs)
// Phase 4B: onChunk wired to event stream for streaming replies
// Feature 8: min 30 chars before first edit to avoid flickering

import type { PermissionRuleset, FilePartInput, TextPartInput } from '@opencode-ai/sdk/v2'
import { getClient } from './opencode-server.js'
import { createLogger } from './logger.js'

const log = createLogger('opencode-session')

const PROACTIVE_COMPACT_THRESHOLD = 0.6
const MAX_AUTO_COMPACTIONS = 5
// Don't emit first streaming chunk until this many chars are ready (feature 8)
const MIN_CHUNK_CHARS = 30

const DEFAULT_PERMISSIONS: PermissionRuleset = [
  { permission: 'edit',               pattern: '**', action: 'allow' },
  { permission: 'bash',               pattern: '**', action: 'allow' },
  { permission: 'webfetch',           pattern: '**', action: 'allow' },
  { permission: 'external_directory', pattern: '**', action: 'ask'   },
]

export type RunOptions = {
  sessionId?: string
  directory: string
  prompt: string
  // base64 data URLs e.g. "data:image/jpeg;base64,..."
  images?: string[]
  // called with accumulated text as chunks arrive (for live editing)
  onChunk?: (text: string) => Promise<void>
  signal?: AbortSignal
}

export type RunResult = {
  sessionId: string
  text: string
  error?: string
  compacted?: boolean
}

function getApiKeys(): string[] {
  const pool = process.env.HYDRA_API_KEYS
  if (pool) return pool.split(',').map((k) => k.trim()).filter(Boolean)
  const single = process.env.ANTHROPIC_API_KEY
  return single ? [single] : []
}

function isRateLimitError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return msg.includes('rate limit') || msg.includes('429') || msg.includes('overloaded')
}

function isAuthError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')
}

// Build the parts array: text + optional images (Phase 4A)
function buildParts(prompt: string, images?: string[]): Array<TextPartInput | FilePartInput> {
  const parts: Array<TextPartInput | FilePartInput> = [{ type: 'text', text: prompt }]
  if (images?.length) {
    for (const dataUrl of images) {
      const mime = dataUrl.match(/^data:([^;]+);base64,/)?.[1] ?? 'image/jpeg'
      parts.push({ type: 'file', mime, url: dataUrl } as FilePartInput)
    }
  }
  return parts
}

export async function runSession(opts: RunOptions): Promise<RunResult> {
  const { directory, prompt, images, onChunk, signal } = opts
  const client = await getClient(directory)

  let sessionId = opts.sessionId
  if (!sessionId) {
    const resp = await client.session.create({
      title: prompt.slice(0, 80),
      directory,
      permission: DEFAULT_PERMISSIONS,
    })
    sessionId = resp.data?.id
    if (!sessionId) throw new Error('Failed to create OpenCode session')
    log.debug(`Created session ${sessionId}`)
  }

  // Proactive compaction check
  let didCompact = false
  let compactionCount = 0
  try {
    const sessionInfo = await client.session.get({ sessionID: sessionId })
    const session = sessionInfo.data
    if (session) {
      const used = session.time?.compacting ?? 0
      const total = 100000
      if (total > 0 && used / total > PROACTIVE_COMPACT_THRESHOLD && compactionCount < MAX_AUTO_COMPACTIONS) {
        log.info(`[proactive-compact] at ${Math.round((used / total) * 100)}% — compacting`)
        await (client.session as any).summarize({
          path: { sessionID: sessionId },
          body: { providerID: 'anthropic', modelID: 'claude-3-5-haiku-20241022', auto: true },
        }).catch((e: unknown) => log.warn(`Compaction failed: ${e}`))
        didCompact = true
        compactionCount++
      }
    }
  } catch (e) {
    log.debug(`Could not check session: ${e}`)
  }

  // Send prompt with image parts + auth key rotation
  const apiKeys = getApiKeys()
  let promptError: unknown
  for (let attempt = 0; attempt < Math.max(1, apiKeys.length); attempt++) {
    try {
      await client.session.promptAsync({
        sessionID: sessionId,
        directory,
        parts: buildParts(prompt, images),
      })
      promptError = undefined
      break
    } catch (err) {
      promptError = err
      if ((isRateLimitError(err) || isAuthError(err)) && attempt < apiKeys.length - 1) {
        log.warn(`Key ${attempt + 1}/${apiKeys.length} failed, rotating...`)
        process.env.ANTHROPIC_API_KEY = apiKeys[attempt + 1]
        continue
      }
      throw err
    }
  }
  if (promptError) throw promptError

  // Stream response.
  // message.updated tells us which messageIDs have role=assistant.
  // message.part.updated carries the full current text of each part (streaming updates replace, not append).
  // We collect partId -> text for all parts, then at the end filter to assistant-only messageIDs.
  // For onChunk streaming we emit optimistically once we know a part belongs to an assistant message.
  // Feature 8: don't emit first chunk until MIN_CHUNK_CHARS are ready.
  const subscribeResp = await client.event.subscribe({ directory }, { signal } as any)

  // messageID -> role
  const messageRoles = new Map<string, 'user' | 'assistant'>()
  // partID -> { messageID, text } — ALL parts (filtered at end)
  const allParts = new Map<string, { messageID: string; text: string }>()
  let error: string | undefined
  let lastChunkAt = 0
  let firstChunkEmitted = false

  const getAssistantText = (): string => {
    const assistantPartTexts: string[] = []
    for (const [, { messageID, text }] of allParts) {
      if (messageRoles.get(messageID) === 'assistant') {
        assistantPartTexts.push(text)
      }
    }
    return assistantPartTexts.join('')
  }

  async function maybeEmitChunk(force = false): Promise<void> {
    if (!onChunk) return
    const text = getAssistantText()
    if (!text) return
    // Feature 8: wait for MIN_CHUNK_CHARS before first streaming edit
    if (!firstChunkEmitted && text.length < MIN_CHUNK_CHARS && !force) return
    const now = Date.now()
    if (force || now - lastChunkAt > 800) {
      await onChunk(text).catch(() => {})
      lastChunkAt = now
      firstChunkEmitted = true
    }
  }

  try {
    for await (const event of (subscribeResp as any).stream ?? []) {
      if (signal?.aborted) break

      if (event.type === 'message.updated') {
        const info = event.properties?.info
        if (info?.id && (info.role === 'assistant' || info.role === 'user')) {
          messageRoles.set(info.id, info.role)
          if (info.role === 'assistant') await maybeEmitChunk()
        }
      }

      if (event.type === 'message.part.updated') {
        const part = event.properties?.part
        if (part?.type === 'text' && typeof part.text === 'string' && part.text && part.id) {
          const msgId: string = (part as any).messageID ?? ''
          allParts.set(part.id, { messageID: msgId, text: part.text })
          if (messageRoles.get(msgId) === 'assistant') {
            await maybeEmitChunk()
          }
        }
      }

      if (event.type === 'session.idle') {
        const idleId = event.properties?.sessionID
        if (!idleId || idleId === sessionId) break
      }

      if (event.type === 'session.error') {
        const err = event.properties?.error as any
        error = err?.message ?? err?.detail ?? 'Unknown session error'
        if (isAuthError(error ?? '')) {
          error = `Authentication failed. Check your API key. (${error})`
        }
        log.error(`Session ${sessionId} error: ${error}`)
        break
      }

      if (event.type === 'session.compacted') {
        log.info(`[compaction] Session ${sessionId} was compacted`)
        didCompact = true
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      log.error(`Event stream error for session ${sessionId}:`, err)
      error = String(err)
    }
  }

  await maybeEmitChunk(true)

  const finalText = getAssistantText()
  return { sessionId, text: finalText, error, compacted: didCompact }
}
