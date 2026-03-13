// OpenCode session runner.
// Includes OpenClaw's proactive compaction fix (from clawdbot-patches):
//   - compact at 60% context window BEFORE overflow errors hit
//   - auth key rotation on rate-limit/auth errors

import type { PermissionRuleset } from '@opencode-ai/sdk/v2'
import { getClient } from './opencode-server.js'
import { createLogger } from './logger.js'

const log = createLogger('opencode-session')

// Ported from clawdbot-patches/run-proactive-compaction.patch
const PROACTIVE_COMPACT_THRESHOLD = 0.6 // compact if >60% of context used
const MAX_AUTO_COMPACTIONS = 5

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
  onChunk?: (text: string) => Promise<void>
  signal?: AbortSignal
}

export type RunResult = {
  sessionId: string
  text: string
  error?: string
  compacted?: boolean
}

// Auth key rotation — pulls keys from HYDRA_API_KEYS (comma-sep) or falls
// back to ANTHROPIC_API_KEY. On rate-limit errors the gateway retries with
// the next key in the pool (OpenClaw auth-profiles pattern).
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

export async function runSession(opts: RunOptions): Promise<RunResult> {
  const { directory, prompt, onChunk, signal } = opts
  const client = await getClient(directory)

  // Create or reuse session
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

  // Check if proactive compaction is needed before sending
  // Mirrors OpenClaw's clawdbot-patches/run-proactive-compaction.patch
  let didCompact = false
  try {
    const sessionInfo = await client.session.get({ sessionID: sessionId })
    const session = sessionInfo.data
    if (session) {
      const used = session.time?.compacting ?? 0
      const total = 100000 // OpenCode manages context internally
      if (total > 0 && used / total > PROACTIVE_COMPACT_THRESHOLD) {
        log.info(
          `[proactive-compact] Session at ${Math.round((used / total) * 100)}% capacity — compacting before prompt`
        )
        await (client.session as any).summarize({
          path: { sessionID: sessionId },
          body: { providerID: 'anthropic', modelID: 'claude-3-5-haiku-20241022', auto: true },
        }).catch((e: unknown) => log.warn(`Compaction failed (non-fatal): ${e}`))
        didCompact = true
      }
    }
  } catch (e) {
    log.debug(`Could not check session token usage: ${e}`)
  }

  // Send prompt with auth key rotation on failure
  const apiKeys = getApiKeys()
  let promptError: unknown
  for (let attempt = 0; attempt < Math.max(1, apiKeys.length); attempt++) {
    try {
      await client.session.promptAsync({
        sessionID: sessionId,
        directory,
        parts: [{ type: 'text', text: prompt }],
      })
      promptError = undefined
      break
    } catch (err) {
      promptError = err
      if ((isRateLimitError(err) || isAuthError(err)) && attempt < apiKeys.length - 1) {
        log.warn(`Auth/rate-limit error on key ${attempt + 1}/${apiKeys.length}, rotating...`)
        process.env.ANTHROPIC_API_KEY = apiKeys[attempt + 1]
        continue
      }
      throw err
    }
  }
  if (promptError) throw promptError

  // Subscribe and stream response
  const subscribeResp = await client.event.subscribe({ directory }, { signal } as any)

  const outputParts: string[] = []
  let error: string | undefined

  try {
    for await (const event of (subscribeResp as any).stream ?? []) {
      if (signal?.aborted) break

      if (event.type === 'message.part.updated') {
        const part = event.properties?.part
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          outputParts.push(part.text)
          await onChunk?.(part.text)
        }
      }

      if (event.type === 'session.idle') {
        const idleId = event.properties?.sessionID
        if (!idleId || idleId === sessionId) break
      }

      if (event.type === 'session.error') {
        const err = event.properties?.error as any
        error = err?.message ?? err?.detail ?? 'Unknown session error'
        // Auth errors — surface clearly so user can fix their key
        if (isAuthError(error ?? '')) {
          error = `Authentication failed. Check your API key. (${error})`
        }
        log.error(`Session ${sessionId} error: ${error}`)
        break
      }

      // OpenCode signals context overflow — trigger compaction and retry hint
      if (event.type === 'session.compacted') {
        log.info(`[compaction] Session ${sessionId} was compacted by OpenCode`)
        didCompact = true
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      log.error(`Event stream error for session ${sessionId}:`, err)
      error = String(err)
    }
  }

  return { sessionId, text: outputParts.join(''), error, compacted: didCompact }
}
