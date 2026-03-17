// Decision Audit Trail — log every significant AI decision with reasoning.
// AI includes [DECISION: action | reason] tags. Gateway strips + persists.
// Gateway also auto-logs routing decisions.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const AUDIT_FILE = path.join(os.homedir(), '.hydra', 'audit.json')
const MAX_ENTRIES = 1000

export interface AuditEntry {
  ts: string
  type: 'ai_decision' | 'route' | 'self_review' | 'health_alert' | 'tool_call'
  action: string
  reason: string
  channel?: string
  provider?: string
}

function ensureDir() {
  const d = path.dirname(AUDIT_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

export function logAudit(entry: Omit<AuditEntry, 'ts'>): void {
  try {
    ensureDir()
    let entries: AuditEntry[] = []
    if (fs.existsSync(AUDIT_FILE)) {
      try { entries = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')) } catch {}
    }
    entries.push({ ts: new Date().toISOString(), ...entry })
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(entries, null, 2))
  } catch {}
}

/** Parse [DECISION: action | reason] tags from AI response */
export function extractDecisionTags(text: string, channel: string): { clean: string; count: number } {
  const DECISION_TAG = /\[DECISION:\s*([^|\]]+)\|?\s*([^\]]*)\]/gi
  let count = 0
  const clean = text.replace(DECISION_TAG, (_, action, reason) => {
    logAudit({ type: 'ai_decision', action: action.trim(), reason: reason.trim(), channel })
    count++
    return ''
  })
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), count }
}

export function getRecentAudit(n = 20): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return []
    const entries: AuditEntry[] = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'))
    return entries.slice(-n).reverse()
  } catch { return [] }
}

export function formatAuditLog(entries: AuditEntry[]): string {
  if (!entries.length) return 'No audit entries yet.'
  const icon = (t: string) => t === 'route' ? '🔀' : t === 'self_review' ? '🤖' : t === 'health_alert' ? '🏥' : '💡'
  return entries.map(e => {
    const time = e.ts.slice(11, 16)
    const date = e.ts.slice(0, 10)
    return `${icon(e.type)} [${date} ${time}] **${e.action}**${e.reason ? ` — ${e.reason}` : ''}`
  }).join('\n')
}

export const DECISION_INSTRUCTION = `\nWhen you make a significant decision (choosing an approach, using a tool, changing direction), include [DECISION: what you decided | why] in your response. This builds an audit trail.`
