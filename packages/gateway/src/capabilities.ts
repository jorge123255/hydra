// Capability Inventory — dynamic list of what this bot can actually do right now.
// Auto-generated from health state + provider config + metrics history.
// Written to CAPABILITIES.md in workspace so AI knows its own limits.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getLastHealthState } from './health-checker.js'

const CAP_FILE = path.join(os.homedir(), '.hydra', 'capabilities.json')

export interface Capability {
  id: string
  name: string
  description: string
  available: boolean
  reason?: string       // why unavailable, if not
  lastVerified: string
}

function ensureDir() {
  const d = path.dirname(CAP_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

export function buildCapabilities(): Capability[] {
  const health = getLastHealthState()
  const toolMap = Object.fromEntries(
    (health.tools ?? []).map(t => [t.name, t])
  )

  const now = new Date().toISOString()

  const capabilities: Capability[] = [
    {
      id: 'chat',
      name: 'Chat & Q&A',
      description: 'Answer questions, have conversations, explain concepts',
      available: true,
      lastVerified: now,
    },
    {
      id: 'code',
      name: 'Code Generation & Review',
      description: 'Write, review, refactor, and debug code via OpenCode',
      available: (() => {
        const oc = toolMap['opencode']
        return !oc || oc.status === 'ok' || oc.status === 'unknown'
      })(),
      reason: toolMap['opencode']?.status === 'down' ? 'OpenCode binary unavailable' : undefined,
      lastVerified: now,
    },
    {
      id: 'vision',
      name: 'Image Understanding',
      description: 'Analyze photos and screenshots sent in chat',
      available: !!(process.env.ANTHROPIC_API_KEY || (() => {
        const ca = toolMap['claude-auth']
        return ca?.status === 'ok' || ca?.status === 'degraded'
      })()),
      reason: 'Requires Claude auth token',
      lastVerified: now,
    },
    {
      id: 'ollama',
      name: 'Ollama Cloud Models',
      description: 'Access to nemotron, devstral, deepseek and 14+ models',
      available: toolMap['ollama-cloud']?.status === 'ok',
      reason: toolMap['ollama-cloud']?.status !== 'ok' ? toolMap['ollama-cloud']?.error : undefined,
      lastVerified: now,
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT Subagents',
      description: 'Fan-out parallel tasks to GPT-4o pool',
      available: (() => {
        const cg = toolMap['chatgpt-pool']
        return cg?.status === 'ok'
      })(),
      reason: toolMap['chatgpt-pool']?.status !== 'ok' ? 'No accounts — run /chatgpt_sync' : undefined,
      lastVerified: now,
    },
    {
      id: 'computer',
      name: 'Mac Desktop Control',
      description: 'Click, type, take screenshots, run AppleScript, control apps',
      available: fs.existsSync('/usr/bin/osascript'),
      reason: !fs.existsSync('/usr/bin/osascript') ? 'osascript not found' : undefined,
      lastVerified: now,
    },
    {
      id: 'memory',
      name: 'Persistent Memory',
      description: 'Remember notes, goals, facts across sessions',
      available: true,
      lastVerified: now,
    },
    {
      id: 'schedule',
      name: 'Task Scheduling',
      description: 'Run tasks on cron or ISO date schedule',
      available: true,
      lastVerified: now,
    },
    {
      id: 'subagents',
      name: 'Parallel AI Subagents',
      description: [
        'Spawn parallel AI workers via [SUBAGENT: task1 | task2 | task3].',
        'Available models (route by name or let the system classify):',
        '  devstral-2:123b — 123B coding specialist. Best for: write/fix/refactor code, generate tests, explain algorithms.',
        '  nemotron-3-super — 120B research model, 256K context. Best for: deep knowledge, long documents, summarization, facts.',
        '  deepseek-v3.2 — reasoning specialist. Best for: logic puzzles, step-by-step analysis, comparing trade-offs, hard decisions.',
        '  llava-v1.6 — vision model. Best for: describing images, reading charts.',
        'Route by name: "devstral-2:123b: write the implementation" or just write the task and let the system pick.',
      ].join(' '),
      available: true,
      lastVerified: now,
    },
    {
      id: 'self_improve',
      name: 'Self-Improvement',
      description: 'Review and patch own source code every 6h',
      available: true,
      lastVerified: now,
    },
  ]

  ensureDir()
  fs.writeFileSync(CAP_FILE, JSON.stringify({ lastBuilt: now, capabilities }, null, 2))
  return capabilities
}

export function getCapabilities(): Capability[] {
  try {
    if (fs.existsSync(CAP_FILE)) {
      const d = JSON.parse(fs.readFileSync(CAP_FILE, 'utf8'))
      // Rebuild if >1h old
      if (d.lastBuilt && Date.now() - new Date(d.lastBuilt).getTime() < 3600000) {
        return d.capabilities
      }
    }
  } catch {}
  return buildCapabilities()
}

export function formatCapabilities(caps: Capability[]): string {
  const lines = ['🤖 *Capability Inventory*\n']
  const available = caps.filter(c => c.available)
  const unavailable = caps.filter(c => !c.available)

  lines.push('*Available now:*')
  for (const c of available) {
    lines.push(`✅ **${c.name}** — ${c.description}`)
  }
  if (unavailable.length) {
    lines.push('\n*Not available:*')
    for (const c of unavailable) {
      lines.push(`❌ **${c.name}**${c.reason ? ` — ${c.reason}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** Write CAPABILITIES.md to workspace so AI knows what it can do */
export function writeCapabilitiesFile(workdir: string): void {
  try {
    const caps = getCapabilities()
    const lines = ['# CAPABILITIES.md — What I Can Do Right Now', '']
    for (const c of caps) {
      lines.push(`- ${c.available ? '✅' : '❌'} **${c.name}**: ${c.description}${!c.available && c.reason ? ` _(${c.reason})_` : ''}`)
    }
    lines.push(`\n_Last updated: ${new Date().toISOString().slice(0, 16)} UTC_`)
    fs.writeFileSync(path.join(workdir, 'CAPABILITIES.md'), lines.join('\n'))
  } catch {}
}
