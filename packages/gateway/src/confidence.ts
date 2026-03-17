// Confidence scoring — AI rates its own answer, gateway extracts + logs it.
// AI appends [CONFIDENCE: 85%] to responses. Gateway strips the tag,
// logs it, and surface it in /stats.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const CONF_FILE = path.join(os.homedir(), '.hydra', 'confidence.json')
const MAX_ENTRIES = 500

export interface ConfidenceEntry {
  ts: string
  score: number      // 0-100
  route: string
  provider: string
  channel: string
  promptSnippet: string
}

const CONFIDENCE_TAG = /\[CONFIDENCE:\s*(\d+)%?\]/i

function ensureDir() {
  const d = path.dirname(CONF_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

/** Strip [CONFIDENCE: N%] tag from text, return score + clean text */
export function extractConfidence(text: string): { score: number | null; clean: string } {
  const m = CONFIDENCE_TAG.exec(text)
  if (!m) return { score: null, clean: text }
  const score = Math.min(100, Math.max(0, parseInt(m[1], 10)))
  const clean = text.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim()
  return { score, clean }
}

export function logConfidence(
  score: number,
  route: string,
  provider: string,
  channel: string,
  promptSnippet: string,
): void {
  try {
    ensureDir()
    let entries: ConfidenceEntry[] = []
    if (fs.existsSync(CONF_FILE)) {
      try { entries = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) } catch {}
    }
    entries.push({ ts: new Date().toISOString(), score, route, provider, channel, promptSnippet: promptSnippet.slice(0, 100) })
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
    fs.writeFileSync(CONF_FILE, JSON.stringify(entries, null, 2))
  } catch {}
}

export function getConfidenceSummary(): string {
  try {
    if (!fs.existsSync(CONF_FILE)) return ''
    const entries: ConfidenceEntry[] = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))
    if (!entries.length) return ''

    const today = entries.filter(e => e.ts.slice(0, 10) === new Date().toISOString().slice(0, 10))
    const avgAll = Math.round(entries.reduce((s, e) => s + e.score, 0) / entries.length)
    const avgToday = today.length
      ? Math.round(today.reduce((s, e) => s + e.score, 0) / today.length)
      : null

    const low = entries.filter(e => e.score < 50).length
    const lines = [`Confidence: avg ${avgAll}%${avgToday !== null ? ` (today: ${avgToday}%)` : ''}`]
    if (low > 0) lines.push(`  ⚠️ ${low} low-confidence responses (<50%)`)
    return lines.join('\n')
  } catch {
    return ''
  }
}

/** Instruction to append to system prompt so AI rates itself */
export const CONFIDENCE_INSTRUCTION = `\nAt the very end of your response, append exactly: [CONFIDENCE: N%] where N is your confidence (0-100) that your answer is correct and complete. Do not explain it.`
