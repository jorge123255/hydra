// Direct Copilot API calls — fast chat without OpenCode overhead.
// Re-exports auth helpers so gateway.ts has a single import for Copilot-related things.

export {
  isCopilotConfigured,
  githubCopilotLogin,
  resolveCopilotCredentials,
  DEFAULT_COPILOT_BASE_URL,
} from './auth/github-copilot.js'

import { resolveCopilotCredentials } from './auth/github-copilot.js'
import { getVisionUsage } from '@hydra/computer-use'

/** Current vision budget status for today */
export function getVisionUsageStatus(): { count: number; budget: number; remaining: number } {
  return getVisionUsage()
}

/** Call Copilot directly (no OpenCode). Supports optional image data URLs for vision. */
export async function callCopilotDirect(prompt: string, images?: string[]): Promise<string> {
  const creds = await resolveCopilotCredentials()
  if (!creds) throw new Error('Copilot not configured — run /copilot-login first')

  const model = process.env.HYDRA_COPILOT_MODEL ?? 'claude-sonnet-4.6'

  // Build message content
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
      messages: [{ role: 'user', content }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Copilot API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = (await res.json()) as any
  return json.choices?.[0]?.message?.content ?? '[No response from Copilot]'
}
