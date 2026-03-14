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

/** True if ANTHROPIC_API_KEY is set (OAuth token alone cannot call the API directly) */
export function isClaudeConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

const SYSTEM_PROMPT = `You are a personal AI assistant running inside Hydra, a multi-channel bot.

Reply style:
- Be direct and concise. Lead with the answer, not the reasoning.
- Use plain text. No markdown headers or bullet spam unless it genuinely helps.
- Match the user's register — casual question gets a casual answer.
- For code or technical output, use code blocks.
- Never start with "Certainly!", "Of course!", "Great question!" or similar filler.`

/** Call Claude via Anthropic API (supports vision via base64 images) */
export async function callClaudeDirect(prompt: string, images?: string[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — send /claude-key sk-ant-... to configure')
  }

  const model = process.env.HYDRA_CLAUDE_MODEL ?? 'claude-sonnet-4-6'

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

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`)
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
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }),
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
