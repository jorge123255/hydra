// Cron/scheduled task system — ported from OpenClaw's src/cron/
// Allows any channel to schedule recurring or one-shot tasks.
// Usage: "remind me every day at 9am to check deployments"

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('scheduler')

export type TaskSchedule =
  | { type: 'cron'; expr: string; tz?: string }      // e.g. "0 9 * * *"
  | { type: 'once'; at: Date }                         // one-shot ISO date

export type ScheduledTask = {
  id: string
  channelId: string
  threadId: string
  prompt: string
  schedule: TaskSchedule
  createdAt: Date
  lastRunAt?: Date
  nextRunAt: Date
  enabled: boolean
}

const CRON_PERSIST_FILE = process.env.HYDRA_DATA_DIR
  ? path.join(process.env.HYDRA_DATA_DIR, 'scheduled-tasks.json')
  : path.join(process.env.HOME ?? '~', '.hydra', 'scheduled-tasks.json')

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>()
  private timer?: NodeJS.Timeout
  private onFire: (task: ScheduledTask) => Promise<void>

  constructor(onFire: (task: ScheduledTask) => Promise<void>) {
    this.onFire = onFire
    this.load()
  }

  start(): void {
    // Check every minute
    this.timer = setInterval(() => this.tick(), 60_000)
    log.info(`Scheduler started — ${this.tasks.size} task(s) loaded`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  add(task: Omit<ScheduledTask, 'createdAt' | 'nextRunAt' | 'enabled'>): ScheduledTask {
    const full: ScheduledTask = {
      ...task,
      createdAt: new Date(),
      nextRunAt: this.computeNext(task.schedule),
      enabled: true,
    }
    this.tasks.set(full.id, full)
    this.save()
    log.info(`Scheduled task '${full.id}' (${full.channelId}:${full.threadId}) next run: ${full.nextRunAt.toISOString()}`)
    return full
  }

  remove(id: string): boolean {
    const removed = this.tasks.delete(id)
    if (removed) this.save()
    return removed
  }

  list(channelId?: string, threadId?: string): ScheduledTask[] {
    return Array.from(this.tasks.values()).filter((t) => {
      if (channelId && t.channelId !== channelId) return false
      if (threadId && t.threadId !== threadId) return false
      return true
    })
  }

  private async tick(): Promise<void> {
    const now = new Date()
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue
      if (task.nextRunAt > now) continue

      log.info(`Firing task '${task.id}' for ${task.channelId}:${task.threadId}`)
      task.lastRunAt = now

      // One-shot — disable after firing
      if (task.schedule.type === 'once') {
        task.enabled = false
      } else {
        task.nextRunAt = this.computeNext(task.schedule)
      }

      this.save()
      await this.onFire(task).catch((e) => log.error(`Task ${task.id} error:`, e))
    }
  }

  private computeNext(schedule: TaskSchedule): Date {
    if (schedule.type === 'once') return schedule.at

    // Basic cron parsing — handles "* * * * *" format
    // For production use, replace with croner package like OpenClaw
    try {
      return this.nextCronDate(schedule.expr, schedule.tz)
    } catch {
      return new Date(Date.now() + 60_000)
    }
  }

  private nextCronDate(expr: string, _tz?: string): Date {
    // Simple next-minute placeholder — wire up `croner` for full cron support
    const parts = expr.split(' ')
    const now = new Date()
    const next = new Date(now)
    next.setSeconds(0, 0)
    next.setMinutes(next.getMinutes() + 1)

    // Respect minute field if not wildcard
    if (parts[0] && parts[0] !== '*') {
      const minute = parseInt(parts[0])
      if (!isNaN(minute)) {
        next.setMinutes(minute)
        if (next <= now) next.setHours(next.getHours() + 1)
      }
    }
    // Respect hour field if not wildcard
    if (parts[1] && parts[1] !== '*') {
      const hour = parseInt(parts[1])
      if (!isNaN(hour)) {
        next.setHours(hour)
        if (next <= now) next.setDate(next.getDate() + 1)
      }
    }
    return next
  }

  private load(): void {
    try {
      if (!fs.existsSync(CRON_PERSIST_FILE)) return
      const data = JSON.parse(fs.readFileSync(CRON_PERSIST_FILE, 'utf-8')) as ScheduledTask[]
      for (const t of data) {
        t.createdAt = new Date(t.createdAt)
        t.nextRunAt = new Date(t.nextRunAt)
        if (t.lastRunAt) t.lastRunAt = new Date(t.lastRunAt)
        if (t.schedule.type === 'once') t.schedule.at = new Date(t.schedule.at)
        this.tasks.set(t.id, t)
      }
    } catch (e) {
      log.warn(`Could not load scheduled tasks: ${e}`)
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(CRON_PERSIST_FILE), { recursive: true })
      fs.writeFileSync(CRON_PERSIST_FILE, JSON.stringify(Array.from(this.tasks.values()), null, 2))
    } catch (e) {
      log.warn(`Could not save scheduled tasks: ${e}`)
    }
  }
}
