// Send a screenshot to claude-sonnet-4.6 via GitHub Copilot for free vision analysis.
// Falls back to basic AppleScript screen summary if budget exceeded.
//
// Reads credentials directly from ~/.hydra/credentials/ to avoid cross-package deps.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { consumeVisionBudget } from './budget.js'
import { getScreenSummary } from './ax-tree.js'

export type VisionResult = {
  description: string
  source: 'copilot' | 'ax-tree' | 'budget-exceeded'
}

const CACHE_DIR = path.join(os.homedir(), '.hydra', 'credentials')
const GITHUB_TOKEN_PATH = path.join(CACHE_DIR, 'github-copilot-github.json')
const COPILOT_TOKEN_PATH = path.join(CACHE_DIR, 'github-copilot.token.json')
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

type GitHubTokenStore = { token: string }
type CopilotTokenCache = { token: string; expiresAt: number }

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return null }
}
function writeJson(p: string, val: unknown) {
  fs.writeFileSync(p + '.tmp', JSON.stringify(val, null, 2))
  fs.renameSync(p + '.tmp', p)
}

function deriveBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)
  const proxyEp = match?.[1]?.trim()
  if (!proxyEp) return 'https://api.individual.githubcopilot.com'
  const host = proxyEp.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.')
  return `https://${host}`
}

async function getCopilotCreds(): Promise<{ token: string; baseUrl: string } | null> {
  try {
    const githubStore = readJson<GitHubTokenStore>(GITHUB_TOKEN_PATH)
    if (!githubStore?.token) return null

    // Use cached token if >5min remaining
    const cached = readJson<CopilotTokenCache>(COPILOT_TOKEN_PATH)
    if (cached?.expiresAt && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
      return { token: cached.token, baseUrl: deriveBaseUrl(cached.token) }
    }

    // Refresh
    const res = await fetch(COPILOT_TOKEN_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${githubStore.token}` },
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    const token = json.token as string
    const expiresAt = typeof json.expires_at === 'number'
      ? (json.expires_at > 10_000_000_000 ? json.expires_at : json.expires_at * 1000)
      : Date.now() + 25 * 60 * 1000
    writeJson(COPILOT_TOKEN_PATH, { token, expiresAt, updatedAt: Date.now() })
    return { token, baseUrl: deriveBaseUrl(token) }
  } catch {
    return null
  }
}

/** Analyze a screenshot using the configured vision provider */
export async function analyzeScreenshot(
  dataUrl: string,
  question = 'Describe what is on the screen in detail. List any clickable elements, buttons, text fields, and their approximate positions.'
): Promise<VisionResult> {
  // Check budget first
  if (!consumeVisionBudget()) {
    const summary = await getScreenSummary()
    return {
      description: `[Vision budget exceeded] Screen summary:\n${summary}`,
      source: 'budget-exceeded',
    }
  }

  // Try Copilot vision
  try {
    const creds = await getCopilotCreds()
    if (creds) {
      const description = await callCopilotVision(creds, dataUrl, question)
      return { description, source: 'copilot' }
    }
  } catch {}

  // Try Claude via OpenCode OAuth token (~/.local/share/opencode/auth.json)
  try {
    const authFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
    const auth = readJson<any>(authFile)
    const oauthToken = auth?.anthropic?.access
    if (oauthToken) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${oauthToken}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
        body: JSON.stringify({
          model: process.env.HYDRA_CLAUDE_MODEL ?? 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.replace(/^data:image\/\w+;base64,/, '') } },
            { type: 'text', text: question },
          ]}],
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const json = await res.json() as any
        const text = json.content?.[0]?.text ?? ''
        if (text) return { description: text, source: 'copilot' }
      }
    }
  } catch {}

  // Fallback to ax-tree (0 tokens)
  const summary = await getScreenSummary()
  return { description: summary, source: 'ax-tree' }
}

async function callCopilotVision(
  creds: { token: string; baseUrl: string },
  dataUrl: string,
  question: string
): Promise<string> {
  const model = process.env.HYDRA_COPILOT_MODEL ?? 'claude-sonnet-4.6'
  const res = await fetch(`${creds.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
      'Copilot-Integration-Id': 'hydra-computer-use',
      'Editor-Version': 'hydra/1.0',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: question },
        ],
      }],
    }),
  })
  if (!res.ok) throw new Error(`Copilot vision failed: ${res.status}`)
  const json = (await res.json()) as any
  return json.choices?.[0]?.message?.content ?? '[No response]'
}
