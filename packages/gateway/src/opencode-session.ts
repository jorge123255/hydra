// OpenCode session runner — creates sessions and streams responses back.
// Ported from Kimaki's thread-session-runtime.ts, generalized for any channel.

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { getClient } from './opencode-server.js'
import { createLogger } from './logger.js'

const log = createLogger('opencode-session')

export type RunOptions = {
  // Persistent session ID (reuse across messages in same thread)
  sessionId?: string
  directory: string
  prompt: string
  // Called with streamed text chunks as they arrive
  onChunk?: (text: string) => void
  // Abort signal
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

  // Create or reuse session
  let sessionId = opts.sessionId
  if (!sessionId) {
    const sessionResp = await client.session.create({
      title: prompt.slice(0, 80),
      directory,
      permission: {
        edit: 'allow',
        bash: 'allow',
        external_directory: 'ask',
        webfetch: 'allow',
      },
    })
    sessionId = sessionResp.data.id
    log.debug(`Created session ${sessionId} for dir: ${directory}`)
  }

  // Send the message
  await client.message.create({
    sessionID: sessionId,
    directory,
    parts: [{ type: 'text', text: prompt }],
  })

  // Subscribe to event stream and collect response
  const subscribeResp = await client.event.subscribe(
    { directory },
    { signal },
  )

  const outputParts: string[] = []
  let error: string | undefined

  try {
    for await (const event of subscribeResp.stream) {
      if (signal?.aborted) break

      // Collect text parts from assistant messages
      if (
        event.type === 'message.part.updated' &&
        event.properties.part.type === 'text'
      ) {
        const part = event.properties.part as { type: 'text'; text: string }
        if (part.text) {
          outputParts.push(part.text)
          onChunk?.(part.text)
        }
      }

      // Session idle = agent finished
      if (
        event.type === 'session.status' &&
        event.properties.status === 'idle' &&
        // @ts-ignore - sessionID may be on properties
        (event.properties.sessionID === sessionId || !event.properties.sessionID)
      ) {
        break
      }

      // Session error
      if (event.type === 'session.error') {
        error = event.properties.error?.message ?? 'Unknown session error'
        log.error(`Session ${sessionId} error:`, error)
        break
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      log.error(`Event stream error for session ${sessionId}:`, err)
      error = String(err)
    }
  }

  return {
    sessionId,
    text: outputParts.join(''),
    error,
  }
}
