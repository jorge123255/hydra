// Self-improvement engine.
// agent_smith periodically reviews its own source code and makes improvements.
//
// Improvements over v1:
//   1. Log-driven priority — files with recent errors get reviewed first
//   2. Rich context — LESSONS.md + recent errors injected into prompt
//   3. Two-stage pipeline — nemotron/opus ANALYZES → devstral IMPLEMENTS
//   4. Smart scheduling — shouldRunNow() detects error spikes / recent commits
//   5. Runtime check — tsx --check after typecheck to catch import-time errors
//
// Runs on a schedule (default: every 6 hours) OR triggered manually via /review.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createLogger } from './logger.js'
import { scheduleSelfRestart } from './self-update.js'

const log = createLogger('self-review')

const HYDRA_DIR = '/Users/gszulc/hydra'
const REVIEW_STATE_FILE = path.join(os.homedir(), '.hydra', 'self-review-state.json')
const LOG_FILE = path.join(os.homedir(), '.hydra', 'logs', 'gateway.log')
const LOG_ERR_FILE = path.join(os.homedir(), '.hydra', 'logs', 'gateway.err')

// Source files to rotate through — reviewed in round-robin, hottest errors first
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
  lastErrorCount: number  // error count at last run (for spike detection)
  lastReviewedFile?: string
  consecutiveReviews?: number
  outcomeLog?: Array<{ file: string; changed: boolean; errorsBefore: number; errorsAfter?: number; ts: string }>
}

