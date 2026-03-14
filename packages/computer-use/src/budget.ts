import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const usageDir = path.join(os.homedir(), '.hydra', 'usage')
fs.mkdirSync(usageDir, { recursive: true })

function todayKey() {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function usagePath() {
  return path.join(usageDir, `vision-${todayKey()}.json`)
}

type UsageStore = { count: number; date: string }

function readUsage(): UsageStore {
  try { return JSON.parse(fs.readFileSync(usagePath(), 'utf8')) as UsageStore }
  catch { return { count: 0, date: todayKey() } }
}

function writeUsage(store: UsageStore) {
  fs.writeFileSync(usagePath(), JSON.stringify(store, null, 2))
}

/** Returns current vision call count for today */
export function getVisionUsage(): { count: number; budget: number; remaining: number } {
  const budget = parseInt(process.env.HYDRA_VISION_BUDGET ?? '50', 10)
  const { count } = readUsage()
  return { count, budget, remaining: Math.max(0, budget - count) }
}

/** Returns true if a vision call is allowed, and increments counter */
export function consumeVisionBudget(): boolean {
  const budget = parseInt(process.env.HYDRA_VISION_BUDGET ?? '50', 10)
  const store = readUsage()
  if (store.count >= budget) return false
  store.count++
  writeUsage(store)
  return true
}
