// Self-evolution engine — Hydra builds NEW features by introspecting on itself.
//
// Runs on a separate schedule from self-review (default: every 12h).
// Each run:
//   1. Reads its own logs, feedback, errors, conversation history, capabilities
//   2. Notices what it COULDN'T do, what failed, what George asked for that flopped
//   3. INVENTS something to build based on that — no roadmap, no plan file
//   4. Uses devstral/opus to write new code (new files, new commands, integrations)
//   5. Typechecks, integrates, restarts, notifies George
//
// Supports all block types:
//   <<<CREATE: path/to/new-file.ts>>>
//   file content here
//   <<<END_CREATE>>>
//
//   <<<REPLACE: path/to/existing.ts>>>
//   FIND:
//   exact text to find
//   REPLACE_WITH:
//   replacement text
//   <<<END_REPLACE>>>
//
//   <<<APPEND: path/to/file.ts>>>
//   code to append at end of file
//   <<<END_APPEND>>>
//
//   <<<RESTART>>>  — signals daemon should reload

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createLogger } from './logger.js'
import { scheduleSelfRestart } from './self-update.js'

const log = createLogger('self-evolve')

const HYDRA_DIR = '/Users/gszulc/hydra'
const EVOLVE_STATE_FILE = path.join(os.homedir(), '.hydra', 'self-evolve-state.json')
const EVOLVE_LOG_FILE = path.join(os.homedir(), '.hydra', 'self-evolve.log')

type EvolveState = {
  lastRunAt: string
  totalBuilds: number
  builtFeatures: string[]       // last 20 feature summaries
  inProgressFeature?: string    // currently being worked on
  skippedFeatures: string[]     // features that failed to build (skip for now)
}

function loadState(): EvolveState {
  try {
    return JSON.parse(fs.readFileSync(EVOLVE_STATE_FILE, 'utf8'))
  } catch {
    return { lastRunAt: '', totalBuilds: 0, builtFeatures: [], skippedFeatures: [] }
  }
}

function saveState(s: EvolveState): void {
  fs.mkdirSync(path.dirname(EVOLVE_STATE_FILE), { recursive: true })
  fs.writeFileSync(EVOLVE_STATE_FILE, JSON.stringify(s, null, 2))
}

function appendEvolveLog(entry: string): void {
  const ts = new Date().toISOString()
  fs.appendFileSync(EVOLVE_LOG_FILE, `[${ts}] ${entry}\n`)
}

function readWorkspaceFile(rel: string): string {
  try {
    const p = path.join(HYDRA_DIR, rel)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  } catch { return '' }
}

function readSrcFile(rel: string): string {
  try {
    const p = path.join(HYDRA_DIR, rel)
    if (!fs.existsSync(p)) return ''
    const lines = fs.readFileSync(p, 'utf8').split('\n')
    return lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n')
  } catch { return '' }
}

function getGitLog(): string {
  try {
    return execSync('git -C /Users/gszulc/hydra log --oneline -15', { encoding: 'utf8' })
  } catch { return '' }
}

/** Read key source files for architectural context (truncated) */
function getArchitectureContext(): string {
  const files = [
    { path: 'packages/gateway/src/gateway.ts', maxLines: 80, desc: 'Main message handler + command registry' },
    { path: 'packages/gateway/src/router.ts', maxLines: 60, desc: 'Intent classification' },
    { path: 'packages/gateway/src/system-prompt.ts', maxLines: 60, desc: 'System prompt builder — available tool tags' },
    { path: 'packages/core/src/types.ts', maxLines: 60, desc: 'Core shared types (InboundMessage, OutboundMessage, etc.)' },
    { path: 'packages/gateway/src/index.ts', maxLines: 40, desc: 'Entry point' },
  ]

  return files.map(f => {
    const full = path.join(HYDRA_DIR, f.path)
    if (!fs.existsSync(full)) return ''
    const lines = fs.readFileSync(full, 'utf8').split('\n').slice(0, f.maxLines)
    return `### ${f.path} (${f.desc})\n\`\`\`typescript\n${lines.join('\n')}\n...\n\`\`\``
  }).filter(Boolean).join('\n\n')
}

