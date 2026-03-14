// Structured system prompt builder — ported from OpenClaw.
// Supports 3 modes: code, chat, computer.
// Includes NO_REPLY / HEARTBEAT_OK silent-reply protocol.
// Owner IDs are HMAC-SHA256 hashed for privacy (feature 10).

import crypto from 'node:crypto'

/** Reply with exactly this string to send nothing */
export const NO_REPLY = 'NO_REPLY'
/** Reply with exactly this string to acknowledge a heartbeat with no updates */
export const HEARTBEAT_OK = 'HEARTBEAT_OK'

export type PromptMode = 'code' | 'chat' | 'computer'

export type PromptContext = {
  mode: PromptMode
  channelId: string
  senderId: string
  senderName?: string
  /** Raw owner IDs from HYDRA_OWNER_IDS — will be HMAC-hashed before appearing in prompt */
  ownerIds?: string[]
  /** Workspace bootstrap files (SOUL.md, USER.md, etc.) */
  bootstrapFiles?: Record<string, string>
  memory?: string
  location?: string
  timezone?: string
  currentTime?: string
  /** Inject bash tool-use hint for real-time data (code mode) */
  includeToolHint?: boolean
}

const HMAC_SECRET = process.env.HYDRA_HMAC_SECRET ?? 'hydra-owner-hash-v1'

export function hashOwnerId(id: string): string {
  return crypto.createHmac('sha256', HMAC_SECRET).update(id).digest('hex').slice(0, 16)
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = []

  // ── Identity ───────────────────────────────────────────────────────────────
  const soulFile = ctx.bootstrapFiles?.['SOUL.md']
  if (soulFile) {
    sections.push(soulFile.trim())
  } else {
    sections.push(
      `You are Hydra, a personal AI assistant running across multiple messaging channels.\n` +
      `You are currently in the ${ctx.channelId} channel.`
    )
  }

  // ── Silent reply protocol ──────────────────────────────────────────────────
  sections.push(
    `## Silent Reply Protocol\n` +
    `- If you have nothing useful to add, reply with exactly: ${NO_REPLY}\n` +
    `- If you receive a heartbeat check and everything is fine, reply with exactly: ${HEARTBEAT_OK}\n` +
    `Do not use these tokens in any other context.`
  )

  // ── Reply style ────────────────────────────────────────────────────────────
  sections.push(
    `## Reply Style\n` +
    `- Be direct and concise. Lead with the answer, not the reasoning.\n` +
    `- Use plain text. Avoid markdown headers and bullet spam unless structure genuinely helps.\n` +
    `- Match the user's register — casual gets casual, technical gets precise.\n` +
    `- For code or terminal output, use code blocks.\n` +
    `- Never open with "Certainly!", "Of course!", "Great question!" or similar filler.\n` +
    `- Don't pad. One sentence beats three.`
  )

  // ── Mode-specific ──────────────────────────────────────────────────────────
  if (ctx.mode === 'code') {
    sections.push(
      `## Coding Mode\n` +
      `You have full filesystem and bash access via OpenCode.\n` +
      `- Read, write, edit, and execute files freely.\n` +
      `- Run tests, builds, package installs.\n` +
      `- For real-time data (weather, APIs, prices), use bash/webfetch — don't refuse.\n` +
      `- Prefer targeted changes over rewrites. Explain what changed and why.`
    )
    if (ctx.includeToolHint && ctx.location) {
      const city = ctx.location.split(',')[0].trim()
      sections.push(
        `## Tool Use Hint\n` +
        `You have bash. For real-time data, fetch it:\n` +
        `Weather: \`curl -s "wttr.in/${encodeURIComponent(city)}?format=3"\``
      )
    }
  } else if (ctx.mode === 'computer') {
    sections.push(
      `## Computer Use Mode\n` +
      `You control the Mac desktop via:\n` +
      `- osascript / AppleScript for app automation\n` +
      `- cliclick for mouse/keyboard (c:x,y click, t:text type, kp:key keypress)\n` +
      `- screencapture for screenshots\n` +
      `Think step by step. Prefer ax-tree/osascript over screenshots to save tokens.`
    )
  } else {
    sections.push(
      `## Chat Mode\n` +
      `Fast, direct chat. No tool access. Answer from knowledge.\n` +
      `For real-time info, explain what the user should check themselves.`
    )
  }

  // ── Context ────────────────────────────────────────────────────────────────
  const ctxLines: string[] = []
  if (ctx.currentTime) ctxLines.push(`Time: ${ctx.currentTime}`)
  if (ctx.location) ctxLines.push(`Location: ${ctx.location}`)
  if (ctxLines.length) sections.push(`## Context\n${ctxLines.join('\n')}`)

  // ── Sender ─────────────────────────────────────────────────────────────────
  const hashedSender = hashOwnerId(ctx.senderId)
  const senderLabel = ctx.senderName ? `${ctx.senderName} [${hashedSender}]` : hashedSender
  sections.push(`## Current Sender\n${senderLabel}`)

  // ── Owner permissions ──────────────────────────────────────────────────────
  if (ctx.ownerIds?.length) {
    const myHash = hashOwnerId(ctx.senderId)
    const isOwner = ctx.ownerIds.some((id) => hashOwnerId(id) === myHash)
    if (isOwner) {
      sections.push(`## Permissions\nThis sender is the bot owner. Full access to all commands and configuration.`)
    }
  }

  // ── Workspace bootstrap files ──────────────────────────────────────────────
  const fileOrder = ['USER.md', 'MEMORY.md', 'HEARTBEAT.md']
  const fileBlocks = fileOrder
    .filter((f) => ctx.bootstrapFiles?.[f]?.trim())
    .map((f) => `### ${f}\n${ctx.bootstrapFiles![f].trim()}`)
    .join('\n\n')
  if (fileBlocks) sections.push(`## Workspace Context\n${fileBlocks}`)

  // ── Per-thread memory ──────────────────────────────────────────────────────
  if (ctx.memory?.trim()) {
    sections.push(`## Memory\n${ctx.memory.trim()}`)
  }

  return sections.join('\n\n')
}
