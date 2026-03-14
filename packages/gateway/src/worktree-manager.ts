// Worktree manager — per-thread git worktrees so parallel sessions
// don't stomp each other's working trees.
// Ported from Kimaki's worktrees.ts, generalized for any channel.
// Phase 10: createFromPR() for GitHub PR worktrees.

import { exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from './logger.js'

const execAsync = promisify(exec)
const log = createLogger('worktree')

const EXEC_TIMEOUT_MS = 10_000
const SUBMODULE_TIMEOUT_MS = 20 * 60_000

export type WorktreeInfo = {
  name: string
  directory: string
  branch: string
  baseDirectory: string
  prNumber?: number
}

// Lockfile → install command detection (from Kimaki)
const LOCKFILE_COMMANDS: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm install'],
]

function detectInstallCommand(directory: string): string | null {
  for (const [lockfile, cmd] of LOCKFILE_COMMANDS) {
    if (fs.existsSync(path.join(directory, lockfile))) return cmd
  }
  return null
}

async function run(
  command: string,
  cwd: string,
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, { cwd, timeout: timeoutMs })
}

async function resolveDefaultBranch(directory: string): Promise<string> {
  try {
    const { stdout } = await run('git symbolic-ref refs/remotes/origin/HEAD', directory)
    const branch = stdout.trim().replace('refs/remotes/origin/', '')
    if (branch) return `origin/${branch}`
  } catch {}

  for (const branch of ['main', 'master', 'develop']) {
    try {
      await run(`git show-ref --verify --quiet refs/heads/${branch}`, directory)
      return branch
    } catch {}
  }
  return 'HEAD'
}

function getManagedWorktreeDir(baseDirectory: string, name: string): string {
  return path.join(baseDirectory, '.hydra-worktrees', name)
}

export async function createWorktree({
  baseDirectory,
  name,
  baseBranch,
}: {
  baseDirectory: string
  name: string
  baseBranch?: string
}): Promise<WorktreeInfo | Error> {
  const worktreeDir = getManagedWorktreeDir(baseDirectory, name)

  if (fs.existsSync(worktreeDir)) {
    log.debug(`Worktree already exists: ${worktreeDir}`)
    const { stdout } = await run('git branch --show-current', worktreeDir)
    return { name, directory: worktreeDir, branch: stdout.trim(), baseDirectory }
  }

  const targetRef = baseBranch ?? (await resolveDefaultBranch(baseDirectory))
  await fs.promises.mkdir(path.dirname(worktreeDir), { recursive: true })

  log.info(`Creating worktree '${name}' from ${targetRef}`)

  try {
    await run(
      `git worktree add ${JSON.stringify(worktreeDir)} -B ${JSON.stringify(name)} ${JSON.stringify(targetRef)}`,
      baseDirectory,
      SUBMODULE_TIMEOUT_MS,
    )
  } catch (err) {
    return new Error(`git worktree add failed: ${String(err)}`)
  }

  // Init submodules if present
  const gitmodules = path.join(baseDirectory, '.gitmodules')
  if (fs.existsSync(gitmodules)) {
    log.info(`Initializing submodules in ${worktreeDir}`)
    try {
      await run('git submodule update --init --recursive', worktreeDir, SUBMODULE_TIMEOUT_MS)
    } catch (err) {
      log.warn(`Submodule init failed (non-fatal): ${String(err)}`)
    }
  }

  // Run install if lockfile found
  const installCmd = detectInstallCommand(baseDirectory)
  if (installCmd) {
    log.info(`Running '${installCmd}' in worktree`)
    try {
      await run(installCmd, worktreeDir, SUBMODULE_TIMEOUT_MS)
    } catch (err) {
      log.warn(`Install failed (non-fatal): ${String(err)}`)
    }
  }

  const { stdout: branch } = await run('git branch --show-current', worktreeDir)
  log.info(`Worktree ready: ${worktreeDir} (branch: ${branch.trim()})`)

  return { name, directory: worktreeDir, branch: branch.trim(), baseDirectory }
}

/** Phase 10: Checkout a GitHub PR into its own worktree.
 *  Requires: `gh` CLI in PATH and GITHUB_TOKEN env var. */
export async function createFromPR({
  baseDirectory,
  prNumber,
}: {
  baseDirectory: string
  prNumber: number
}): Promise<WorktreeInfo | Error> {
  const name = `pr-${prNumber}`
  const worktreeDir = getManagedWorktreeDir(baseDirectory, name)

  // If worktree already exists just return it
  if (fs.existsSync(worktreeDir)) {
    const { stdout } = await run('git branch --show-current', worktreeDir).catch(() => ({ stdout: name }))
    log.info(`PR worktree already exists: ${worktreeDir}`)
    return { name, directory: worktreeDir, branch: stdout.trim(), baseDirectory, prNumber }
  }

  await fs.promises.mkdir(path.dirname(worktreeDir), { recursive: true })

  // Use `gh pr checkout` to fetch + checkout the PR branch
  log.info(`Checking out PR #${prNumber} into worktree ${worktreeDir}`)
  try {
    const env = process.env.GITHUB_TOKEN ? `GITHUB_TOKEN=${process.env.GITHUB_TOKEN} ` : ''
    await run(
      `${env}gh pr checkout ${prNumber} --force -b ${JSON.stringify(name)}`,
      baseDirectory,
      EXEC_TIMEOUT_MS * 3,
    )
  } catch (err) {
    return new Error(`gh pr checkout failed: ${String(err)}`)
  }

  // Move checked-out branch into a worktree
  try {
    await run(
      `git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(name)}`,
      baseDirectory,
      EXEC_TIMEOUT_MS * 2,
    )
  } catch (err) {
    return new Error(`git worktree add (PR) failed: ${String(err)}`)
  }

  const installCmd = detectInstallCommand(baseDirectory)
  if (installCmd) {
    try { await run(installCmd, worktreeDir, SUBMODULE_TIMEOUT_MS) }
    catch (err) { log.warn(`Install failed in PR worktree (non-fatal): ${String(err)}`) }
  }

  log.info(`PR #${prNumber} worktree ready: ${worktreeDir}`)
  return { name, directory: worktreeDir, branch: name, baseDirectory, prNumber }
}

export async function deleteWorktree({
  baseDirectory,
  name,
}: {
  baseDirectory: string
  name: string
}): Promise<void> {
  const worktreeDir = getManagedWorktreeDir(baseDirectory, name)
  if (!fs.existsSync(worktreeDir)) return

  log.info(`Deleting worktree '${name}'`)
  try {
    await run(`git worktree remove --force ${JSON.stringify(worktreeDir)}`, baseDirectory)
  } catch {
    await fs.promises.rm(worktreeDir, { recursive: true, force: true })
  }

  await run('git worktree prune', baseDirectory).catch(() => {})
}

export async function isGitRepo(directory: string): Promise<boolean> {
  try {
    await run('git rev-parse --git-dir', directory)
    return true
  } catch {
    return false
  }
}

/** Get the diff of a worktree vs HEAD */
export async function getWorktreeDiff(directory: string): Promise<string> {
  try {
    const { stdout } = await run('git diff HEAD', directory, 30_000)
    return stdout || '(no changes vs HEAD)'
  } catch (err) {
    return `Error getting diff: ${String(err)}`
  }
}

/** Stash pop (rollback) in a worktree */
export async function rollbackWorktree(directory: string): Promise<string> {
  try {
    const { stdout } = await run('git stash pop', directory, 15_000)
    return stdout || '✅ Stash popped'
  } catch (err) {
    return `Error rolling back: ${String(err)}`
  }
}
