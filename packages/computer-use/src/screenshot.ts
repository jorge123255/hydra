import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TMP_DIR = path.join(os.tmpdir(), 'hydra-screenshots')
fs.mkdirSync(TMP_DIR, { recursive: true })

export type ScreenshotResult = {
  base64: string
  mimeType: string
  width?: number
  height?: number
  path: string
}

/** Take a screenshot of the full screen. Returns base64-encoded JPEG. */
export async function takeScreenshot(screenIndex = 0): Promise<ScreenshotResult> {
  const outPath = path.join(TMP_DIR, `shot-${Date.now()}.jpg`)
  // -x = no sound, -t = capture type, screen index via display flag
  await execFileAsync('screencapture', ['-x', '-t', 'jpg', outPath])
  const data = fs.readFileSync(outPath)
  const base64 = data.toString('base64')
  // Clean up after 60s
  setTimeout(() => fs.unlink(outPath, () => {}), 60_000)
  return { base64, mimeType: 'image/jpeg', path: outPath }
}

/** Take a screenshot and return as data URL */
export async function screenshotAsDataUrl(screenIndex = 0): Promise<string> {
  const { base64, mimeType } = await takeScreenshot(screenIndex)
  return `data:${mimeType};base64,${base64}`
}