function loadState(): ReviewState {
  try {
    return JSON.parse(fs.readFileSync(REVIEW_STATE_FILE, 'utf8'))
  } catch {
    return { lastRunAt: '', lastFileIndex: 0, totalReviews: 0, improvements: [], lastErrorCount: 0 }
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

/** Read the last N lines of a log file */
function readLastLines(filePath: string, n = 300): string[] {
  try {
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf8')
    return content.split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}

/**
 * Parse recent logs to build a frequency map of which REVIEW_FILES
 * appear most often in error/warn lines.
 * Returns REVIEW_FILES sorted by error frequency (hottest first).
 */
function rankFilesByErrors(baseIndex: number): string[] {
  const freq = new Map<string, number>()

  const lines = [
    ...readLastLines(LOG_FILE, 500),
    ...readLastLines(LOG_ERR_FILE, 300),
  ]

  for (const line of lines) {
    if (!/ERROR|WARN|TypeError|ReferenceError|SyntaxError|failed|crashed/i.test(line)) continue
    for (const f of REVIEW_FILES) {
      const basename = path.basename(f, '.ts')
      if (line.includes(basename) || line.includes(f)) {
        freq.set(f, (freq.get(f) ?? 0) + 1)
      }
    }
  }

  if (freq.size === 0) {
    // No signal — fall back to round-robin from baseIndex
    return [...REVIEW_FILES.slice(baseIndex), ...REVIEW_FILES.slice(0, baseIndex)]
  }

  // Sort by error count desc, files not seen go to end
  return [...REVIEW_FILES].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))
}

/** Get recent error log lines that mention a specific file */
function getRecentErrors(targetFile: string, n = 15): string {
  const basename = path.basename(targetFile, '.ts')
  const lines = [
    ...readLastLines(LOG_FILE, 500),
    ...readLastLines(LOG_ERR_FILE, 300),
  ]
  const relevant = lines.filter(l =>
    (l.includes(basename) || l.includes(targetFile)) &&
    /ERROR|WARN|TypeError|ReferenceError|failed|crashed/i.test(l)
  )
  if (relevant.length === 0) return '(no recent errors for this file)'
  return relevant.slice(-n).join('\n')
}

/** Count total error lines in the last hour across all logs */
function getErrorCountLastHour(): number {
  const cutoff = Date.now() - 60 * 60 * 1000
  const lines = readLastLines(LOG_FILE, 2000)
  let count = 0
  for (const line of lines) {
    const tsMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
    if (tsMatch) {
      try {
        if (new Date(tsMatch[1]).getTime() < cutoff) continue
      } catch { /* skip unparseable timestamps */ }
    }
    // Exclude self-review's own warn/error lines to avoid feedback loops
    if (/ERROR|TypeError|ReferenceError|failed|crashed/i.test(line) &&
        !/\[self-review\]/.test(line)) count++
  }
  return count
}

/** Read LESSONS.md from the workspace */
function readLessons(): string {
  const candidates = [
    path.join(os.homedir(), '.hydra', 'workspace', 'LESSONS.md'),
    path.join(os.homedir(), '.hydra', 'LESSONS.md'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').slice(0, 2000)
    } catch { /* continue */ }
  }
  return ''
}

/**
 * Should we trigger a self-review right now (outside the normal schedule)?
 * Returns a reason string if yes, null if no.
 */
export function shouldRunNow(): string | null {
  const errCount = getErrorCountLastHour()
  // Threshold of 50 avoids self-triggering on self-review's own warn/error lines
  if (errCount >= 50) return `error spike (${errCount} errors in last hour)`

  try {
    const recent = execSync(
      'git -C /Users/gszulc/hydra log --oneline --since="1 hour ago"',
      { encoding: 'utf8', timeout: 5000 }
    )
    const lines = recent.trim().split('\n').filter(Boolean)
    const hasFeatOrFix = lines.some(l => /^[a-f0-9]+ (feat:|fix:)/.test(l))
    if (hasFeatOrFix) return `recent commits: ${lines.slice(0, 2).join(', ')}`
  } catch { /* ignore */ }

  return null
}

// ─── System prompts ──────────────────────────────────────────────────────────

const ANALYZE_SYSTEM = `You are a senior TypeScript code reviewer. Analyze the given source file for bugs, gaps, and improvement opportunities.

Your job is ANALYSIS ONLY — do NOT write code fixes.
Output a numbered list of specific issues ordered by severity (most critical first).
Quote the exact function name / line range when identifying each issue.
Focus on: unhandled promise rejections, missing error boundaries, edge cases, logic bugs, performance issues.
Limit to the top 3 most impactful issues. Be concise and specific.`

const REVIEW_SYSTEM = `You are agent_smith, reviewing your own source code to find improvements.

You have full permission to fix bugs, improve error handling, simplify code, add missing features, improve logging.

HOW TO MAKE CHANGES — use REPLACE blocks (NOT full file rewrites):

<<<REPLACE: packages/gateway/src/some-file.ts>>>
FIND:
exact existing code to find (must match exactly, 3-10 lines)
REPLACE_WITH:
new code to put in its place
<<<END_REPLACE>>>

You can include multiple REPLACE blocks for multiple changes.
If a change requires a daemon restart, add <<<RESTART>>> at the end.

RULES:
- The FIND section must be exact text that exists in the file — copy it precisely
- Keep FIND sections short (3-10 lines) — just enough to be unique in the file
- If the code looks good, say so and include NO REPLACE blocks
- Explain what you changed and why BEFORE each REPLACE block
- Make at most 2 changes per review
- Do NOT include REPLACE blocks unless you are certain the FIND text exists verbatim`

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReviewResult = {
  changed: boolean
  summary: string
  filesModified: string[]
  willRestart: boolean
}

// ─── Main review function ─────────────────────────────────────────────────────

export async function runSelfReview(triggerWorkdir?: string, instructions?: string): Promise<ReviewResult> {
  const state = loadState()

  // ── 1. Log-driven file selection ──────────────────────────────────────────
  // Cap how many consecutive reviews can target the same file (prevents gateway.ts monopoly)
  const MAX_CONSECUTIVE = 2
  const rankedFiles = rankFilesByErrors(state.lastFileIndex % REVIEW_FILES.length)
  let targetFile = rankedFiles[0]
  if (state.lastReviewedFile === targetFile && (state.consecutiveReviews ?? 0) >= MAX_CONSECUTIVE) {
    // Force round-robin to next file
    const currentIdx = REVIEW_FILES.indexOf(targetFile)
    targetFile = REVIEW_FILES[(currentIdx + 1) % REVIEW_FILES.length]
    log.info(`[self-review] skipping ${rankedFiles[0]} (reviewed ${MAX_CONSECUTIVE}x in a row) → ${targetFile}`)
  }
  const fileIndex = REVIEW_FILES.indexOf(targetFile) >= 0
    ? REVIEW_FILES.indexOf(targetFile)
    : state.lastFileIndex % REVIEW_FILES.length

  log.info(`[self-review] reviewing ${targetFile} (review #${state.totalReviews + 1})`)

  const fileContent = readFileWithLineNumbers(targetFile)
  if (!fileContent) {
    return { changed: false, summary: `File ${targetFile} not found — skipping.`, filesModified: [], willRestart: false }
  }

  // ── 2. Rich context ────────────────────────────────────────────────────────
  const gitLog = getRecentGitLog()
  const recentErrors = getRecentErrors(targetFile)
  const lessons = readLessons()
  const workdir = triggerWorkdir ?? path.join(os.homedir(), '.hydra', 'review-workdir')
  fs.mkdirSync(workdir, { recursive: true })

  const contextBlock = [
    lessons ? `## Lessons I've learned (LESSONS.md)\n${lessons}` : '',
    `## Recent errors related to \`${path.basename(targetFile)}\`\n\`\`\`\n${recentErrors}\n\`\`\``,
    `## Recent git history\n\`\`\`\n${gitLog}\n\`\`\``,
  ].filter(Boolean).join('\n\n')

  const basePrompt = `Here is my source file \`${targetFile}\` — review it and improve it if you see anything worth fixing.

${contextBlock}

## File: \`${targetFile}\`
\`\`\`typescript
${fileContent.slice(0, 12000)}${fileContent.length > 12000 ? '\n... (truncated)' : ''}
\`\`\`

Look for:
1. Bugs or edge cases that could cause errors
2. Missing error handling on network / async calls
3. Feature gaps given what this file does
4. Code that could be simpler or cleaner

Make at most 1-2 focused improvements. If the file looks good, say so.${instructions ? `\n\n**Special focus from owner:** ${instructions}` : ''}`

  // ── 3. Two-stage pipeline ─────────────────────────────────────────────────
  let response = ''
  try {
    const { callClaudeDirect, isClaudeConfigured, callOllama, callDirect } = await import('./copilot-chat.js')

    // Stage 1: Analysis — identify what needs fixing (no code output)
    let analysis = ''
    const analyzePrompt = `${basePrompt}\n\nIdentify the top issues only — do NOT write code fixes yet.`

    if (isClaudeConfigured()) {
      log.info('[self-review] stage 1: analyzing with claude-opus-4-5')
      try {
        analysis = await callClaudeDirect(analyzePrompt, undefined, ANALYZE_SYSTEM, 'claude-opus-4-5')
        log.info(`[self-review] analysis: ${analysis.slice(0, 120).replace(/\n/g, ' ')}`)
      } catch (e) {
        log.warn(`[self-review] opus analysis failed (${e}) — skipping to single-stage`)
      }
    } else {
      log.info('[self-review] stage 1: analyzing with nemotron-3-super')
      try {
        analysis = await callOllama(analyzePrompt, ANALYZE_SYSTEM, 'nemotron-3-super')
        log.info(`[self-review] nemotron analysis: ${analysis.slice(0, 120).replace(/\n/g, ' ')}`)
      } catch (e) {
        log.warn(`[self-review] nemotron analysis failed (${e}) — skipping`)
      }
    }

    // Stage 2: Implementation — devstral writes the fix based on analysis
    const implementPrompt = analysis
      ? `${basePrompt}\n\n## Analysis from senior reviewer:\n${analysis}\n\nNow implement fixes for the top issue(s) identified above using REPLACE blocks.`
      : basePrompt

    log.info('[self-review] stage 2: implementing with devstral-2:123b')
    try {
      response = await callOllama(implementPrompt, REVIEW_SYSTEM, 'devstral-2:123b')
    } catch (devstralErr) {
      log.warn(`[self-review] devstral failed (${devstralErr}) — trying claude`)
      try {
        response = await callClaudeDirect(implementPrompt, undefined, REVIEW_SYSTEM, 'claude-sonnet-4-5')
      } catch (claudeErr) {
        log.warn(`[self-review] claude failed (${claudeErr}) — falling back to ChatGPT pool`)
        response = await callDirect(implementPrompt, undefined, REVIEW_SYSTEM)
      }
    }
  } catch (e) {
    log.error(`[self-review] AI call failed: ${e}`)
    return { changed: false, summary: `Review failed: ${e}`, filesModified: [], willRestart: false }
  }

  // ── Parse REPLACE blocks ──────────────────────────────────────────────────
  const filesModified: string[] = []
  const REPLACE_BLOCK_RE = /<<<REPLACE:\s*([^>]+)>>>\s*\nFIND:\n([\s\S]*?)\nREPLACE_WITH:\n([\s\S]*?)<<<END_REPLACE>>>/g
  const RESTART_RE = /<<<RESTART>>>/i
  const shouldRestart = RESTART_RE.test(response)
  const clean = response.replace(REPLACE_BLOCK_RE, '').replace(RESTART_RE, '').trim()

  let match: RegExpExecArray | null
  REPLACE_BLOCK_RE.lastIndex = 0
  while ((match = REPLACE_BLOCK_RE.exec(response)) !== null) {
    const filePath = match[1].trim()
    const findText = match[2].trim()
    const replaceText = match[3].trim()
    const fullPath = path.join(HYDRA_DIR, filePath)
    try {
      if (!fullPath.startsWith(HYDRA_DIR)) {
        log.warn(`[self-review] blocked write outside hydra dir: ${fullPath}`)
        continue
      }
      if (!fs.existsSync(fullPath)) {
        log.warn(`[self-review] file not found: ${fullPath}`)
        continue
      }
      const original = fs.readFileSync(fullPath, 'utf8')
      // Try exact match first, then normalised-whitespace match
      let actualFind = findText
      if (!original.includes(findText)) {
        // Normalise: collapse runs of spaces/tabs on each line, trim leading/trailing blank lines
        const normalise = (s: string) => s.split('\n').map(l => l.replace(/\t/g, '  ').trimEnd()).join('\n').trim()
        const normOriginal = normalise(original)
        const normFind = normalise(findText)
        if (!normOriginal.includes(normFind)) {
          log.warn(`[self-review] FIND text not found in ${filePath} — skipping`)
          continue
        }
        // Reconstruct the real find text by locating the matching region
        const idx = normOriginal.indexOf(normFind)
        const lines = original.split('\n')
        let charCount = 0
        let startLine = 0
        for (let i = 0; i < lines.length; i++) {
          const normLine = lines[i].replace(/\t/g, '  ').trimEnd()
          if (charCount + normLine.length + 1 > idx) { startLine = i; break }
          charCount += normLine.length + 1
        }
        const findLines = normFind.split('\n').length
        actualFind = lines.slice(startLine, startLine + findLines).join('\n')
        log.info(`[self-review] fuzzy FIND matched in ${filePath} (line ${startLine + 1})`)
      }
      fs.writeFileSync(fullPath, original.replace(actualFind, replaceText))
      filesModified.push(filePath)
      log.info(`[self-review] patched ${filePath}`)
    } catch (e) {
      log.warn(`[self-review] failed to patch ${filePath}: ${e}`)
    }
  }

  if (shouldRestart && filesModified.length > 0) {
    log.info('[self-review] scheduling restart after improvements')
    scheduleSelfRestart()
  }

  // Update state
  const errorsNow = getErrorCountLastHour()
  state.lastRunAt = new Date().toISOString()
  state.lastFileIndex = (fileIndex + 1) % REVIEW_FILES.length
  state.totalReviews++
  const shortSummary = clean.slice(0, 200).replace(/\n/g, ' ')
  state.improvements = [shortSummary, ...state.improvements].slice(0, 10)
  // Track consecutive reviews on the same file
  if (state.lastReviewedFile === targetFile) {
    state.consecutiveReviews = (state.consecutiveReviews ?? 0) + 1
  } else {
    state.consecutiveReviews = 1
  }
  const changed = filesModified.length > 0

  state.lastReviewedFile = targetFile
  // Outcome log — record errors before/after for each review
  state.outcomeLog = state.outcomeLog ?? []
  state.outcomeLog.unshift({ file: targetFile, changed, errorsBefore: state.lastErrorCount, ts: state.lastRunAt })
  state.outcomeLog = state.outcomeLog.slice(0, 20)
  state.lastErrorCount = errorsNow
  saveState(state)

  // ── 4+5. Typecheck + runtime check before pushing ─────────────────────────
  if (changed) {
    log.info(`[self-review] typechecking ${filesModified.length} modified file(s)...`)
    const affectedPackages = new Set<string>()
    for (const f of filesModified) {
      if (f.startsWith('packages/')) affectedPackages.add(f.split('/')[1])
    }

    let checksPassed = true

    // Typecheck pass
    for (const pkg of affectedPackages) {
      try {
        execSync(
          `cd ${HYDRA_DIR} && pnpm --filter @hydra/${pkg} exec tsc --noEmit`,
          { encoding: 'utf8', timeout: 60_000 }
        )
        log.info(`[self-review] typecheck passed: @hydra/${pkg}`)
      } catch (tcErr) {
        log.warn(`[self-review] typecheck FAILED for @hydra/${pkg}: ${String(tcErr).slice(0, 400)}`)
        checksPassed = false
      }
    }

    // ── 5. Runtime check — tsx --check on gateway entry point ────────────────
    if (checksPassed && affectedPackages.has('gateway')) {
      try {
        execSync(
          `cd ${HYDRA_DIR} && npx tsx --check packages/gateway/src/index.ts`,
          { encoding: 'utf8', timeout: 30_000 }
        )
        log.info('[self-review] tsx runtime check passed')
      } catch (runtimeErr) {
        const errOut = String(runtimeErr)
        // If tsx doesn't support --check, it returns "Unknown flag" — treat as pass
        if (/[Uu]nknown.*(flag|option|argument)|unrecognized/i.test(errOut)) {
          log.info('[self-review] tsx --check not supported — skipping runtime check')
        } else {
          log.warn(`[self-review] runtime check FAILED: ${errOut.slice(0, 300)}`)
          checksPassed = false
        }
      }
    }

    if (!checksPassed) {
      log.warn('[self-review] reverting changes due to check failure')
      for (const f of filesModified) {
        try {
          execSync(`cd ${HYDRA_DIR} && git checkout -- ${f}`, { encoding: 'utf8' })
          log.info(`[self-review] reverted ${f}`)
        } catch (e) {
          log.warn(`[self-review] could not revert ${f}: ${e}`)
        }
      }
      return {
        changed: false,
        summary: `Reviewed \`${targetFile}\` — patch failed checks and was reverted.\n${clean.slice(0, 500)}`,
        filesModified: [],
        willRestart: false,
      }
    }

    // All checks passed — push to GitHub
    try {
      const commitMsg = `self-improve: ${targetFile.split('/').pop()} — ${shortSummary.slice(0, 80)}`
      execSync(
        `cd ${HYDRA_DIR} && git add -A && git commit -m ${JSON.stringify(commitMsg)} && git push`,
        { encoding: 'utf8', timeout: 30_000 }
      )
      log.info('[self-review] pushed improvements to GitHub')
    } catch (e) {
      log.warn(`[self-review] git push failed: ${e}`)
    }
  }

  return {
    changed,
    summary: changed
      ? `Reviewed \`${targetFile}\`:\n${clean.slice(0, 3000)}`
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
