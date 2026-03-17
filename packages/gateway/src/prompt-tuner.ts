// Prompt Auto-Tuning — learns from feedback patterns and adjusts system prompt.
// Reads LESSONS.md feedback categories, builds prefix adjustments automatically.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const FEEDBACK_FILE = path.join(os.homedir(), '.hydra', 'feedback.json')
const TUNING_FILE = path.join(os.homedir(), '.hydra', 'prompt-tuning.json')
const MIN_FEEDBACK_COUNT = 3  // only tune after N instances of same issue

interface FeedbackRecord {
  category: string
  correction: string
}

interface TuningState {
  adjustments: Record<string, { rule: string; count: number; active: boolean }>
  lastBuilt: string
}

// Category → rule to inject into system prompt
const CATEGORY_RULES: Record<string, string> = {
  too_long:      'Keep responses SHORT. 3-5 sentences max unless detail is explicitly asked for.',
  too_short:     'Give thorough, detailed answers. Do not truncate.',
  wrong_format:  'Use plain text. Avoid markdown unless the user asks for it.',
  wrong_tool:    'Double-check which tool or model is appropriate before acting.',
  wrong_answer:  'Re-read the question carefully before answering. Ask for clarification if unsure.',
  other:         '',
}

function loadFeedback(): FeedbackRecord[] {
  try {
    if (fs.existsSync(FEEDBACK_FILE)) return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'))
  } catch {}
  return []
}

function loadTuning(): TuningState {
  try {
    if (fs.existsSync(TUNING_FILE)) return JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8'))
  } catch {}
  return { adjustments: {}, lastBuilt: '' }
}

function saveTuning(state: TuningState) {
  const d = path.dirname(TUNING_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(TUNING_FILE, JSON.stringify(state, null, 2))
}

/** Rebuild tuning adjustments from feedback data */
export function rebuildTuning(): TuningState {
  const feedback = loadFeedback()
  const catCounts: Record<string, number> = {}
  for (const f of feedback) {
    catCounts[f.category] = (catCounts[f.category] || 0) + 1
  }

  const state = loadTuning()
  let changed = false

  for (const [cat, count] of Object.entries(catCounts)) {
    const rule = CATEGORY_RULES[cat]
    if (!rule) continue
    const prev = state.adjustments[cat]
    const shouldBeActive = count >= MIN_FEEDBACK_COUNT
    if (!prev) {
      state.adjustments[cat] = { rule, count, active: shouldBeActive }
      changed = true
    } else {
      if (prev.count !== count || prev.active !== shouldBeActive) {
        prev.count = count
        prev.active = shouldBeActive
        changed = true
      }
    }
  }

  if (changed) {
    state.lastBuilt = new Date().toISOString()
    saveTuning(state)
  }
  return state
}

/** Get prefix to inject at start of every system prompt */
export function getAutoTunePrefix(): string {
  try {
    rebuildTuning()
    const state = loadTuning()
    const active = Object.values(state.adjustments)
      .filter(a => a.active)
      .map(a => a.rule)
      .filter(Boolean)
    if (!active.length) return ''
    return `[Auto-tuned from user feedback]\n${active.map(r => `• ${r}`).join('\n')}\n\n`
  } catch {
    return ''
  }
}

/** Get human-readable tuning status */
export function getTuningStatus(): string {
  try {
    rebuildTuning()
    const state = loadTuning()
    const entries = Object.entries(state.adjustments)
    if (!entries.length) return 'No tuning applied yet. Rules activate after 3+ feedbacks of same type.'
    const lines = ['*Prompt Auto-Tuning*\n']
    for (const [cat, adj] of entries) {
      const status = adj.active ? '✅ active' : `⏳ ${adj.count}/${MIN_FEEDBACK_COUNT} (needs ${MIN_FEEDBACK_COUNT - adj.count} more)`
      lines.push(`• **${cat}** (${adj.count}x): ${status}`)
      if (adj.active) lines.push(`  → "${adj.rule}"`)
    }
    return lines.join('\n')
  } catch {
    return 'Error reading tuning state.'
  }
}
