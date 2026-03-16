// Conversation history — ported from OpenClaw's auto-reply/reply/history.ts
// Keeps the last N messages per thread and prepends them as context
// so the bot has conversational continuity in direct-chat mode.

const HISTORY_CONTEXT_MARKER = '[Chat messages since your last reply - for context]'
const CURRENT_MESSAGE_MARKER = '[Current message]'

const MAX_HISTORY_PER_THREAD = 20   // message pairs to keep in memory
const MAX_HISTORY_KEYS = 1000       // max threads before LRU eviction

export type HistoryEntry = {
  sender: string
  body: string
  timestamp: number
}

// In-memory history map: threadKey -> entries[]
const historyMap = new Map<string, HistoryEntry[]>()

function evictOldKeys(): void {
  if (historyMap.size <= MAX_HISTORY_KEYS) return
  const toDelete = historyMap.size - MAX_HISTORY_KEYS
  const iter = historyMap.keys()
  for (let i = 0; i < toDelete; i++) {
    const key = iter.next().value
    if (key) historyMap.delete(key)
  }
}

function threadKey(channelId: string, threadId: string): string {
  return `${channelId}:${threadId}`
}

/** Append a message to the thread history */
export function appendHistory(
  channelId: string,
  threadId: string,
  sender: string,
  body: string
): void {
  const key = threadKey(channelId, threadId)
  const entries = historyMap.get(key) ?? []
  entries.push({ sender, body: body.slice(0, 2000), timestamp: Date.now() })
  // Keep within limit
  while (entries.length > MAX_HISTORY_PER_THREAD * 2) entries.shift()
  // Refresh insertion order for LRU
  historyMap.delete(key)
  historyMap.set(key, entries)
  evictOldKeys()
}

/** Build the full prompt with conversation history prepended */
export function buildPromptWithHistory(
  channelId: string,
  threadId: string,
  currentMessage: string,
  senderName?: string
): string {
  const key = threadKey(channelId, threadId)
  const entries = historyMap.get(key) ?? []

  // Exclude the last entry if it's the current message already recorded
  const historyEntries = entries.length > 0 ? entries.slice(0, -1) : []

  if (historyEntries.length === 0) return currentMessage

  const historyText = historyEntries
    .map((e) => `${e.sender}: ${e.body}`)
    .join('\n')

  return [
    HISTORY_CONTEXT_MARKER,
    historyText,
    '',
    CURRENT_MESSAGE_MARKER,
    currentMessage,
  ].join('\n')
}

/** Clear history for a thread (e.g. /forget command) */
export function clearHistory(channelId: string, threadId: string): void {
  historyMap.delete(threadKey(channelId, threadId))
}

/** Get current history length for a thread */
export function getHistoryLength(channelId: string, threadId: string): number {
  return historyMap.get(threadKey(channelId, threadId))?.length ?? 0
}
