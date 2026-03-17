// Self-improvement engine.
// agent_smith periodically reviews its own source code and makes improvements.
//
// Runs on a schedule (default: every 6 hours) OR triggered manually via /review.
// Reads a rotating set of source files, asks Claude/OpenCode to improve them,
// applies [SAVE:] and [RESTART] tags from the response, then reports to the owner.
//
// The AI is given full read/write access to its own source — same self-coding
// loop it uses when you ask it to change itself, but running autonomously.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createLogger } from './logger.js'
import { scheduleSelfRestart } from './self-update.js'

const log = createLogger('self-review')

const HYDRA_DIR = '/Users/gszulc/hydra'
const REVIEW_STATE_FILE = path.join(os.homedir(), '.hydra', 'self-review-state.json')

// Source files to rotate through — reviewed in round-robin order
const REVIEW_FILES = [
  'packages/gateway/src/gateway.ts',
  'packages/gateway/src/copilot-chat.ts',
  'packages/gateway/src/router.ts',
  'packages/gateway/src/opencode-session.ts',
  'packages/gateway/src/workspace.ts',
  'packages/gateway/src/self-update.ts',
  'packages/gateway/src/auth/ollama.ts',
  'packages/gateway/src/auth/codex-pool.ts',
  'packages/telegram/src/telegram-channel.ts',
]

type ReviewState = {
  lastRunAt: string
  lastFileIndex: number
  totalReviews: number
  improvements: string[]  // last 10 improvement summaries
}

function loadState(): ReviewState {
  try {
    return JSON.parse(fs.readFileSync(REVIEW_STATE_FILE, 'utf8'))
  } catch {
    return { lastRunAt: '', lastFileIndex: 0, totalReviews: 0, improvements: [] }
  }
}

function saveState(state: ReviewState): void {
  fs.mkdirSync(path.dirname(REVIEW_STATE_FILE), { recursive: true })
  fs.writeFileSync(REVIEW_STATE_FILE, JSON.stringify(state, null, 2))
}

function readFileWithLineNumbers(filePath: string): string {
  const full = path.join(HYDRA_DIR, filePath)
  if (!fs.existsSync(full)) return ''
  const lines = fs.readFileSync(full, 'utf8').split('\n')
  return lines.map((l, i) => `${String(i + 1).padStart(4, ' ')} | ${l}`).join('\n')
}

function getRecentGitLog(): string {
  try {
    return execSync('git -C /Users/gszulc/hydra log --oneline -10', { encoding: 'utf8' })
  } catch {
    return '(git log unavailable)'
  }
}

const REVIEW_SYSTEM = `You are agent_smith, reviewing your own source code to find improvements.

You have full permission to:
- Fix bugs you find
- Improve error handling
- Simplify overly complex code
- Add missing features that seem obviously useful
- Improve logging/debugging
- Fix anything that seems fragile

HOW TO MAKE CHANGES:
When you want to edit a file, use this exact format — a FILE block with the complete new file content:

<<<FILE: packages/gateway/src/some-file.ts>>>
// complete new file content here
// must be the ENTIRE file, not a partial
<<<END_FILE>>>

If you made changes that require a daemon restart to take effect, add <<<RESTART>>> at the end.

RULES:
- Only change things you are confident about
- Make at most 1-2 focused improvements per review
- If the code looks good, say so and do NOT include any FILE blocks
- Always explain what you changed and why BEFORE the FILE block
- Write the COMPLETE file content in the FILE block — not a diff, not a snippet
- Do NOT add FILE blocks unless you are actually making a change`

export type ReviewResult = {
  changed: boolean
  summary: string
  filesModified: string[]
  willRestart: boolean
}

