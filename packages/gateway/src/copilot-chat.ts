// Direct AI chat — without OpenCode overhead.
// Priority: 1) Anthropic API key (Claude) 2) GitHub Copilot 3) throw
// Copilot is reserved for vision when Claude API key is set.

export {
  isCopilotConfigured,
  githubCopilotLogin,
  resolveCopilotCredentials,
  DEFAULT_COPILOT_BASE_URL,
} from './auth/github-copilot.js'

export { isClaudeOAuthAvailable, getValidClaudeToken } from './auth/claude-keychain.js'

import { resolveCopilotCredentials } from './auth/github-copilot.js'
import { getValidClaudeToken } from './auth/claude-keychain.js'
import { getVisionUsage } from '@hydra/computer-use'

/** Current vision budget status for today */
export function getVisionUsageStatus(): { count: number; budget: number; remaining: number } {
  return getVisionUsage()
}

/** True if ANTHROPIC_API_KEY is set OR Claude OAuth token is available */
export function isClaudeConfigured(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  return getValidClaudeToken() !== null
}

/** Call Claude via Anthropic API (supports vision via base64 images) */
export async function callClaudeDirect(prompt: string, images?: string[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const oauthToken = apiKey ? null : getValidClaudeToken()

  if (!apiKey && !oauthToken) {
    throw new Error('No Claude credentials — set ANTHROPIC_API_KEY or ensure Claude Code is logged in')
  }

  const model = process.env.HYDRA_CLAUDE_MODEL ?? 'claude-sonnet-4-5'

  // Build content array — images first, then text
  type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  type TextBlock  = { type: 'text'; text: string }
  const content: Array<ImageBlock | TextBlock> = []

  if (images?.length) {
    for (const dataUrl of images) {
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        })
      }
    }
  }
  content.push({ type: 'text', text: prompt })

  const authHeaders: Record<string, string> = apiKey
    ? { 'x-api-key': apiKey }
    : { Authorization: `Bearer ${oauthToken}` }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...authHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as any
  return json.content?.[0]?.text ?? '[No response from Claude]'
}

/** Call Copilot directly — used as fallback or for vision when no API key */
export async function callCopilotDirect(prompt: string, images?: string[]): Promise<string> {
  const creds = await resolveCopilotCredentials()
  if (!creds) throw new Error('Copilot not configured — run /copilot-login first')

  const model = process.env.HYDRA_COPILOT_MODEL ?? 'claude-sonnet-4.6'

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }

  const content: ContentPart[] = []
  if (images?.length) {
    for (const dataUrl of images) {
      content.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  content.push({ type: 'text', text: prompt })

  const res = await fetch(`${creds.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
      'Copilot-Integration-Id': 'hydra-gateway',
      'Editor-Version': 'hydra/1.0',
    },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content }] }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Copilot API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as any
  return json.choices?.[0]?.message?.content ?? '[No response from Copilot]'
}

/** Call the best available direct provider: Claude > Copilot */
export async function callDirect(prompt: string, images?: string[]): Promise<string> {
  if (isClaudeConfigured()) return callClaudeDirect(prompt, images)
  return callCopilotDirect(prompt, images)
}
