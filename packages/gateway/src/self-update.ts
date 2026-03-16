// Self-update module — lets the bot persist what it learns AND restart itself.
//
// Two mechanisms:
// 1. [SAVE: key=value] tags in AI responses — stripped before sending, written to memory.
// 2. [RESTART] tag — triggers a launchd reload of the gateway daemon (self-coding loop).
// 3. Auto-detection of obvious user-driven updates (name changes, user facts).
//
// Supported [SAVE:] keys:
//   bot_name       → updates HYDRA_BOT_NAME + SOUL.md + .env
//   user_name      → updates USER.md
//   user_location  → updates USER.md + HYDRA_USER_LOCATION
//   user_timezone  → updates USER.md + HYDRA_USER_TIMEZONE
//   note           → appends to MEMORY.md
//   <anything>     → appends to MEMORY.md as "key: value"

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createLogger } from './logger.js'
import { appendMemory } from './memory.js'

const log = createLogger('self-update')

const DATA_DIR = process.env.HYDRA_DATA_DIR ?? path.join(os.homedir(), '.hydra')
const ENV_FILE = path.join(os.homedir(), 'hydra', '.env')

// ── [SAVE: ...] and [RESTART] tag parsing ─────────────────────────────────────

const SAVE_TAG_RE = /\[SAVE:\s*([^\]=]+?)\s*=\s*([^\]]+?)\s*\]/gi
const RESTART_TAG_RE = /\[RESTART\]/gi

export type SaveTag = { key: string; value: string }

/** Strip [SAVE: key=value] and [RESTART] tags from text, return them separately */
export function parseSaveTags(text: string): { clean: string; tags: SaveTag[]; shouldRestart: boolean } {
  let shouldRestart = false
  const tags: SaveTag[] = []

  let clean = text.replace(RESTART_TAG_RE, () => {
    shouldRestart = true
    return ''
  })
  clean = clean.replace(SAVE_TAG_RE, (_, key, value) => {
    tags.push({ key: key.trim().toLowerCase(), value: value.trim() })
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()

  return { clean, tags, shouldRestart }
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
      appendMemory(channelId, threadId, `${key}: ${value}`)
  }
}

/**
 * Schedule a self-restart via launchd.
 * Spawns a detached shell that waits 2s (for current process to finish sending reply),
 * then unloads + reloads the plist. The current process dies cleanly via launchd unload.
 */
export function scheduleSelfRestart(): void {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.hydra.gateway.plist')
  const script = `sleep 2 && launchctl unload "${plist}" && sleep 1 && launchctl load "${plist}"`
  const child = spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  log.info('Self-restart scheduled in 2s via launchd...')
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

  const soulPath = path.join(workdir, 'SOUL.md')
  try {
    if (fs.existsSync(soulPath)) {
      let soul = fs.readFileSync(soulPath, 'utf8')
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
