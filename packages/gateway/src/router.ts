// Intent classifier + model router.
// Routes messages to the right execution path and the right model.

export type Intent = 'code' | 'chat' | 'vision' | 'computer' | 'fast' | 'research' | 'reason'

// Maps intent → Ollama Cloud model to use
export const OLLAMA_INTENT_MODELS: Record<string, string> = {
  code:     'devstral-2:123b',      // Mistral's coding specialist
  research: 'nemotron-3-super',     // 120B MoE, 256K context
  reason:   'deepseek-v3.2',        // deep reasoning / hard problems
  chat:     'nemotron-3-super',     // default for general chat via Ollama
  vision:   'llava-v1.6',           // vision model for image understanding
}

const CODE_PATTERNS = [
  /\b(fix|debug|refactor|implement|write|create|build|add|remove|change|update)\b.*\b(function|class|method|file|code|script|bug|error|test)\b/i,
  /\.(ts|js|py|go|rs|java|cpp|c|rb|php|swift|kt)\b/,
  /\b(git|npm|pnpm|yarn|docker|kubernetes|sql|api|endpoint|database|schema)\b/i,
  /```/, // code block
  // Self-improvement patterns
  /\b(improve|update|modify|change|edit|add|fix|upgrade)\s+(your(self)?|your\s+(code|source|bot|gateway|router|system|prompt|behavior|response))/i,
  /\byour\s+(code|source|codebase|implementation|logic|behavior)\b/i,
  /\b(add|create|implement)\s+a?\s*\/([\w-]+)\s+(command|feature)/i,
  /\bself[- ]?(improve|cod|modif|updat)/i,
  /\b(make yourself|teach yourself|update yourself)\b/i,
]

const RESEARCH_PATTERNS = [
  /\b(research|investigate|find out|look up|analyze|analyse|summarize|summarise|explain in depth|deep dive)\b/i,
  /\b(what is|what are|who is|history of|overview of|tell me about|compare|pros and cons)\b.{20,}/i,
  /\b(read (this|these)|summarize (this|these|the))\b/i,
  /https?:\/\//,   // URL — fetch + analyze
]

const REASON_PATTERNS = [
  /\b(think through|reason about|figure out|solve|work out|calculate|deduce|analyze)\b/i,
  /\b(why does|how does|explain why|explain how)\b.{20,}/i,
  /\b(best (way|approach|strategy|option)|pros and cons|trade-?off|compare .+ vs)\b/i,
  /\b(plan|design|architect|decide|choose between)\b/i,
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

  // Explicit prefix overrides
  if (t.startsWith('/fast ') || t === '/fast') return 'fast'
  if (t.startsWith('/code ') || t === '/code') return 'code'
  if (t.startsWith('/computer ') || t === '/computer') return 'computer'
  if (t.startsWith('/research ') || t === '/research') return 'research'
  if (t.startsWith('/reason ') || t === '/reason') return 'reason'
  if (t.startsWith('/deep ') || t === '/deep') return 'reason'

  if (hasImages) return 'vision'

  if (COMPUTER_PATTERNS.some((p) => p.test(t))) return 'computer'
  if (CODE_PATTERNS.some((p) => p.test(t))) return 'code'
  if (RESEARCH_PATTERNS.some((p) => p.test(t))) return 'research'
  if (REASON_PATTERNS.some((p) => p.test(t))) return 'reason'

  return 'chat'
}

/** Get the Ollama model to use for a given intent (if Ollama Cloud is active) */
export function getOllamaModelForIntent(intent: Intent): string | undefined {
  return OLLAMA_INTENT_MODELS[intent]
}

/** Strip leading intent prefix (/fast, /code, /computer, /research, /reason, /deep, /chat, /vision) */
export function stripIntentPrefix(text: string): string {
  return text.replace(/^\/(?:fast|code|computer|research|reason|deep|chat|vision)\s*/i, '').trim()
}
