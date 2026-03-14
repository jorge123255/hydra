// PKCE OAuth flow for Anthropic/Claude accounts.
// Replicates what `opencode auth login` does internally.
// After OAuth, creates a real API key via the CLI endpoint.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTH_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const CREATE_KEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'
const OPENCODE_AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export type PendingOAuth = {
  verifier: string
  createdAt: number
}

/** Build the authorization URL to send to the user. Returns url + verifier (keep for code exchange). */
export function buildAuthUrl(): { url: string; verifier: string } {
  const { verifier, challenge } = generatePKCE()

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier, // opencode uses the verifier as state
  })

  return { url: `${AUTH_URL}?${params}`, verifier }
}

/** Exchange authorization code for tokens, then create a real API key. Returns sk-ant-... */
export async function exchangeCodeForKey(code: string, verifier: string): Promise<string> {
  // Step 1: exchange code → OAuth tokens
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: code.trim(),
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body.slice(0, 300)}`)
  }

  const tokens = (await tokenRes.json()) as any

  // Step 2: create a permanent API key using the OAuth access token
  const createKeyRes = await fetch(CREATE_KEY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ name: 'hydra-bot' }),
  })

  if (!createKeyRes.ok) {
    const body = await createKeyRes.text().catch(() => '')
    throw new Error(`API key creation failed (${createKeyRes.status}): ${body.slice(0, 300)}`)
  }

  const keyData = (await createKeyRes.json()) as any
  // Response shape varies — try a few common fields
  const apiKey: string =
    keyData?.raw_key ?? keyData?.api_key?.secret_key ?? keyData?.secret_key ?? keyData?.key ?? ''

  if (!apiKey.startsWith('sk-ant-')) {
    throw new Error(`Unexpected API key response: ${JSON.stringify(keyData).slice(0, 200)}`)
  }

  return apiKey
}

/** Persist API key to both ~/.hydra/credentials/anthropic.json and opencode's auth.json */
export function saveApiKey(apiKey: string): void {
  // 1. Hydra credentials
  const credDir = path.join(os.homedir(), '.hydra', 'credentials')
  fs.mkdirSync(credDir, { recursive: true })
  fs.writeFileSync(
    path.join(credDir, 'anthropic.json'),
    JSON.stringify({ key: apiKey, savedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  )

  // 2. OpenCode auth.json
  const opencodeDir = path.dirname(OPENCODE_AUTH_FILE)
  fs.mkdirSync(opencodeDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(OPENCODE_AUTH_FILE, 'utf8')) } catch {}
  existing.anthropic = { type: 'api', key: apiKey }
  fs.writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 })
}
