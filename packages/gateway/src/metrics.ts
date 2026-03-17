import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const METRICS_DIR = path.join(os.homedir(), '.hydra', 'metrics')
const MAX_ENTRIES = 2000

export interface MetricEntry {
  ts: string         // ISO timestamp
  model: string
  provider: string   // 'claude' | 'copilot' | 'ollama' | 'openai' | 'opencode'
  route: string      // 'chat' | 'code' | 'vision' | 'research' | 'reason' | 'computer'
  latencyMs: number
  success: boolean
  errorType?: string // 'timeout' | 'rate_limit' | 'auth' | 'network' | 'other'
  tokensIn?: number
  tokensOut?: number
  channel?: string
}

function getMetricsFile(): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(METRICS_DIR, `metrics-${date}.json`)
}

function ensureDir() {
  if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true })
}

export function logCall(entry: MetricEntry): void {
  try {
    ensureDir()
    const file = getMetricsFile()
    let entries: MetricEntry[] = []
    if (fs.existsSync(file)) {
      try { entries = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { entries = [] }
    }
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
    fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  } catch (e) {
    // never crash the gateway for metrics
  }
}

export function loadTodayMetrics(): MetricEntry[] {
  try {
    ensureDir()
    const file = getMetricsFile()
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function loadRecentMetrics(days = 7): MetricEntry[] {
  try {
    ensureDir()
    const entries: MetricEntry[] = []
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      const file = path.join(METRICS_DIR, `metrics-${d}.json`)
      if (fs.existsSync(file)) {
        try {
          const day = JSON.parse(fs.readFileSync(file, 'utf8'))
          entries.push(...day)
        } catch {}
      }
    }
    return entries
  } catch {
    return []
  }
}

interface ProviderStats {
  calls: number
  success: number
  totalLatency: number
  errors: Record<string, number>
}

export function getStatsSummary(): string {
  const today = loadTodayMetrics()
  const week = loadRecentMetrics(7)

  if (today.length === 0 && week.length === 0) {
    return '📊 No metrics recorded yet. Stats will appear after the first AI call.'
  }

  const providerMap: Record<string, ProviderStats> = {}
  const routeMap: Record<string, number> = {}

  for (const e of today) {
    if (!providerMap[e.provider]) {
      providerMap[e.provider] = { calls: 0, success: 0, totalLatency: 0, errors: {} }
    }
    const p = providerMap[e.provider]
    p.calls++
    if (e.success) { p.success++; p.totalLatency += e.latencyMs }
    else if (e.errorType) { p.errors[e.errorType] = (p.errors[e.errorType] || 0) + 1 }
    routeMap[e.route] = (routeMap[e.route] || 0) + 1
  }

  const lines: string[] = ['📊 *Hydra Execution Stats*\n']

  // Today summary
  const todayTotal = today.length
  const todayOk = today.filter(e => e.success).length
  const todayRate = todayTotal > 0 ? Math.round((todayOk / todayTotal) * 100) : 0
  const todayAvgLatency = todayOk > 0
    ? Math.round(today.filter(e => e.success).reduce((s, e) => s + e.latencyMs, 0) / todayOk)
    : 0
  lines.push(`*Today:* ${todayTotal} calls — ${todayRate}% success — avg ${todayAvgLatency}ms`)

  // Weekly
  const weekTotal = week.length
  const weekOk = week.filter(e => e.success).length
  const weekRate = weekTotal > 0 ? Math.round((weekOk / weekTotal) * 100) : 0
  lines.push(`*7-day:* ${weekTotal} calls — ${weekRate}% success\n`)

  // Per-provider breakdown
  if (Object.keys(providerMap).length > 0) {
    lines.push('*Providers (today):*')
    for (const [prov, stats] of Object.entries(providerMap).sort((a, b) => b[1].calls - a[1].calls)) {
      const rate = Math.round((stats.success / stats.calls) * 100)
      const avgLat = stats.success > 0 ? Math.round(stats.totalLatency / stats.success) : 0
      const errStr = Object.entries(stats.errors).map(([k, v]) => `${k}:${v}`).join(', ')
      lines.push(`  • ${prov}: ${stats.calls} calls, ${rate}% ok, ~${avgLat}ms${errStr ? ` [${errStr}]` : ''}`)
    }
    lines.push('')
  }

  // Route distribution
  if (Object.keys(routeMap).length > 0) {
    lines.push('*Routes (today):*')
    for (const [route, count] of Object.entries(routeMap).sort((a, b) => b[1] - a[1])) {
      lines.push(`  • ${route}: ${count}`)
    }
  }

  return lines.join('\n')
}

export function detectPatterns(): string[] {
  const warnings: string[] = []
  const recent = loadRecentMetrics(1)
  if (recent.length < 5) return warnings

  const byProvider: Record<string, MetricEntry[]> = {}
  for (const e of recent) {
    if (!byProvider[e.provider]) byProvider[e.provider] = []
    byProvider[e.provider].push(e)
  }

  for (const [prov, entries] of Object.entries(byProvider)) {
    if (entries.length < 3) continue
    const failRate = entries.filter(e => !e.success).length / entries.length
    if (failRate > 0.5) warnings.push(`⚠️ ${prov} has ${Math.round(failRate * 100)}% failure rate today`)

    const timeouts = entries.filter(e => e.errorType === 'timeout').length
    if (timeouts >= 3) warnings.push(`⚠️ ${prov} has ${timeouts} timeouts today — may be slow`)

    const authErrors = entries.filter(e => e.errorType === 'auth').length
    if (authErrors >= 2) warnings.push(`🔑 ${prov} has ${authErrors} auth errors — token may need refresh`)
  }

  // P95 latency check
  const successes = recent.filter(e => e.success).map(e => e.latencyMs).sort((a, b) => a - b)
  if (successes.length >= 10) {
    const p95 = successes[Math.floor(successes.length * 0.95)]
    if (p95 > 30000) warnings.push(`🐢 P95 latency is ${Math.round(p95 / 1000)}s — responses are slow`)
  }

  return warnings
}
