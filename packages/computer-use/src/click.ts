import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function cliclick(...args: string[]): Promise<void> {
  await execFileAsync('cliclick', args)
}

export const mouse = {
  click: (x: number, y: number) => cliclick(`c:${x},${y}`),
  doubleClick: (x: number, y: number) => cliclick(`dc:${x},${y}`),
  rightClick: (x: number, y: number) => cliclick(`rc:${x},${y}`),
  move: (x: number, y: number) => cliclick(`m:${x},${y}`),
  scrollUp: (x: number, y: number, clicks = 3) => cliclick(`su:${x},${y}`, `=+${clicks}`),
  scrollDown: (x: number, y: number, clicks = 3) => cliclick(`sd:${x},${y}`, `=+${clicks}`),
}

export const keyboard = {
  type: (text: string) => cliclick(`t:${text}`),
  keypress: (key: string) => cliclick(`kp:${key}`),
  // Common keys: return, esc, tab, space, delete, up, down, left, right
  // Modifier combos: 'cmd+c', 'cmd+v', 'cmd+z'
  combo: async (keys: string) => {
    // e.g. keys = "cmd+c" → cliclick kp:cmd+c
    await cliclick(`kp:${keys}`)
  },
}
