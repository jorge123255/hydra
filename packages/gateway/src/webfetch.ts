// Lightweight web page fetcher — strips HTML, truncates, returns readable text.
// Used to give the bot real-time web content when URLs appear in messages.

import { createLogger } from './logger.js'

const log = createLogger('webfetch')

const MAX_CONTENT_CHARS = 4000
const FETCH_TIMEOUT_MS  = 15_000

// Tags whose entire content we drop (scripts, styles, nav, etc.)
const DROP_TAG_RE = /<(script|style|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi
// All remaining HTML tags
const HTML_TAG_RE = /<[^>]+>/g
// Excessive whitespace
const WHITESPACE_RE = /[ \t]{2,}/g
const NEWLINE_RE    = /\n{3,}/g

/** Extract all http/https URLs from a string */
export function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"')\]]+/g
  const matches = text.match(re) ?? []
  // Deduplicate and ignore common non-content URLs
  return [...new Set(matches)].filter((u) => !u.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf)(\?|$)/i))
}

/** Fetch a URL and return cleaned text content */
export async function fetchWebPage(url: string): Promise<{ title: string; text: string; url: string } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HydraBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    })

    if (!res.ok) {
      log.debug(`Fetch ${url} → ${res.status}`)
      return null
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      log.debug(`Skipping non-text content: ${contentType}`)
      return null
    }

    const html = await res.text()

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : url

    // Strip unwanted sections + tags
    const cleaned = html
      .replace(DROP_TAG_RE, ' ')
      .replace(HTML_TAG_RE, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
      .replace(WHITESPACE_RE, ' ')
      .replace(NEWLINE_RE, '\n\n')
      .trim()

    const truncated = cleaned.length > MAX_CONTENT_CHARS
      ? cleaned.slice(0, MAX_CONTENT_CHARS) + `\n...[truncated — ${cleaned.length} chars total]`
      : cleaned

    return { title, text: truncated, url }
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') log.debug(`fetchWebPage error for ${url}: ${e}`)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Build a context block to prepend to the prompt when URLs are detected */
export async function buildWebContext(urls: string[]): Promise<string> {
  if (!urls.length) return ''
  const blocks: string[] = []
  // Fetch up to 2 URLs in parallel
  const results = await Promise.all(urls.slice(0, 2).map(fetchWebPage))
  for (const result of results) {
    if (result) {
      blocks.push(`[Web: ${result.title}]\nURL: ${result.url}\n\n${result.text}`)
    }
  }
  return blocks.length ? blocks.join('\n\n---\n\n') + '\n\n' : ''
}
