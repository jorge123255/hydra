import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const HEALTH_FILE = path.join(os.homedir(), '.hydra', 'health-state.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000  // 24h

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export interface ToolHealth {
  name: string
  status: HealthStatus
  lastChecked: string
  latencyMs?: number
  error?: string
  note?: string
}

export interface HealthState {
  lastRun: string
  tools: ToolHealth[]
}

function ensureDir() {
  const d = path.dirname(HEALTH_FILE)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

function loadState(): HealthState {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'))
    }
  } catch {}
  return { lastRun: '', tools: [] }
}

function saveState(state: HealthState) {
  try {
    ensureDir()
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2))
  } catch {}
}

// ─── Individual checks ───────────────────────────────────────────────────────

async function checkOllamaCloud(): Promise<ToolHealth> {
  const key = process.env.OLLAMA_CLOUD_API_KEY
  if (!key) return { name: 'ollama-cloud', status: 'unknown', lastChecked: new Date().toISOString(), note: 'No API key' }
  const start = Date.now()
  try {
    const res = await fetch('https://ollama.com/api/tags', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    })
    const latencyMs = Date.now() - start
    if (res.ok) return { name: 'ollama-cloud', status: 'ok', lastChecked: new Date().toISOString(), latencyMs }
    return { name: 'ollama-cloud', status: 'degraded', lastChecked: new Date().toISOString(), latencyMs, error: `HTTP ${res.status}` }
  } catch (e: any) {
    return { name: 'ollama-cloud', status: 'down', lastChecked: new Date().toISOString(), error: e.message?.slice(0, 80) }
  }
}

async function checkClaudeAuth(): Promise<ToolHealth> {
  // Check direct API key first
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: 'claude-auth', status: 'ok', lastChecked: new Date().toISOString(), note: 'API key set' }
  }
  const authFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
  if (!fs.existsSync(authFile)) {
    return { name: 'claude-auth', status: 'down', lastChecked: new Date().toISOString(), note: 'No API key and auth.json not found' }
  }
  try {
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'))
    // Format: { anthropic: { type, access, refresh, expires } }
    const a = auth?.anthropic
    if (!a) {
      return { name: 'claude-auth', status: 'down', lastChecked: new Date().toISOString(), error: 'No anthropic key in auth.json' }
    }
    const token = a.access || a.accessToken || a.token
    const expiresMs = a.expires || a.expiresAt
    if (!token) {
      return { name: 'claude-auth', status: 'down', lastChecked: new Date().toISOString(), error: 'No access token' }
    }
    if (expiresMs) {
      const minsLeft = Math.round((Number(expiresMs) - Date.now()) / 60000)
      if (minsLeft < 0) {
        const hasRefresh = !!(a.refresh || a.refreshToken)
        return {
          name: 'claude-auth',
          status: hasRefresh ? 'degraded' : 'down',
          lastChecked: new Date().toISOString(),
          error: `Expired ${Math.abs(minsLeft)}min ago`,
          note: hasRefresh ? 'Refresh token present — will auto-renew' : 'No refresh token',
        }
      }
      const daysLeft = Math.round(minsLeft / 1440)
      return { name: 'claude-auth', status: 'ok', lastChecked: new Date().toISOString(), note: `OAuth token valid, expires in ${daysLeft > 1 ? daysLeft + 'd' : minsLeft + 'min'}` }
    }
    return { name: 'claude-auth', status: 'ok', lastChecked: new Date().toISOString(), note: 'OAuth token present' }
  } catch (e: any) {
    return { name: 'claude-auth', status: 'unknown', lastChecked: new Date().toISOString(), error: e.message?.slice(0, 80) }
  }
}

async function checkCopilot(): Promise<ToolHealth> {
  const tokenFile = path.join(os.homedir(), '.hydra', 'credentials', 'github-copilot.token.json')
  const githubFile = path.join(os.homedir(), '.hydra', 'credentials', 'github-copilot-github.json')
  if (!fs.existsSync(githubFile)) {
    return { name: 'copilot', status: 'unknown', lastChecked: new Date().toISOString(), note: 'Not configured' }
  }
  if (fs.existsSync(tokenFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
      if (cached.expiresAt && new Date(cached.expiresAt).getTime() > Date.now() + 60000) {
        const minsLeft = Math.round((new Date(cached.expiresAt).getTime() - Date.now()) / 60000)
        return { name: 'copilot', status: 'ok', lastChecked: new Date().toISOString(), note: `Token valid ~${minsLeft}min` }
      }
    } catch {}
  }
  return { name: 'copilot', status: 'degraded', lastChecked: new Date().toISOString(), note: 'Token expired/missing — will refresh on next use' }
}

