// Goal tracking — persist multi-step goals across sessions.
// AI can add goals with [GOAL: text] and complete them with [GOAL_DONE: n].
// User can manage via /goals, /goal <text>, /goal done <n>.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const GOALS_FILE = path.join(os.homedir(), '.hydra', 'goals.json')

export interface Goal {
  id: number
  text: string
  createdAt: string
  completedAt?: string
  done: boolean
  channel: string
  threadId: string
}

function ensureDir() {
  const d = path.dirname(GOALS_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

function load(): Goal[] {
  try {
    if (fs.existsSync(GOALS_FILE)) return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'))
  } catch {}
  return []
}

function save(goals: Goal[]) {
  ensureDir()
  fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2))
}

export function addGoal(text: string, channel: string, threadId: string): Goal {
  const goals = load()
  const maxId = goals.reduce((m, g) => Math.max(m, g.id), 0)
  const goal: Goal = { id: maxId + 1, text: text.trim(), createdAt: new Date().toISOString(), done: false, channel, threadId }
  goals.push(goal)
  save(goals)
  return goal
}

export function completeGoal(id: number): boolean {
  const goals = load()
  const g = goals.find(g => g.id === id)
  if (!g || g.done) return false
  g.done = true
  g.completedAt = new Date().toISOString()
  save(goals)
  return true
}

export function listGoals(channel?: string, threadId?: string, includeDone = false): Goal[] {
  const goals = load()
  return goals.filter(g =>
    (includeDone || !g.done) &&
    (!channel || g.channel === channel) &&
    (!threadId || g.threadId === threadId)
  )
}

export function formatGoalsList(goals: Goal[]): string {
  if (!goals.length) return 'No active goals.'
  return goals.map(g => `${g.done ? '✅' : '🎯'} [${g.id}] ${g.text}`).join('\n')
}

/** Parse [GOAL: text] and [GOAL_DONE: n] tags from AI response */
export function extractGoalTags(
  text: string,
  channel: string,
  threadId: string,
): { clean: string; added: Goal[]; completed: number[] } {
  const added: Goal[] = []
  const completed: number[] = []

  let clean = text

  // [GOAL: some task to accomplish]
  const GOAL_TAG = /\[GOAL:\s*([^\]]+)\]/gi
  clean = clean.replace(GOAL_TAG, (_, goalText) => {
    const g = addGoal(goalText.trim(), channel, threadId)
    added.push(g)
    return ''
  })

  // [GOAL_DONE: 3]
  const GOAL_DONE_TAG = /\[GOAL_DONE:\s*(\d+)\]/gi
  clean = clean.replace(GOAL_DONE_TAG, (_, idStr) => {
    const id = parseInt(idStr, 10)
    if (completeGoal(id)) completed.push(id)
    return ''
  })

  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), added, completed }
}

/** Write GOALS.md to workspace so AI always sees current goals */
export function writeGoalsFile(workdir: string, channel: string, threadId: string): void {
  try {
    const active = listGoals(channel, threadId, false)
    const done = listGoals(channel, threadId, true).filter(g => g.done).slice(-5)
    const lines = ['# GOALS.md — Active Goals', '']
    if (active.length) {
      lines.push('## Active')
      active.forEach(g => lines.push(`- [${g.id}] ${g.text}`))
      lines.push('')
    } else {
      lines.push('_No active goals._', '')
    }
    if (done.length) {
      lines.push('## Recently Completed')
      done.forEach(g => lines.push(`- ~~[${g.id}] ${g.text}~~`))
    }
    fs.writeFileSync(path.join(workdir, 'GOALS.md'), lines.join('\n'))
  } catch {}
}

export const GOALS_INSTRUCTION = `\nTo track a new goal, include [GOAL: description] in your response. To mark a goal complete, include [GOAL_DONE: id].`