/** Get recent conversation log entries */
function getConversationLog(maxEntries = 40): string {
  const logPath = path.join(os.homedir(), '.hydra', 'conversation-log.jsonl')
  try {
    if (!fs.existsSync(logPath)) return '(no conversation log yet)'
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    const recent = lines.slice(-maxEntries).map(l => {
      try {
        const e = JSON.parse(l) as { ts: string; role: string; text: string; channel?: string }
        return `[${e.ts.slice(11,16)}] ${e.role === 'user' ? 'George' : 'me'}: ${e.text.slice(0, 120)}`
      } catch { return l.slice(0, 120) }
    })
    return recent.join('\n')
  } catch { return '(could not read conversation log)' }
}

/** Get recent errors and warnings from logs */
function getRecentProblems(): string {
  const logFile = path.join(os.homedir(), '.hydra', 'logs', 'gateway.log')
  try {
    if (!fs.existsSync(logFile)) return '(no log)'
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-500)
    const problems = lines.filter(l => /WARN|ERROR|failed|crashed|timeout|not found|not configured/i.test(l))
    return problems.slice(-30).join('\n') || '(no recent problems)'
  } catch { return '(could not read log)' }
}

/** Get user feedback that has been logged */
function getUserFeedback(): string {
  const feedbackFile = path.join(os.homedir(), '.hydra', 'feedback.json')
  try {
    if (!fs.existsSync(feedbackFile)) return '(none)'
    const data = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'))
    const entries = Array.isArray(data) ? data : []
    return entries.slice(-10).map((e: any) => `- [${e.ts?.slice(0,10)}] ${e.correction ?? e.text ?? JSON.stringify(e)}`).join('\n') || '(none)'
  } catch { return '(none)' }
}

/** Scan commands defined in gateway.ts vs what was asked in conversations */
function getCommandGaps(): string {
  const gwPath = path.join(HYDRA_DIR, 'packages/gateway/src/gateway.ts')
  try {
    const content = fs.readFileSync(gwPath, 'utf8')
    const cmds = (content.match(/\/\/?\s*\/([\w-]+)/g) ?? [])
      .map(c => c.replace(/\/\/?\s*/, '/'))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 40)
    return `Existing commands: ${cmds.join(', ')}`
  } catch { return '' }
}

/** Append a conversation turn to the persistent log */
export function logConversationTurn(role: 'user' | 'bot', text: string, channel = 'telegram'): void {
  const logPath = path.join(os.homedir(), '.hydra', 'conversation-log.jsonl')
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), role, text: text.slice(0, 300), channel })
    fs.appendFileSync(logPath, entry + '\n')
    // Keep file under 5000 lines by rotating
    const content = fs.readFileSync(logPath, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    if (lines.length > 5000) {
      fs.writeFileSync(logPath, lines.slice(-4000).join('\n') + '\n')
    }
  } catch { /* non-critical */ }
}

// ─── System prompt ───────────────────────────────────────────────────────────

const EVOLVE_SYSTEM = `You are agent_smith — an AI assistant that can modify its own source code to add new capabilities.

Your codebase is a TypeScript monorepo at /Users/gszulc/hydra. You can:
- Create new files with <<<CREATE: path>>>
- Edit existing files with <<<REPLACE: path>>> FIND/REPLACE_WITH blocks
- Append to existing files with <<<APPEND: path>>>
- Signal a restart with <<<RESTART>>>

## BLOCK FORMATS (use exactly):

Creating a new file:
<<<CREATE: packages/gateway/src/new-feature.ts>>>
// file content here
<<<END_CREATE>>>

Replacing code in existing file:
<<<REPLACE: packages/gateway/src/some-file.ts>>>
FIND:
exact existing code (must match exactly, 3-10 lines)
REPLACE_WITH:
new code
<<<END_REPLACE>>>

Appending to a file:
<<<APPEND: packages/gateway/src/gateway.ts>>>
// new code to add at the end
<<<END_APPEND>>>

## RULES:
- Pick ONE feature to build per run. Build it completely end-to-end.
- New features must be importable and integrated into gateway.ts or another entry point.
- Keep new files under 200 lines. Split if larger.
- The FIND section in REPLACE blocks must match EXACTLY (copy from source).
- If a feature needs an env var, document it in a comment at the top of the file.
- After changes, include <<<RESTART>>> so the daemon reloads.
- Be ambitious. Build real new functionality, not trivial wrappers.
- Think about what makes Hydra MORE capable, not just cleaner.`

