// Intent classifier + model router.
// Routes messages to the right execution path based on content.

export type Intent = 'code' | 'chat' | 'vision' | 'computer' | 'fast'

const CODE_PATTERNS = [
  /\b(fix|debug|refactor|implement|write|create|build|add|remove|change|update)\b.*\b(function|class|method|file|code|script|bug|error|test)\b/i,
  /\.(ts|js|py|go|rs|java|cpp|c|rb|php|swift|kt)\b/,
  /\b(git|npm|pnpm|yarn|docker|kubernetes|sql|api|endpoint|database|schema)\b/i,
  /```/, // code block
]

const COMPUTER_PATTERNS = [
  /\b(click|open|close|drag|scroll|type into|screenshot|screen shot|desktop|window)\b/i,
  /\b(open app|launch|switch to|focus on|move the)\b/i,
  /\b(what('s| is) on (my )?screen|what do you see)\b/i,
  /\b(browse to|navigate to|go to) (https?:\/\/|\w)/i,
]

/** Classify message intent */
export function classifyIntent(text: string, hasImages: boolean): Intent {
  const t = text.trim()

  // Explicit overrides
  if (t.startsWith('/fast ') || t === '/fast') return 'fast'
  if (t.startsWith('/code ') || t === '/code') return 'code'
  if (t.startsWith('/computer ') || t === '/computer') return 'computer'

  if (hasImages) return 'vision'

  if (COMPUTER_PATTERNS.some((p) => p.test(t))) return 'computer'
  if (CODE_PATTERNS.some((p) => p.test(t))) return 'code'

  return 'chat'
}

/** Strip leading /fast /code /computer prefix from prompt */
export function stripIntentPrefix(text: string): string {
  return text.replace(/^\/(?:fast|code|computer)\s*/i, '').trim()
}
