// OpenCode session runner — creates sessions and streams responses back.
// Ported from Kimaki's thread-session-runtime.ts, generalized for any channel.

import type { PermissionRuleset } from '@opencode-ai/sdk/v2'
import { getClient } from './opencode-server.js'
import { createLogger } from './logger.js'

const log = createLogger('opencode-session')

const DEFAULT_PERMISSIONS: PermissionRuleset = [
  { permission: 'edit', pattern: '**', action: 'allow' },
  { permission: 'bash', pattern: '**', action: 'allow' },
  { permission: 'webfetch', pattern: '**', action: 'allow' },
  { permission: 'external_directory', pattern: '**', action: 'ask' },
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
}

export async function runSession(opts: RunOptions): Promise<RunResult> {
  const { directory, prompt, onChunk, signal } = opts
  const client = await getClient(directory)

  // Create or reuse session — flat params per Kimaki's session.create pattern
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

  // Send prompt async — fire and forget, events carry the response
  await client.session.promptAsync({
    sessionID: sessionId,
    directory,
    parts: [{ type: 'text', text: prompt }],
  })

  // Subscribe to event stream
  const subscribeResp = await client.event.subscribe(
    { directory },
    { signal } as any,
  )

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

      // session.idle = agent finished for this session
      if (event.type === 'session.idle') {
        const idleId = event.properties?.sessionID
        if (!idleId || idleId === sessionId) break
      }

      if (event.type === 'session.error') {
        const err = event.properties?.error as any
        error = err?.message ?? err?.detail ?? 'Unknown session error'
        log.error(`Session ${sessionId} error: ${error}`)
        break
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      log.error(`Event stream error for session ${sessionId}:`, err)
      error = String(err)
    }
  }

  return { sessionId, text: outputParts.join(''), error }
}