async function checkChatGPTPool(): Promise<ToolHealth> {
  const poolFile = path.join(os.homedir(), '.hydra', 'credentials', 'codex-pool.json')
  if (!fs.existsSync(poolFile)) {
    return { name: 'chatgpt-pool', status: 'unknown', lastChecked: new Date().toISOString(), note: 'No accounts added' }
  }
  try {
    const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'))
    const accounts = pool.accounts || []
    if (accounts.length === 0) {
      return { name: 'chatgpt-pool', status: 'unknown', lastChecked: new Date().toISOString(), note: 'Pool empty' }
    }
    const active = accounts.filter((a: any) => !a.disabled).length
    return {
      name: 'chatgpt-pool',
      status: active > 0 ? 'ok' : 'down',
      lastChecked: new Date().toISOString(),
      note: `${active}/${accounts.length} accounts active`,
    }
  } catch (e: any) {
    return { name: 'chatgpt-pool', status: 'unknown', lastChecked: new Date().toISOString(), error: e.message }
  }
}

async function checkOpenCode(): Promise<ToolHealth> {
  // OpenCode starts on-demand per session — check if binary is available instead
  const { execSync } = await import('child_process')
  try {
    execSync('which opencode', { stdio: 'ignore' })
    return { name: 'opencode', status: 'ok', lastChecked: new Date().toISOString(), note: 'Binary available (on-demand)' }
  } catch {
    try {
      execSync('npx opencode --version', { stdio: 'ignore', timeout: 5000 })
      return { name: 'opencode', status: 'ok', lastChecked: new Date().toISOString(), note: 'Available via npx (on-demand)' }
    } catch {
      return { name: 'opencode', status: 'degraded', lastChecked: new Date().toISOString(), note: 'Binary not found in PATH — sessions may fail' }
    }
  }
}

// ─── Run all checks ───────────────────────────────────────────────────────────

export async function runHealthChecks(): Promise<ToolHealth[]> {
  const results = await Promise.allSettled([
    checkOllamaCloud(),
    checkClaudeAuth(),
    checkCopilot(),
    checkChatGPTPool(),
    checkOpenCode(),
  ])

  const tools: ToolHealth[] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    const names = ['ollama-cloud', 'claude-auth', 'copilot', 'chatgpt-pool', 'opencode']
    return { name: names[i], status: 'unknown' as HealthStatus, lastChecked: new Date().toISOString(), error: 'Check threw' }
  })

  const state: HealthState = { lastRun: new Date().toISOString(), tools }
  saveState(state)
  return tools
}

export function getLastHealthState(): HealthState {
  return loadState()
}

export function formatHealthReport(tools: ToolHealth[]): string {
  const icon = (s: HealthStatus) => s === 'ok' ? '✅' : s === 'degraded' ? '⚠️' : s === 'down' ? '❌' : '❓'
  const lines = ['🏥 *Hydra Health Report*\n']
  for (const t of tools) {
    const lat = t.latencyMs ? ` (${t.latencyMs}ms)` : ''
    const note = t.note ? ` — ${t.note}` : t.error ? ` — ${t.error}` : ''
    lines.push(`${icon(t.status)} *${t.name}*${lat}${note}`)
  }
  const when = tools[0]?.lastChecked ? `\n_Checked: ${tools[0].lastChecked.slice(0, 16).replace('T', ' ')} UTC_` : ''
  lines.push(when)
  return lines.join('\n')
}

// ─── Background loop ──────────────────────────────────────────────────────────

let healthTimer: ReturnType<typeof setInterval> | null = null

export function startHealthCheckLoop(
  onDegraded?: (report: string) => void
): void {
  if (healthTimer) return

  const runCheck = async () => {
    const tools = await runHealthChecks()
    const hasProblem = tools.some(t => t.status === 'down' || t.status === 'degraded')
    if (hasProblem && onDegraded) {
      const report = formatHealthReport(tools)
      onDegraded(report)
    }
  }

  // Run once at startup (delayed 30s to let everything initialize)
  setTimeout(runCheck, 30000)
  healthTimer = setInterval(runCheck, CHECK_INTERVAL_MS)
}