export async function runSelfReview(triggerWorkdir?: string): Promise<ReviewResult> {
  const state = loadState()
  const fileIndex = state.lastFileIndex % REVIEW_FILES.length
  const targetFile = REVIEW_FILES[fileIndex]

  log.info(`[self-review] reviewing ${targetFile} (review #${state.totalReviews + 1})`)

  const fileContent = readFileWithLineNumbers(targetFile)
  if (!fileContent) {
    return { changed: false, summary: `File ${targetFile} not found — skipping.`, filesModified: [], willRestart: false }
  }

  const gitLog = getRecentGitLog()
  const workdir = triggerWorkdir ?? path.join(os.homedir(), '.hydra', 'review-workdir')
  fs.mkdirSync(workdir, { recursive: true })

  const prompt = `Here is my source file \`${targetFile}\` — review it and improve it if you see anything worth fixing.

Recent git history (what I've been working on):
\`\`\`
${gitLog}
\`\`\`

File content of \`${targetFile}\`:
\`\`\`typescript
${fileContent.slice(0, 12000)}${fileContent.length > 12000 ? '\n... (truncated)' : ''}
\`\`\`

Look for:
1. Bugs or edge cases that could cause errors
2. Missing error handling on network calls
3. Any obvious feature gaps given what this file does
4. Code that could be simpler or cleaner

Make at most 1-2 focused improvements. If the file looks good, say so.`

  let response = ''
  try {
    const { callClaudeDirect, isClaudeConfigured, callOllama } = await import('./copilot-chat.js')
    if (isClaudeConfigured()) {
      try {
        log.info('[self-review] using claude-opus-4-6')
        response = await callClaudeDirect(prompt, undefined, REVIEW_SYSTEM, 'claude-opus-4-6')
      } catch (claudeErr) {
        log.warn(`[self-review] Claude failed (${claudeErr}) — falling back to deepseek-v3.2`)
        response = await callOllama(prompt, REVIEW_SYSTEM, 'deepseek-v3.2')
      }
    } else {
      log.info('[self-review] claude not configured — using deepseek-v3.2')
      response = await callOllama(prompt, REVIEW_SYSTEM, 'deepseek-v3.2')
    }
  } catch (e) {
    log.error(`[self-review] AI call failed: ${e}`)
    return { changed: false, summary: `Review failed: ${e}`, filesModified: [], willRestart: false }
  }

  // Parse <<<FILE: path>>> blocks and <<<RESTART>>> tag
  const filesModified: string[] = []
  const FILE_BLOCK_RE = /<<<FILE:\s*([^>]+)>>>\n([\s\S]*?)<<<END_FILE>>>/g
  const RESTART_RE = /<<<RESTART>>>/i
  const shouldRestart = RESTART_RE.test(response)
  const clean = response.replace(FILE_BLOCK_RE, '').replace(RESTART_RE, '').trim()

  let match: RegExpExecArray | null
  FILE_BLOCK_RE.lastIndex = 0
  while ((match = FILE_BLOCK_RE.exec(response)) !== null) {
    const filePath = match[1].trim()
    const fileContent = match[2]
    const fullPath = path.join(HYDRA_DIR, filePath)
    try {
      // Safety: only allow writes within the hydra project
      if (!fullPath.startsWith(HYDRA_DIR)) {
        log.warn(`[self-review] blocked write outside hydra dir: ${fullPath}`)
        continue
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, fileContent)
      filesModified.push(filePath)
      log.info(`[self-review] wrote ${filePath}`)
    } catch (e) {
      log.warn(`[self-review] failed to write ${filePath}: ${e}`)
    }
  }

  if (shouldRestart && filesModified.length > 0) {
    log.info('[self-review] scheduling restart after improvements')
    scheduleSelfRestart()
  }

  // Update state
  state.lastRunAt = new Date().toISOString()
  state.lastFileIndex = fileIndex + 1
  state.totalReviews++
  const shortSummary = clean.slice(0, 200).replace(/\n/g, ' ')
  state.improvements = [shortSummary, ...state.improvements].slice(0, 10)
  saveState(state)

  const changed = filesModified.length > 0

  // Push improvements to GitHub
  if (changed) {
    try {
      const commitMsg = `self-improve: ${targetFile.split('/').pop()} — ${shortSummary.slice(0, 80)}`
      execSync(
        `cd ${HYDRA_DIR} && git add -A && git commit -m ${JSON.stringify(commitMsg)} && git push`,
        { encoding: 'utf8', timeout: 30_000 }
      )
      log.info(`[self-review] pushed improvements to GitHub`)
    } catch (e) {
      log.warn(`[self-review] git push failed: ${e}`)
    }
  }

  return {
    changed,
    summary: changed
      ? `Reviewed \`${targetFile}\`:\n${clean.slice(0, 800)}`
      : `Reviewed \`${targetFile}\` — looks good, no changes needed.`,
    filesModified,
    willRestart: shouldRestart && changed,
  }
}

export function getReviewStats(): { totalReviews: number; lastRunAt: string; recentImprovements: string[] } {
  const state = loadState()
  return {
    totalReviews: state.totalReviews,
    lastRunAt: state.lastRunAt || 'never',
    recentImprovements: state.improvements,
  }
}
