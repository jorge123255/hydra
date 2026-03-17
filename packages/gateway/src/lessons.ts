import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const HYDRA_DIR = path.join(os.homedir(), '.hydra')
const LESSONS_FILE = path.join(HYDRA_DIR, 'LESSONS.md')
const ERRORS_FILE = path.join(HYDRA_DIR, 'errors.json')
const FEEDBACK_FILE = path.join(HYDRA_DIR, 'feedback.json')

const MAX_ERRORS = 200
const MAX_FEEDBACK = 500

export interface ErrorRecord {
  ts: string
  type: string       // 'timeout' | 'auth' | 'rate_limit' | 'parse' | 'tool_fail' | 'other'
  provider: string
  message: string
  resolved: boolean
  resolution?: string
}

export interface FeedbackRecord {
  ts: string
  userId: string
  channel: string
  correction: string  // what the user said
  context?: string    // the bot's response that prompted it
  category: string    // 'too_long' | 'wrong_answer' | 'wrong_format' | 'wrong_tool' | 'other'
}

function ensureDir() {
  if (!fs.existsSync(HYDRA_DIR)) fs.mkdirSync(HYDRA_DIR, { recursive: true })
}

// ─── Error Memory ───────────────────────────────────────────────────────────

export function recordError(type: string, provider: string, message: string): void {
  try {
    ensureDir()
    let errors: ErrorRecord[] = []
    if (fs.existsSync(ERRORS_FILE)) {
      try { errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8')) } catch { errors = [] }
    }
    errors.push({ ts: new Date().toISOString(), type, provider, message, resolved: false })
    if (errors.length > MAX_ERRORS) errors = errors.slice(-MAX_ERRORS)
    fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2))
    rebuildLessons()
  } catch {}
}

export function resolveError(provider: string, type: string, resolution: string): void {
  try {
    if (!fs.existsSync(ERRORS_FILE)) return
    const errors: ErrorRecord[] = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8'))
    let changed = false
    for (const e of errors) {
      if (!e.resolved && e.provider === provider && e.type === type) {
        e.resolved = true
        e.resolution = resolution
        changed = true
        break
      }
    }
    if (changed) {
      fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2))
      rebuildLessons()
    }
  } catch {}
}

// ─── Feedback Extraction ─────────────────────────────────────────────────────

// Patterns that suggest the user is correcting the bot
const CORRECTION_PATTERNS = [
  /\b(no[,.]?\s+(that'?s?\s+)?(wrong|not right|incorrect))/i,
  /\b(don'?t\s+do\s+that)\b/i,
  /\b(stop\s+(doing|saying|adding))\b/i,
  /\b(that'?s?\s+not\s+what\s+i\s+(asked|wanted|meant))\b/i,
  /\b(next\s+time[,\s])/i,
  /\b(always\s+(use|do|say|reply)\b)/i,
  /\b(never\s+(do|use|say)\b)/i,
  /\b(too\s+(long|verbose|short|brief|slow|fast))\b/i,
  /\b(wrong\s+(format|model|approach|way))\b/i,
  /\b(you\s+(should|shouldn'?t|need\s+to|must))\b/i,
]

function categorizeFeedback(text: string): string {
  if (/too\s+(long|verbose|wordy)/i.test(text)) return 'too_long'
  if (/too\s+(short|brief)/i.test(text)) return 'too_short'
  if (/wrong\s+(format|style|markdown)/i.test(text)) return 'wrong_format'
  if (/wrong\s+(model|provider|tool)/i.test(text)) return 'wrong_tool'
  if (/(not\s+what\s+i\s+asked|didn'?t\s+ask\s+for)/i.test(text)) return 'wrong_answer'
  return 'other'
}

export function extractFeedback(
  userId: string,
  channel: string,
  userMessage: string,
  previousBotMessage?: string
): boolean {
  const isFeedback = CORRECTION_PATTERNS.some(p => p.test(userMessage))
  if (!isFeedback) return false

  try {
    ensureDir()
    let feedback: FeedbackRecord[] = []
    if (fs.existsSync(FEEDBACK_FILE)) {
      try { feedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) } catch { feedback = [] }
    }
    feedback.push({
      ts: new Date().toISOString(),
      userId,
      channel,
      correction: userMessage.slice(0, 500),
      context: previousBotMessage?.slice(0, 300),
      category: categorizeFeedback(userMessage),
    })
    if (feedback.length > MAX_FEEDBACK) feedback = feedback.slice(-MAX_FEEDBACK)
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2))
    rebuildLessons()
  } catch {}

  return true
}

// ─── LESSONS.md ──────────────────────────────────────────────────────────────

export function rebuildLessons(): void {
  try {
    ensureDir()
    const lines: string[] = [
      '# LESSONS.md — Hydra Self-Learned Lessons',
      `_Last updated: ${new Date().toISOString()}_`,
      '',
    ]

    // Error patterns
    let errors: ErrorRecord[] = []
    if (fs.existsSync(ERRORS_FILE)) {
      try { errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8')) } catch {}
    }

    const unresolvedByType: Record<string, ErrorRecord[]> = {}
    for (const e of errors.filter(e => !e.resolved)) {
      if (!unresolvedByType[e.type]) unresolvedByType[e.type] = []
      unresolvedByType[e.type].push(e)
    }

    if (Object.keys(unresolvedByType).length > 0) {
      lines.push('## Recurring Errors')
      for (const [type, errs] of Object.entries(unresolvedByType)) {
        if (errs.length < 2) continue
        const providers = [...new Set(errs.map(e => e.provider))].join(', ')
        lines.push(`- **${type}** (${errs.length}x) on ${providers}: ${errs[errs.length - 1].message.slice(0, 120)}`)
      }
      lines.push('')
    }

    // Resolved lessons
    const resolved = errors.filter(e => e.resolved && e.resolution)
    if (resolved.length > 0) {
      lines.push('## Resolved — What Fixed It')
      for (const e of resolved.slice(-10)) {
        lines.push(`- **${e.provider}/${e.type}**: ${e.resolution}`)
      }
      lines.push('')
    }

    // Feedback patterns
    let feedback: FeedbackRecord[] = []
    if (fs.existsSync(FEEDBACK_FILE)) {
      try { feedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) } catch {}
    }

    if (feedback.length > 0) {
      const catCounts: Record<string, number> = {}
      for (const f of feedback) catCounts[f.category] = (catCounts[f.category] || 0) + 1

      lines.push('## User Feedback Patterns')
      for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`- **${cat}**: ${count} instance(s)`)
      }
      lines.push('')

      lines.push('## Recent Corrections')
      for (const f of feedback.slice(-5).reverse()) {
        const d = f.ts.slice(0, 10)
        lines.push(`- [${d}] ${f.correction.slice(0, 150)}`)
      }
      lines.push('')
    }

    if (lines.length <= 4) {
      lines.push('_No lessons recorded yet. Errors and user corrections will appear here automatically._')
    }

    fs.writeFileSync(LESSONS_FILE, lines.join('\n'))
  } catch {}
}

export function getLessonsContent(): string {
  try {
    if (!fs.existsSync(LESSONS_FILE)) {
      rebuildLessons()
    }
    return fs.readFileSync(LESSONS_FILE, 'utf8')
  } catch {
    return '# LESSONS.md\n_No lessons yet._'
  }
}

export function getRecentFeedback(n = 5): FeedbackRecord[] {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return []
    const feedback: FeedbackRecord[] = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'))
    return feedback.slice(-n)
  } catch {
    return []
  }
}
