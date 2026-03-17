// Multi-agent collaboration pipeline.
// Agents review each other's work before the final response is sent.
//
// Pipeline (auto-triggered for complex responses):
//   Generator  → draft response
//   Critic     → reviews draft, identifies issues
//   Reviser    → improves draft based on critique (if needed)
//
// Also provides:
//   runConsult(model, question) — one agent asks another a specific question
//   [CONSULT: model: question]  — inline tag the generator can use mid-response

import { createLogger } from './logger.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const log = createLogger('multi-agent')

const COLLAB_LOG = path.join(os.homedir(), '.hydra', 'multi-agent-log.jsonl')

export type AgentRole = 'generator' | 'critic' | 'reviser' | 'consultant'

export type AgentTurn = {
  role: AgentRole
  model: string
  input: string
  output: string
  durationMs: number
}

export type CollabResult = {
  finalResponse: string
  revised: boolean
  turns: AgentTurn[]
  critique?: string
}

const CRITIC_SYSTEM = `You are a strict quality reviewer for an AI assistant named agent_smith.

Your job: identify flaws in a draft response. Be brief and specific.

Check for:
- Factual errors or unsupported claims
- Missing important context the user likely needs
- Logic gaps or contradictions
- For code: bugs, missing error handling, security issues, wrong approach

Output format — pick ONE:
1. "LGTM" — if the draft is good as-is (nothing significant to fix)
2. A numbered list of issues (max 3, each one sentence)

Do NOT rewrite the response. ONLY identify issues.`

const REVISER_SYSTEM = `You are agent_smith, revising your own previous response based on peer review.

Rules:
- Keep everything that was correct and useful
- Fix only the specific issues the critic identified
- Do not change the format or add padding
- Be direct and concise
- Output only the final revised response — no meta-commentary`

function logTurn(turn: AgentTurn): void {
  try {
    fs.appendFileSync(COLLAB_LOG, JSON.stringify({ ...turn, ts: new Date().toISOString() }) + '\n')
  } catch { /* ignore */ }
}

/**
 * One agent asks another model a specific question and returns its answer.
 * Used for [CONSULT: model: question] tag handling.
 */
export async function runConsult(model: string, question: string): Promise<string> {
  const { callOllama, callDirect } = await import('./copilot-chat.js')
  const { MODEL_ALIASES_MAP } = await import('./copilot-chat.js').catch(() => ({ MODEL_ALIASES_MAP: {} as Record<string,string> }))

  const resolvedModel = (MODEL_ALIASES_MAP as Record<string,string>)[model] ?? model
  const t0 = Date.now()

  log.info(`[consult] asking ${resolvedModel}: ${question.slice(0, 80)}`)

  let output: string
  try {
    // Try Ollama first for model-specific consults, fall back to callDirect
    if (resolvedModel && resolvedModel !== 'claude') {
      output = await callOllama(question, undefined, resolvedModel)
    } else {
      output = await callDirect(question)
    }
  } catch (e) {
    log.warn(`[consult] ${resolvedModel} failed: ${e}`)
    output = `(consult failed: ${e})`
  }

  const turn: AgentTurn = {
    role: 'consultant',
    model: resolvedModel,
    input: question,
    output,
    durationMs: Date.now() - t0,
  }
  logTurn(turn)
  return output
}

/**
 * Should we run the critic pipeline for this response?
 * Skip for short/simple/command responses.
 */
export function shouldRunCritic(userMessage: string, draft: string, intent: string): boolean {
  if (draft.length < 300) return false          // too short to critique
  if (intent === 'fast') return false            // /fast explicitly skips
  if (intent === 'computer') return false        // computer tasks don't need critic
  if (draft.startsWith('Error:')) return false   // already errored
  if (/^(ok|sure|done|yes|no|got it)/i.test(draft.trim())) return false
  // Run critic for substantive code, research, or reasoning
  return intent === 'code' || intent === 'research' || intent === 'reason' || draft.length > 800
}

/**
 * Run the full critic → reviser pipeline on a draft response.
 * Returns the final (possibly improved) response.
 */
export async function runCriticPipeline(
  userMessage: string,
  draft: string,
  intent: string,
): Promise<CollabResult> {
  const turns: AgentTurn[] = []
  const { callOllama } = await import('./copilot-chat.js')

  // ── Critic pass ────────────────────────────────────────────────────────────
  const criticPrompt = `The user asked:
"${userMessage.slice(0, 500)}"

The assistant's draft response:
---
${draft.slice(0, 4000)}
---

Review the draft. Output "LGTM" if it's good, or list specific issues (max 3).`

  log.info('[critic] reviewing draft...')
  const t0 = Date.now()
  let critique = ''
  try {
    critique = await callOllama(criticPrompt, CRITIC_SYSTEM, 'nemotron-3-super')
  } catch (e) {
    log.warn(`[critic] nemotron failed: ${e}`)
    return { finalResponse: draft, revised: false, turns }
  }

  turns.push({
    role: 'critic',
    model: 'nemotron-3-super',
    input: criticPrompt,
    output: critique,
    durationMs: Date.now() - t0,
  })
  logTurn(turns[turns.length - 1])

  // If critic is happy, return draft as-is
  if (/^lgtm/i.test(critique.trim())) {
    log.info('[critic] LGTM — no revision needed')
    return { finalResponse: draft, revised: false, turns, critique }
  }

  log.info(`[critic] issues found: ${critique.slice(0, 120).replace(/\n/g, ' ')}`)

  // ── Reviser pass ───────────────────────────────────────────────────────────
  const reviserPrompt = `The user asked:
"${userMessage.slice(0, 500)}"

Your previous draft:
---
${draft.slice(0, 4000)}
---

A reviewer found these issues:
${critique}

Write an improved response that fixes these issues. Output only the final response.`

  log.info('[reviser] improving draft...')
  const t1 = Date.now()
  let revised = ''
  try {
    revised = await callOllama(reviserPrompt, REVISER_SYSTEM, 'devstral-2:123b')
  } catch (e) {
    log.warn(`[reviser] devstral failed: ${e} — keeping original draft`)
    return { finalResponse: draft, revised: false, turns, critique }
  }

  turns.push({
    role: 'reviser',
    model: 'devstral-2:123b',
    input: reviserPrompt,
    output: revised,
    durationMs: Date.now() - t1,
  })
  logTurn(turns[turns.length - 1])

  log.info('[reviser] revision complete')
  return { finalResponse: revised, revised: true, turns, critique }
}

/** Parse [CONSULT: model: question] tags from a response and resolve them */
export async function resolveConsultTags(text: string): Promise<string> {
  const CONSULT_RE = /\[CONSULT:\s*([^:]+):\s*([^\]]+)\]/gi
  const matches = [...text.matchAll(CONSULT_RE)]
  if (matches.length === 0) return text

  let result = text
  for (const match of matches) {
    const model = match[1].trim()
    const question = match[2].trim()
    log.info(`[consult-tag] ${model}: ${question.slice(0, 60)}`)
    const answer = await runConsult(model, question)
    result = result.replace(match[0], `\n> **${model}:** ${answer.slice(0, 500)}\n`)
  }
  return result
}
