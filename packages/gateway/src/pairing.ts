// Pairing / security codes for unknown senders.
// Ported from OpenClaw src/pairing/pairing-store.ts
// Unknown sender → 8-char code → owner approves → added to allowFrom list.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 8
const TTL_MS = 60 * 60 * 1000 // 1 hour
const MAX_PENDING = 3

const stateDir = path.join(os.homedir(), '.hydra', 'pairing')
fs.mkdirSync(stateDir, { recursive: true })

type AllowFromStore = { version: 1; allowFrom: string[] }
type PairingRequest = { id: string; code: string; createdAt: string; expiresAt: string }
type PairingStore = { version: 1; requests: PairingRequest[] }

function allowPath(channelId: string) {
  return path.join(stateDir, `${channelId}-allowFrom.json`)
}
function pairingPath(channelId: string) {
  return path.join(stateDir, `${channelId}-pairing.json`)
}

function readJson<T>(p: string, def: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return def }
}
function writeJson(p: string, val: unknown) {
  fs.writeFileSync(p + '.tmp', JSON.stringify(val, null, 2))
  fs.renameSync(p + '.tmp', p) // atomic
}

function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LEN; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return code
}

/** Returns true if senderId is on the allowFrom list for this channel */
export function isAllowed(channelId: string, senderId: string): boolean {
  // Check HYDRA_OWNER_IDS env var — owners always allowed
  const owners = (process.env.HYDRA_OWNER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (owners.some((o) => o === `${channelId}:${senderId}` || o === senderId)) return true

  const store = readJson<AllowFromStore>(allowPath(channelId), { version: 1, allowFrom: [] })
  return store.allowFrom.includes(senderId)
}

/** Issue a pairing code for an unknown sender. Returns { code, isNew } */
export function upsertPairingRequest(channelId: string, senderId: string): { code: string; isNew: boolean } {
  const store = readJson<PairingStore>(pairingPath(channelId), { version: 1, requests: [] })
  const now = Date.now()

  // Prune expired
  store.requests = store.requests.filter((r) => new Date(r.expiresAt).getTime() > now)

  // Existing pending?
  const existing = store.requests.find((r) => r.id === senderId)
  if (existing) return { code: existing.code, isNew: false }

  // Enforce max pending
  if (store.requests.length >= MAX_PENDING) {
    return { code: store.requests[0].code, isNew: false }
  }

  const code = generateCode()
  store.requests.push({
    id: senderId,
    code,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  })
  writeJson(pairingPath(channelId), store)
  return { code, isNew: true }
}

/** Owner approves a pairing code — adds sender to allowFrom, removes pending request */
export function approvePairing(channelId: string, code: string): { ok: boolean; senderId?: string } {
  const store = readJson<PairingStore>(pairingPath(channelId), { version: 1, requests: [] })
  const now = Date.now()
  store.requests = store.requests.filter((r) => new Date(r.expiresAt).getTime() > now)

  const req = store.requests.find((r) => r.code.toUpperCase() === code.toUpperCase())
  if (!req) return { ok: false }

  store.requests = store.requests.filter((r) => r.id !== req.id)
  writeJson(pairingPath(channelId), store)

  const allow = readJson<AllowFromStore>(allowPath(channelId), { version: 1, allowFrom: [] })
  if (!allow.allowFrom.includes(req.id)) allow.allowFrom.push(req.id)
  writeJson(allowPath(channelId), allow)

  return { ok: true, senderId: req.id }
}

/** Remove a sender from allowFrom (revoke access) */
export function revokePairing(channelId: string, senderId: string): boolean {
  const allow = readJson<AllowFromStore>(allowPath(channelId), { version: 1, allowFrom: [] })
  const before = allow.allowFrom.length
  allow.allowFrom = allow.allowFrom.filter((id) => id !== senderId)
  writeJson(allowPath(channelId), allow)
  return allow.allowFrom.length < before
}

/** List pending pairing requests for a channel */
export function listPendingRequests(channelId: string): PairingRequest[] {
  const store = readJson<PairingStore>(pairingPath(channelId), { version: 1, requests: [] })
  const now = Date.now()
  return store.requests.filter((r) => new Date(r.expiresAt).getTime() > now)
}
