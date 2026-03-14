// Hydra Gateway entry point.
// Configure channels via environment variables and start.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ChannelRegistry } from '@hydra/core'
import { DiscordChannel } from '@hydra/discord'
import { TelegramChannel } from '@hydra/telegram'
import { SlackChannel } from '@hydra/slack'
import { Gateway } from './gateway.js'
import { createLogger } from './logger.js'

const log = createLogger('main')

// Load saved credentials that aren't in .env
function loadSavedPreferences() {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hydra', 'preferences.json'), 'utf8'))
    for (const [k, v] of Object.entries(prefs)) {
      if (!process.env[k]) process.env[k] = v as string
    }
  } catch {}
}

function loadSavedCredentials() {
  const credDir = path.join(os.homedir(), '.hydra', 'credentials')
  // Anthropic API key saved via /claude-key command
  if (!process.env.ANTHROPIC_API_KEY) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(credDir, 'anthropic.json'), 'utf8'))
      if (saved?.key) {
        process.env.ANTHROPIC_API_KEY = saved.key
        log.info('Loaded Anthropic API key from credentials file')
      }
    } catch {}
  }
}

async function main() {
  loadSavedCredentials()
  loadSavedPreferences()

  const registry = new ChannelRegistry()

  // Discord
  if (process.env.DISCORD_TOKEN) {
    registry.register(new DiscordChannel({
      token: process.env.DISCORD_TOKEN,
      accessRoleName: process.env.DISCORD_ACCESS_ROLE ?? 'Hydra',
      denyRoleName: process.env.DISCORD_DENY_ROLE ?? 'no-hydra',
    }))
    log.info('Discord channel registered')
  }

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    registry.register(new TelegramChannel({
      token: process.env.TELEGRAM_BOT_TOKEN,
      allowFrom: process.env.TELEGRAM_ALLOW_FROM
        ? process.env.TELEGRAM_ALLOW_FROM.split(',').map((v) => {
            const n = Number(v.trim())
            return isNaN(n) ? v.trim() : n
          })
        : undefined,
    }))
    log.info('Telegram channel registered')
  }

  // Slack (Socket Mode with SLACK_APP_TOKEN, or HTTP with SLACK_SIGNING_SECRET)
  if (process.env.SLACK_BOT_TOKEN) {
    registry.register(new SlackChannel({
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      port: process.env.SLACK_PORT ? Number(process.env.SLACK_PORT) : undefined,
      allowFrom: process.env.SLACK_ALLOW_FROM
        ? process.env.SLACK_ALLOW_FROM.split(',').map((v) => v.trim())
        : undefined,
    }))
    log.info('Slack channel registered')
  }

  if (registry.getAll().length === 0) {
    log.error('No channels configured. Set DISCORD_TOKEN, TELEGRAM_BOT_TOKEN, or SLACK_BOT_TOKEN.')
    process.exit(1)
  }

  const gateway = new Gateway(registry, {
    workdir: process.env.HYDRA_WORKDIR ?? process.cwd(),
    sessionIdleMs: 30 * 60 * 1000,
    worktrees: process.env.HYDRA_WORKTREES === 'true',
  })

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`)
    await gateway.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await gateway.start()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
