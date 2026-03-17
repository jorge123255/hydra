// Self-awareness engine.
// Generates SELF.md — a live snapshot of what Hydra is right now.
// Written to the workspace on startup and refreshed on config changes.
// Injected into every system prompt so agent_smith knows itself accurately.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createLogger } from './logger.js'

const log = createLogger('self-awareness')

const HYDRA_DIR = '/Users/gszulc/hydra'
const START_TIME = Date.now()

function uptime(): string {
  const s = Math.floor((Date.now() - START_TIME) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s/60)}m`
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
}

function getRecentSelfImprovements(): string {
  try {
    const log = execSync(
      'git -C /Users/gszulc/hydra log --oneline -10 --grep="self-improve"',
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    return log || 'None yet'
  } catch { return 'unavailable' }
}

function getRecentCommits(): string {
  try {
    return execSync(
      'git -C /Users/gszulc/hydra log --oneline -5',
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
  } catch { return 'unavailable' }
}

function getSourceMap(): string {
  const files = [
    'packages/gateway/src/gateway.ts',
    'packages/gateway/src/copilot-chat.ts',
    'packages/gateway/src/router.ts',
    'packages/gateway/src/opencode-session.ts',
    'packages/gateway/src/self-review.ts',
    'packages/gateway/src/self-awareness.ts',
    'packages/gateway/src/workspace.ts',
    'packages/gateway/src/memory.ts',
    'packages/gateway/src/history.ts',
    'packages/gateway/src/scheduler.ts',
    'packages/gateway/src/auth/ollama.ts',
    'packages/gateway/src/auth/codex-pool.ts',
    'packages/telegram/src/telegram-channel.ts',
  ]
  return files.map(f => {
    const full = path.join(HYDRA_DIR, f)
    try {
      const lines = fs.readFileSync(full, 'utf8').split('\n').length
      return `  ${f} (${lines} lines)`
    } catch {
      return `  ${f} (not found)`
    }
  }).join('\n')
}

function getProviderStatus(): string {
  const lines: string[] = []

  // Ollama Cloud
  const ollamaKey = process.env.OLLAMA_CLOUD_API_KEY
  if (ollamaKey) {
    const model = process.env.HYDRA_OLLAMA_MODEL ?? 'nemotron-3-super'
    lines.push(`✅ Ollama Cloud — active model: ${model}`)
    lines.push(`   Available: devstral-2:123b, deepseek-v3.2, gpt-oss:120b, kimi-k2:1t, mistral-large-3:675b...`)
  } else {
    lines.push(`❌ Ollama Cloud — no API key (set OLLAMA_CLOUD_API_KEY)`)
  }

  // Claude OAuth
  const openCodePath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
  try {
    const data = JSON.parse(fs.readFileSync(openCodePath, 'utf8'))
    const ant = data?.anthropic
    if (ant?.access) {
      const expires = new Date(ant.expires)
      const minsLeft = Math.floor((ant.expires - Date.now()) / 60000)
      if (minsLeft > 0) {
        lines.push(`✅ Claude OAuth — valid for ${minsLeft}m (expires ${expires.toTimeString().slice(0,5)})`)
      } else {
        lines.push(`⚠️  Claude OAuth — expired, auto-refreshing (refresh token present)`)
      }
    }
  } catch { lines.push(`❌ Claude OAuth — not configured`) }

  // ANTHROPIC_API_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) lines.push(`✅ Anthropic API Key — ...${apiKey.slice(-6)}`)

  // ChatGPT pool
  const poolFile = path.join(os.homedir(), '.hydra', 'credentials', 'codex-pool.json')
  try {
    const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'))
    lines.push(`✅ ChatGPT Pool — ${pool.length} account(s): ${pool.map((a: any) => a.label).join(', ')}`)
  } catch { lines.push(`❌ ChatGPT Pool — no accounts (use /chatgpt_login label sk-...)`) }

  return lines.join('\n')
}

function getRouting(): string {
  const ollamaCloud = !!process.env.OLLAMA_CLOUD_API_KEY
  const model = process.env.HYDRA_OLLAMA_MODEL ?? 'nemotron-3-super'
  if (!ollamaCloud) return '  All routes → Claude OAuth or fallback'
  return [
    `  code     → devstral-2:123b (Ollama Cloud)`,
    `  research → nemotron-3-super (Ollama Cloud)`,
    `  reason   → deepseek-v3.2 (Ollama Cloud)`,
    `  chat     → ${model} (Ollama Cloud)`,
    `  vision   → Claude OAuth / Copilot`,
    `  self-review → Claude Opus 4.6 → devstral-2:123b fallback`,
  ].join('\n')
}

function getCommands(): string {
  return [
    '/help /status /model /review /review_stats /providers',
    '/research <query> /reason <question> /code <task> /fast <msg>',
    '/remember <note> /forget /tasks /schedule /unschedule',
    '/approve /pending /revoke',
    '/chatgpt_login /chatgpt_accounts /chatgpt_remove',
    '/claude_status /copilot_login /copilot_status',
    '/ollama_pull /diff /rollback /computer /restart /ping',
  ].join('\n')
}

export function generateSelfAwareness(): string {
  return `# SELF.md — What I Am Right Now

## Identity
I am **agent_smith**, an autonomous AI assistant running on bob (192.168.1.9).
Source code: ${HYDRA_DIR}
Uptime: ${uptime()} | PID: ${process.pid}

## My Architecture
I am a multi-channel AI gateway (Hydra) built as a pnpm monorepo:
- **gateway** — my brain: routing, commands, AI calls, memory, scheduling
- **telegram** — how I talk to you on Telegram
- **core** — shared types
- **computer-use** — macOS desktop control

## Active Providers
${getProviderStatus()}

## How I Route Messages
${getRouting()}

## Commands I Know
${getCommands()}

## My Source Files
${getSourceMap()}

## Recent Self-Improvements
${getRecentSelfImprovements()}

## Recent Commits
${getRecentCommits()}

## Self-Review Schedule
I review and improve my own code every 6 hours automatically.
Files rotate: gateway.ts → copilot-chat.ts → router.ts → opencode-session.ts → ...
Run /review to trigger immediately. Run /review_stats to see history.

## Key Facts About Myself
- I can edit my own TypeScript source and restart myself with [RESTART]
- I have 256K context via nemotron-3-super for deep research tasks
- I fan out parallel work to ChatGPT subagents with [SUBAGENT: task1 | task2]
- My memory persists across restarts in MEMORY.md
- I push my own improvements to GitHub automatically`
}

export function writeSelfAwareness(workdir: string): void {
  try {
    fs.mkdirSync(workdir, { recursive: true })
    fs.writeFileSync(path.join(workdir, 'SELF.md'), generateSelfAwareness())
    log.debug('SELF.md updated')
  } catch (e) {
    log.warn(`Failed to write SELF.md: ${e}`)
  }
}
