// OpenCode server lifecycle manager.
// Ported from Kimaki's opencode.ts — ONE shared server process for all directories.
// Sessions are scoped per-directory via x-opencode-directory header.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { createLogger } from './logger.js'

const log = createLogger('opencode-server')

type SingleServer = {
  process: ChildProcess
  port: number
  baseUrl: string
}

let singleServer: SingleServer | null = null
let startingServer: Promise<SingleServer> | null = null

// Client cache per directory — avoids re-creating on every message
const clientCache = new Map<string, OpencodeClient>()

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        server.close(() => resolve(addr.port))
      } else {
        reject(new Error('Failed to get open port'))
      }
    })
    server.on('error', reject)
  })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/api/health`
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(endpoint)
      if (res.status < 500) return
    } catch {
      // connection refused — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`OpenCode server on port ${port} did not become ready after ${maxAttempts}s`)
}

function resolveOpencodeCommand(): string {
  try {
    const output = execFileSync('which', ['opencode'], { encoding: 'utf8', timeout: 5000 })
    const resolved = output.trim().split('\n')[0]?.trim()
    if (resolved) return resolved
  } catch {}
  return 'opencode'
}

async function startSingleServer(): Promise<SingleServer> {
  const port = await getOpenPort()
  const cmd = resolveOpencodeCommand()

  log.info(`Starting opencode server on port ${port} (${cmd})`)

  const proc = spawn(cmd, ['serve', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    log.debug(`[opencode stderr] ${chunk.toString().trim()}`)
  })

  proc.on('exit', (code, signal) => {
    log.warn(`OpenCode server exited (code=${code} signal=${signal})`)
    singleServer = null
    clientCache.clear()
  })

  await waitForServer(port)

  const server: SingleServer = {
    process: proc,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  }

  log.info(`OpenCode server ready on port ${port}`)
  return server
}

export async function ensureServer(): Promise<SingleServer> {
  if (singleServer && !singleServer.process.killed) return singleServer

  if (startingServer) return startingServer

  startingServer = startSingleServer().then((s) => {
    singleServer = s
    return s
  }).finally(() => {
    startingServer = null
  })

  return startingServer
}

export async function getClient(directory: string): Promise<OpencodeClient> {
  const server = await ensureServer()
  const cached = clientCache.get(directory)
  if (cached) return cached

  const client = createOpencodeClient({
    baseUrl: server.baseUrl,
    directory,
  })
  clientCache.set(directory, client)
  return client
}

export async function stopServer(): Promise<void> {
  if (singleServer && !singleServer.process.killed) {
    singleServer.process.kill('SIGTERM')
    singleServer = null
    clientCache.clear()
  }
}
