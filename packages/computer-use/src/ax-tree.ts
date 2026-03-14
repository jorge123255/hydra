import { runAppleScript, getVisibleApps } from './applescript.js'

/** Get full accessibility tree of an app as text (0 vision tokens) */
export async function getAppAxTree(appName: string, maxDepth = 4): Promise<string> {
  try {
    // Get window contents
    const result = await runAppleScript(`
      tell application "System Events"
        tell process "${appName}"
          set output to ""
          repeat with w in windows
            set output to output & "Window: " & name of w & "\\n"
          end repeat
          return output
        end tell
      end tell
    `, 5_000)
    return result || `[App ${appName} has no accessible windows]`
  } catch {
    return `[Could not access ${appName} accessibility tree]`
  }
}

/** Get a brief summary of what's on screen using only AppleScript (0 vision tokens) */
export async function getScreenSummary(): Promise<string> {
  try {
    const [apps, frontApp] = await Promise.all([
      getVisibleApps(),
      runAppleScript('tell application "System Events" to get name of first process whose frontmost is true').catch(() => 'unknown'),
    ])
    const lines = [`Frontmost app: ${frontApp}`, `Visible apps: ${apps.join(', ')}`]

    // Try to get window title of frontmost app
    try {
      const title = await runAppleScript(`tell application "${frontApp}" to get name of front window`)
      if (title) lines.push(`Front window: ${title}`)
    } catch {}

    return lines.join('\n')
  } catch (e) {
    return `[Could not get screen summary: ${e}]`
  }
}