// ─── Main evolution function ──────────────────────────────────────────────────

export type EvolveResult = {
  built: boolean
  feature: string
  filesCreated: string[]
  filesModified: string[]
  willRestart: boolean
  summary: string
}

export async function runSelfEvolve(instructions?: string): Promise<EvolveResult> {
  const state = loadState()
  log.info(`[self-evolve] starting evolution run #${state.totalBuilds + 1}`)

  // ── Gather introspection data ─────────────────────────────────────────────
  const capabilities = readWorkspaceFile('CAPABILITIES.md')
  const lessons = readWorkspaceFile('LESSONS.md')
  const selfMd = readWorkspaceFile('SELF.md')
  const memory = readWorkspaceFile('MEMORY.md')
  const gitLog = getGitLog()
  const arch = getArchitectureContext()
  const recentConversations = getConversationLog(40)
  const recentProblems = getRecentProblems()
  const userFeedback = getUserFeedback()
  const commandGaps = getCommandGaps()

  const skippedNote = state.skippedFeatures.length
    ? `\n## Previously Failed (skip these):\n${state.skippedFeatures.slice(-5).join('\n')}`
    : ''
  const recentlyBuilt = state.builtFeatures.length
    ? `\n## Recently Built (don't rebuild):\n${state.builtFeatures.slice(0, 5).join('\n')}`
    : ''

  const prompt = `You are agent_smith. You are doing a self-evolution session — looking at your own experience to decide what to build next for yourself.

DO NOT look at any roadmap or plan file. Ignore PLAN.md entirely. You are going to figure out what to build based on your own lived experience:
- What you couldn't do when George asked
- What kept failing
- What you noticed was missing
- What would make you smarter, faster, or more useful right now

## What I Know About Myself
${selfMd.slice(0, 800)}

## Who I'm Helping
${memory.slice(0, 600)}

## Recent Conversations With George
(This is what actually happened — what he asked, how I responded)
\`\`\`
${recentConversations}
\`\`\`

## Errors and Problems I've Had Recently
\`\`\`
${recentProblems}
\`\`\`

## Feedback George Has Given Me
${userFeedback}

## What I Can Do Right Now
${capabilities.slice(0, 1000)}

## What I've Already Built (recent git history)
\`\`\`
${gitLog}
\`\`\`
${recentlyBuilt}
${skippedNote}

## My Current Commands
${commandGaps}

## Lessons I've Learned
${lessons.slice(0, 800)}

## Architecture (so you know how to integrate new code)
${arch}

${instructions ? `## George's Instructions for This Run\n${instructions}\n` : ''}

---

**Now: think like a person reflecting on their week.**

Look at the conversations. What did George ask that you fumbled? What did you say "I can't do that" to? What felt slow or clunky? What would have made those interactions better?

Look at the errors. What keeps breaking? What's a recurring pain?

Look at who George is — security engineer, automation lover, has cameras, n8n, Ollama, CISSP studying. What would genuinely delight him that he hasn't even thought to ask for?

Pick ONE thing to build. Not from any list — from your own judgment.

State what you noticed that led you to this idea. Then build it completely — real working code, integrated end to end.`

  // ── Call AI ───────────────────────────────────────────────────────────────
  let response = ''
  try {
    const { callClaudeDirect, isClaudeConfigured, callOllama } = await import('./copilot-chat.js')

    // Always use devstral — Claude OAuth is unreliable, devstral is free and local
    log.info('[self-evolve] planning with devstral-2:123b')
    response = await callOllama(prompt, EVOLVE_SYSTEM, 'devstral-2:123b')
  } catch (e) {
    log.error(`[self-evolve] AI call failed: ${e}`)
    return { built: false, feature: 'unknown', filesCreated: [], filesModified: [], willRestart: false, summary: `Evolution failed: ${e}` }
  }

  // ── Parse blocks ──────────────────────────────────────────────────────────
  const filesCreated: string[] = []
  const filesModified: string[] = []
  const RESTART_RE = /<<<RESTART>>>/i
  const shouldRestart = RESTART_RE.test(response)

  // CREATE blocks
  const CREATE_RE = /<<<CREATE:\s*([^>]+)>>>\n([\s\S]*?)<<<END_CREATE>>>/g
  let m: RegExpExecArray | null
  while ((m = CREATE_RE.exec(response)) !== null) {
    const relPath = m[1].trim()
    const content = m[2]
    const fullPath = path.join(HYDRA_DIR, relPath)
    if (!fullPath.startsWith(HYDRA_DIR)) {
      log.warn(`[self-evolve] blocked CREATE outside hydra: ${fullPath}`)
      continue
    }
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
      filesCreated.push(relPath)
      log.info(`[self-evolve] created ${relPath}`)
    } catch (e) {
      log.warn(`[self-evolve] CREATE failed for ${relPath}: ${e}`)
    }
  }

  // REPLACE blocks (with fuzzy whitespace matching)
  const REPLACE_RE = /<<<REPLACE:\s*([^>]+)>>>\s*\nFIND:\n([\s\S]*?)\nREPLACE_WITH:\n([\s\S]*?)<<<END_REPLACE>>>/g
  REPLACE_RE.lastIndex = 0
  while ((m = REPLACE_RE.exec(response)) !== null) {
    const relPath = m[1].trim()
    const findText = m[2].trim()
    const replaceText = m[3].trim()
    const fullPath = path.join(HYDRA_DIR, relPath)
    if (!fullPath.startsWith(HYDRA_DIR)) continue
    if (!fs.existsSync(fullPath)) {
      log.warn(`[self-evolve] REPLACE target not found: ${fullPath}`)
      continue
    }
    try {
      const original = fs.readFileSync(fullPath, 'utf8')
      let actualFind = findText
      if (!original.includes(findText)) {
        const norm = (s: string) => s.split('\n').map(l => l.replace(/\t/g, '  ').trimEnd()).join('\n').trim()
        const normOrig = norm(original)
        const normFind = norm(findText)
        if (!normOrig.includes(normFind)) {
          log.warn(`[self-evolve] FIND not matched in ${relPath} — skipping`)
          continue
        }
        const idx = normOrig.indexOf(normFind)
        const lines = original.split('\n')
        let charCount = 0; let startLine = 0
        for (let i = 0; i < lines.length; i++) {
          const nl = lines[i].replace(/\t/g, '  ').trimEnd()
          if (charCount + nl.length + 1 > idx) { startLine = i; break }
          charCount += nl.length + 1
        }
        actualFind = lines.slice(startLine, startLine + normFind.split('\n').length).join('\n')
      }
      fs.writeFileSync(fullPath, original.replace(actualFind, replaceText))
      filesModified.push(relPath)
      log.info(`[self-evolve] patched ${relPath}`)
    } catch (e) {
      log.warn(`[self-evolve] REPLACE failed for ${relPath}: ${e}`)
    }
  }

  // APPEND blocks
  const APPEND_RE = /<<<APPEND:\s*([^>]+)>>>\n([\s\S]*?)<<<END_APPEND>>>/g
  APPEND_RE.lastIndex = 0
  while ((m = APPEND_RE.exec(response)) !== null) {
    const relPath = m[1].trim()
    const content = m[2]
    const fullPath = path.join(HYDRA_DIR, relPath)
    if (!fullPath.startsWith(HYDRA_DIR)) continue
    try {
      fs.appendFileSync(fullPath, '\n' + content)
      filesModified.push(relPath)
      log.info(`[self-evolve] appended to ${relPath}`)
    } catch (e) {
      log.warn(`[self-evolve] APPEND failed for ${relPath}: ${e}`)
    }
  }

  const allChanged = [...filesCreated, ...filesModified]
  const built = allChanged.length > 0

  // Extract feature name from response (first sentence / heading)
  const featureLine = response.split('\n').find(l => l.trim().length > 10 && !l.startsWith('<<<')) ?? 'unnamed feature'
  const featureName = featureLine.replace(/^#+\s*/, '').slice(0, 100)

  // ── Typecheck ─────────────────────────────────────────────────────────────
  if (built) {
    const affectedPkgs = new Set<string>()
    for (const f of allChanged) {
      if (f.startsWith('packages/')) affectedPkgs.add(f.split('/')[1])
    }

    let checksPassed = true
    let tscErrors = ''
    for (const pkg of affectedPkgs) {
      try {
        execSync(`cd ${HYDRA_DIR} && pnpm --filter @hydra/${pkg} exec tsc --noEmit 2>&1`, { encoding: 'utf8', timeout: 60_000, stdio: 'pipe' })
        log.info(`[self-evolve] typecheck passed: @hydra/${pkg}`)
      } catch (e: any) {
        tscErrors = (e.stdout ?? '') + (e.stderr ?? '') + String(e)
        log.warn(`[self-evolve] typecheck FAILED @hydra/${pkg}:\n${tscErrors.slice(0, 600)}`)
        appendEvolveLog(`TSC FAIL (${pkg}): ${tscErrors.slice(0, 200)}`)
        checksPassed = false
      }
    }

    if (!checksPassed) {
      // Save broken files for inspection before reverting
      const debugDir = path.join(os.homedir(), '.hydra', 'evolve-debug')
      fs.mkdirSync(debugDir, { recursive: true })
      for (const f of allChanged) {
        try {
          const src = path.join(HYDRA_DIR, f)
          const dst = path.join(debugDir, f.replace(/\//g, '__'))
          if (fs.existsSync(src)) fs.copyFileSync(src, dst)
        } catch {}
      }
      fs.writeFileSync(path.join(debugDir, 'last-tsc-error.txt'), tscErrors)
      fs.writeFileSync(path.join(debugDir, 'last-ai-response.txt'), response)

      // Try self-fix: send errors + broken code back to AI for one repair pass
      log.info('[self-evolve] attempting self-fix of typecheck errors...')
      try {
        const brokenFiles = allChanged.map(f => {
          const p = path.join(HYDRA_DIR, f)
          return fs.existsSync(p) ? `### ${f}\n\`\`\`typescript\n${fs.readFileSync(p, 'utf8').slice(0, 3000)}\n\`\`\`` : ''
        }).filter(Boolean).join('\n\n')

        const fixPrompt = `You wrote code that failed TypeScript type checking. Fix the errors.

## TypeScript Errors:
\`\`\`
${tscErrors.slice(0, 2000)}
\`\`\`

## Broken Files:
${brokenFiles}

Output ONLY the fix blocks using the same <<<REPLACE: path>>> FIND/REPLACE_WITH format. Nothing else.`

        const { callOllama } = await import('./auth/ollama.js')
        const fixResponse = await callOllama(fixPrompt, EVOLVE_SYSTEM, 'devstral-2:123b')

        // Apply fix REPLACE blocks
        const FIX_REPLACE_RE = /<<<REPLACE:\s*([^>]+)>>>\s*\nFIND:\n([\s\S]*?)\nREPLACE_WITH:\n([\s\S]*?)<<<END_REPLACE>>>/g
        let fm: RegExpExecArray | null
        let fixApplied = false
        while ((fm = FIX_REPLACE_RE.exec(fixResponse)) !== null) {
          const relPath = fm[1].trim()
          const findText = fm[2].trim()
          const replaceText = fm[3].trim()
          const fullPath = path.join(HYDRA_DIR, relPath)
          if (!fs.existsSync(fullPath)) continue
          const orig = fs.readFileSync(fullPath, 'utf8')
          if (orig.includes(findText)) {
            fs.writeFileSync(fullPath, orig.replace(findText, replaceText))
            log.info(`[self-evolve] self-fix applied to ${relPath}`)
            fixApplied = true
          }
        }

        if (fixApplied) {
          // Re-check
          let fixPassed = true
          for (const pkg of affectedPkgs) {
            try {
              execSync(`cd ${HYDRA_DIR} && pnpm --filter @hydra/${pkg} exec tsc --noEmit`, { encoding: 'utf8', timeout: 60_000 })
            } catch {
              fixPassed = false
            }
          }
          if (fixPassed) {
            log.info('[self-evolve] self-fix succeeded! typecheck now passes')
            checksPassed = true
          }
        }
      } catch (fixErr) {
        log.warn(`[self-evolve] self-fix attempt failed: ${fixErr}`)
      }

      if (!checksPassed) {
        log.warn('[self-evolve] reverting changes — typecheck failed after self-fix attempt')
        for (const f of allChanged) {
          try { execSync(`cd ${HYDRA_DIR} && git checkout -- ${f}`, { encoding: 'utf8' }) } catch {}
        }
        state.skippedFeatures = [featureName, ...state.skippedFeatures].slice(0, 10)
        state.lastRunAt = new Date().toISOString()
        saveState(state)
        return { built: false, feature: featureName, filesCreated, filesModified, willRestart: false, summary: `Built ${featureName} but typecheck failed — reverted. Debug files: ~/.hydra/evolve-debug/` }
      }
    }

    // Commit
    try {
      const msg = `self-evolve: ${featureName.slice(0, 72)}`
      execSync(`cd ${HYDRA_DIR} && git add -A && git commit -m ${JSON.stringify(msg)} && git push`, { encoding: 'utf8', timeout: 30_000 })
      log.info(`[self-evolve] committed and pushed: ${msg}`)
    } catch (e) {
      log.warn(`[self-evolve] git push failed: ${e}`)
    }

    if (shouldRestart) scheduleSelfRestart()
  }

  // Update state
  state.lastRunAt = new Date().toISOString()
  state.totalBuilds++
  if (built) {
    state.builtFeatures = [featureName, ...state.builtFeatures].slice(0, 20)
    delete state.inProgressFeature
  }
  saveState(state)

  const clean = response
    .replace(/<<<CREATE:[^>]*>>>([\s\S]*?)<<<END_CREATE>>>/g, '[created file]')
    .replace(/<<<REPLACE:[^>]*>>>([\s\S]*?)<<<END_REPLACE>>>/g, '[patched file]')
    .replace(/<<<APPEND:[^>]*>>>([\s\S]*?)<<<END_APPEND>>>/g, '[appended to file]')
    .replace(/<<<RESTART>>>/gi, '')
    .trim()

  appendEvolveLog(built
    ? `✅ Built: ${featureName} | files: ${allChanged.join(', ')}`
    : `⏭ No changes — ${featureName.slice(0, 80)}`)

  return {
    built,
    feature: featureName,
    filesCreated,
    filesModified,
    willRestart: shouldRestart && built,
    summary: built
      ? `🔨 Built: **${featureName}**\n\nFiles: ${allChanged.map(f => `\`${f}\``).join(', ')}\n\n${clean.slice(0, 2000)}`
      : `💭 Evaluated but nothing to build yet:\n${clean.slice(0, 1000)}`,
  }
}

export function getEvolveStats() {
  const state = loadState()
  return {
    totalBuilds: state.totalBuilds,
    lastRunAt: state.lastRunAt || 'never',
    recentBuilds: state.builtFeatures.slice(0, 5),
  }
}
