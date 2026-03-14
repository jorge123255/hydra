import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Run an AppleScript and return its stdout */
export async function runAppleScript(script: string, timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs })
  return stdout.trim()
}

/** Get a list of currently visible application names */
export async function getVisibleApps(): Promise<string[]> {
  const result = await runAppleScript(
    'tell application "System Events" to get name of every process whose visible is true'
  )
  return result.split(', ').map((s) => s.trim()).filter(Boolean)
}

/** Get the name of the frontmost (focused) application */
export async function getFrontApp(): Promise<string> {
  return runAppleScript(
    'tell application "System Events" to get name of first process whose frontmost is true'
  )
}

/** Get the title of the frontmost window of an app */
export async function getWindowTitle(appName: string): Promise<string> {
  return runAppleScript(
    `tell application "${appName}" to get name of front window`
  ).catch(() => '')
}

/** Activate (focus) an application */
export async function activateApp(appName: string): Promise<void> {
  await runAppleScript(`tell application "${appName}" to activate`)
}

/** Send a keystroke to the frontmost app */
export async function sendKeystroke(key: string, modifiers: string[] = []): Promise<void> {
  const mods = modifiers.length
    ? `using {${modifiers.map((m) => `${m} down`).join(', ')}}`
    : ''
  await runAppleScript(`tell application "System Events" to keystroke "${key}" ${mods}`)
}

/** Send a key code to the frontmost app (for special keys) */
export async function sendKeyCode(code: number, modifiers: string[] = []): Promise<void> {
  const mods = modifiers.length
    ? `using {${modifiers.map((m) => `${m} down`).join(', ')}}`
    : ''
  await runAppleScript(`tell application "System Events" to key code ${code} ${mods}`)
}
