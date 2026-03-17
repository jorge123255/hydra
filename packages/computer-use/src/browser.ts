// Browser automation via Playwright + Chrome CDP.
// Ported from OpenClaw's browser approach: ARIA snapshot first (0 tokens),
// screenshot + vision only when needed.
// Manages a single persistent browser session, auto-restarting on crash.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import * as path from 'path'
import * as os from 'os'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const USER_DATA_DIR = path.join(os.homedir(), '.hydra', 'browser-profile')

let browser: Browser | null = null
let context: BrowserContext | null = null
let activePage: Page | null = null

// ─── Session Management ───────────────────────────────────────────────────────

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser
  browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,      // visible — user can see what the bot is doing
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  })
  browser.on('disconnected', () => { browser = null; context = null; activePage = null })
  return browser
}

export async function getContext(): Promise<BrowserContext> {
  if (context) return context
  const b = await getBrowser()
  context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  })
  return context
}

export async function getPage(): Promise<Page> {
  if (activePage && !activePage.isClosed()) return activePage
  const ctx = await getContext()
  const pages = ctx.pages()
  activePage = pages.length > 0 ? pages[0] : await ctx.newPage()
  return activePage
}

export async function closeBrowser(): Promise<void> {
  await browser?.close()
  browser = null; context = null; activePage = null
}

// ─── Navigation ───────────────────────────────────────────────────────────────

export async function navigate(url: string): Promise<string> {
  const page = await getPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  return page.title()
}

export async function currentUrl(): Promise<string> {
  const page = await getPage()
  return page.url()
}

// ─── ARIA Snapshot (0 tokens, primary "see page" method) ─────────────────────
// Uses page.ariaSnapshot() introduced in Playwright 1.46 — returns YAML-like
// accessibility tree string, no token cost.

export async function ariaSnapshot(): Promise<string> {
  const page = await getPage()
  try {
    // page.ariaSnapshot() — Playwright 1.46+ API, returns structured text
    const snapshot = await (page as any).ariaSnapshot()
    if (snapshot && typeof snapshot === 'string') return snapshot
  } catch {
    // ignore, fall through to DOM extraction
  }
  // Fallback: extract key interactive elements from DOM
  return page.evaluate(() => {
    const els = document.querySelectorAll(
      'h1,h2,h3,button,a,input,select,textarea,label,[role="button"],[role="link"],[role="menuitem"]'
    )
    return Array.from(els).map(el => {
      const tag = el.tagName.toLowerCase()
      const text = (el as HTMLElement).innerText?.trim()
        || (el as HTMLInputElement).value
        || el.getAttribute('aria-label')
        || ''
      const href = (el as HTMLAnchorElement).href || ''
      if (!text && !href) return null
      return `[${tag}] ${text}${href ? ' → ' + href : ''}`
    }).filter(Boolean).slice(0, 150).join('\n')
  })
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function click(selector: string): Promise<void> {
  const page = await getPage()
  await page.click(selector, { timeout: 10000 })
}

export async function clickByText(text: string): Promise<void> {
  const page = await getPage()
  await page.getByText(text, { exact: false }).first().click({ timeout: 10000 })
}

export async function clickCoords(x: number, y: number): Promise<void> {
  const page = await getPage()
  await page.mouse.click(x, y)
}

export async function typeInto(selector: string, text: string, clear = true): Promise<void> {
  const page = await getPage()
  if (clear) await page.fill(selector, '')
  await page.type(selector, text, { delay: 30 })
}

export async function pressKey(key: string): Promise<void> {
  const page = await getPage()
  await page.keyboard.press(key)
}

export async function scrollPage(direction: 'up' | 'down', amount = 300): Promise<void> {
  const page = await getPage()
  await page.mouse.wheel(0, direction === 'down' ? amount : -amount)
}

export async function evaluate<T = unknown>(script: string): Promise<T> {
  const page = await getPage()
  return page.evaluate(script) as Promise<T>
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

export async function browserScreenshot(): Promise<string> {
  const page = await getPage()
  const buf = await page.screenshot({ type: 'jpeg', quality: 70 })
  return buf.toString('base64')
}

// ─── Action parsing/execution ─────────────────────────────────────────────────

export interface BrowseAction {
  type: 'navigate' | 'click' | 'type' | 'key' | 'scroll' | 'js' | 'done' | 'fail'
  target?: string   // selector or text
  value?: string    // for type/key/navigate/js
  x?: number; y?: number  // for click coords
}

export function parseBrowseAction(response: string): BrowseAction | null {
  if (/NAVIGATE\s+(https?:\/\/\S+)/i.test(response)) {
    return { type: 'navigate', value: response.match(/NAVIGATE\s+(https?:\/\/\S+)/i)![1] }
  }
  if (/CLICK_TEXT\s+"?([^"\n]+)"?/i.test(response)) {
    return { type: 'click', target: response.match(/CLICK_TEXT\s+"?([^"\n]+)"?/i)![1].trim() }
  }
  if (/CLICK\s+(\d+),(\d+)/i.test(response)) {
    const m = response.match(/CLICK\s+(\d+),(\d+)/i)!
    return { type: 'click', x: +m[1], y: +m[2] }
  }
  if (/TYPE\s+"([^"]+)"\s+INTO\s+(.+)/i.test(response)) {
    const m = response.match(/TYPE\s+"([^"]+)"\s+INTO\s+(.+)/i)!
    return { type: 'type', value: m[1], target: m[2].trim() }
  }
  if (/KEY\s+(\S+)/i.test(response)) {
    return { type: 'key', value: response.match(/KEY\s+(\S+)/i)![1] }
  }
  if (/SCROLL\s+(up|down)/i.test(response)) {
    return { type: 'scroll', value: response.match(/SCROLL\s+(up|down)/i)![1].toLowerCase() }
  }
  if (/JS\s+(.+)/is.test(response)) {
    return { type: 'js', value: response.match(/JS\s+(.+)/is)![1].trim() }
  }
  if (/DONE\s*(.*)/is.test(response)) {
    return { type: 'done', value: response.match(/DONE\s*(.*)/is)![1].trim() || 'Done' }
  }
  if (/FAIL\s*(.*)/is.test(response)) {
    return { type: 'fail', value: response.match(/FAIL\s*(.*)/is)![1].trim() || 'Failed' }
  }
  return null
}

export async function executeBrowseAction(action: BrowseAction): Promise<void> {
  switch (action.type) {
    case 'navigate':
      if (action.value) await navigate(action.value)
      break
    case 'click':
      if (action.x !== undefined && action.y !== undefined) await clickCoords(action.x, action.y)
      else if (action.target) await clickByText(action.target).catch(() => click(action.target!))
      break
    case 'type':
      if (action.target && action.value) await typeInto(action.target, action.value)
      break
    case 'key':
      if (action.value) await pressKey(action.value)
      break
    case 'scroll':
      await scrollPage(action.value === 'up' ? 'up' : 'down')
      break
    case 'js':
      if (action.value) await evaluate(action.value)
      break
  }
}
