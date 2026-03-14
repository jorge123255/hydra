// Self-update module — lets the bot persist what it learns.
//
// Two mechanisms:
// 1. [SAVE: key=value] tags in AI responses — stripped before sending, written to memory.
// 2. Auto-detection of obvious user-driven updates (name changes, user facts).
//
// Supported keys:
//   bot_name       → updates HYDRA_BOT_NAME + SOUL.md + .env
//   user_name      → updates USER.md
//   user_location  → updates USER.md + HYDRA_USER_LOCATION
//   user_timezone  → updates USER.md + HYDRA_USER_TIMEZONE
//   note           → appends to MEMORY.md
//   <anything>     → appends to MEMORY.md as "key: value"

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from './logger.js'
import { appendMemory } from './memory.js'

const log = createLogger('self-update')

const DATA_DIR = process.env.HYDRA_DATA_DIR ?? path.join(os.homedir(), '.hydra')
const ENV_FILE = path.join(os.homedir(), 'hydra', '.env')

// ── [SAVE: ...] tag parsing ────────────────────────────────────────────────────

const SAVE_TAG_RE = /\[SAVE:\s*([^\]=]+?)\s*=\s*([^\]]+?)\s*\]/gi

export type SaveTag = { key: string; value: string }

/** Strip [SAVE: key=value] tags from text and return them separately */
export function parseSaveTags(text: string): { clean: string; tags: SaveTag[] } {
  const tags: SaveTag[] = []
  const clean = text.replace(SAVE_TAG_RE, (_, key, value) => {
    tags.push({ key: key.trim().toLowerCase(), value: value.trim() })
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { clean, tags }
}

/** Apply a single save tag — writes to the appropriate persistence layer */
export function applySaveTag(
  tag: SaveTag,
  workdir: string,
  channelId: string,
  threadId: string
): void {
  const { key, value } = tag
  log.info(`Self-update: ${key}=${value}`)

  switch (key) {
    case 'bot_name':
      setBotName(value, workdir)
      break
    case 'user_name':
      updateUserFile(workdir, 'Name', value)
      appendMemory(channelId, threadId, `User name: ${value}`)
      break
    case 'user_location':
      process.env.HYDRA_USER_LOCATION = value
      persistEnvVar('HYDRA_USER_LOCATION', value)
      updateUserFile(workdir, 'Location', value)
      appendMemory(channelId, threadId, `User location: ${value}`)
      break
    case 'user_timezone':
      process.env.HYDRA_USER_TIMEZONE = value
      persistEnvVar('HYDRA_USER_TIMEZONE', value)
      updateUserFile(workdir, 'Timezone', value)
      break
    case 'note':
      appendMemory(channelId, threadId, value)
      break
    default:
      // Generic key — just append to memory
      appendMemory(channelId, threadId, `${key}: ${value}`)
  }
}

// ── Auto-detect user-driven updates ─────────────────────────────────────────────

/** Pattern-match the user's message for obvious self-update instructions.
 *  Returns tags to apply even if the AI didn't emit [SAVE:...]. */
export function detectAutoUpdates(userText: string): SaveTag[] {
  const tags: SaveTag[] = []
  const text = userText.trim()

  // "your name is X" / "call yourself X" / "you are called X"
  const namePatterns = [
    /your\s+name\s+is\s+["']?([^"'\n,]+?)["']?\s*$/i,
    /call\s+yourself\s+["']?([^"'\n,]+?)["']?\s*$/i,
    /you\s+are\s+(?:called|named)\s+["']?([^"'\n,]+?)["']?\s*$/i,
    /rename\s+yourself\s+(?:to\s+)?["']?([^"'\n,]+?)["']?\s*$/i,
  ]
  for (const re of namePatterns) {
    const m = re.exec(text)
    if (m) { tags.push({ key: 'bot_name', value: m[1].trim() }); break }
  }

  // "my name is X" / "I'm X" / "I am X"
  const userNamePatterns = [
    /my\s+name\s+is\s+["']?([A-Z][a-zA-Z]+)["']?/i,
    /(?:call\s+me|i(?:'m|\s+am))\s+["']?([A-Z][a-zA-Z]+)["']?/i,
  ]
  for (const re of userNamePatterns) {
    const m = re.exec(text)
    // Avoid false positives like "I'm asking about..."
    if (m && m[1].length < 30) { tags.push({ key: 'user_name', value: m[1].trim() }); break }
  }

  // "I'm in Chicago" / "I'm located in X" / "my location is X"
  const locationPatterns = [
    /i(?:'m|\s+am)\s+(?:in|located\s+in|based\s+in)\s+([A-Za-z][^,\n]{2,40})/i,
    /my\s+(?:location|city|town)\s+is\s+([A-Za-z][^,\n]{2,40})/i,
  ]
  for (const re of locationPatterns) {
    const m = re.exec(text)
    if (m) { tags.push({ key: 'user_location', value: m[1].trim() }); break }
  }

  return tags
}

// ── Persistence helpers ──────────────────────────────────────────────────────────

function setBotName(name: string, workdir: string): void {
  process.env.HYDRA_BOT_NAME = name
  persistEnvVar('HYDRA_BOT_NAME', name)

  // Update SOUL.md in workdir to use new name
  const soulPath = path.join(workdir, 'SOUL.md')
  try {
    if (fs.existsSync(soulPath)) {
      let soul = fs.readFileSync(soulPath, 'utf8')
      // Replace the name references
      soul = soul
        .replace(/^You are \S+/m, `You are ${name}`)
        .replace(/Your name is \S+\./g, `Your name is ${name}.`)
        .replace(/say "I'm \S+\."/g, `say "I'm ${name}."`)
      fs.writeFileSync(soulPath, soul)
    }
  } catch (e) {
    log.warn(`Could not update SOUL.md: ${e}`)
  }
  log.info(`Bot name updated to: ${name}`)
}

function updateUserFile(workdir: string, field: string, value: string): void {
  const filePath = path.join(workdir, 'USER.md')
  try {
    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '# User Profile\n\n'
    const re = new RegExp(`^${field}:.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, `${field}: ${value}`)
    } else {
      content = content.trimEnd() + `\n${field}: ${value}\n`
    }
    fs.writeFileSync(filePath, content)
  } catch (e) {
    log.warn(`Could not update USER.md: ${e}`)
  }
}

/** Persist an env var to the .env file so it survives restarts */
function persistEnvVar(key: string, value: string): void {
  // Try a few likely .env paths
  const candidates = [
    ENV_FILE,
    path.join(os.homedir(), 'hydra', '.env'),
    '/Users/gszulc/hydra/.env',
  ]

  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue
      let content = fs.readFileSync(envPath, 'utf8')
      const re = new RegExp(`^${key}=.*$`, 'm')
      if (re.test(content)) {
        content = content.replace(re, `${key}=${value}`)
      } else {
        content = content.trimEnd() + `\n${key}=${value}\n`
      }
      fs.writeFileSync(envPath, content)
      log.debug(`Persisted ${key} to ${envPath}`)
      return
    } catch {}
  }
  log.warn(`Could not persist ${key} to .env — will reset after restart`)
}
