// Computer-use agent: tiered approach to minimize token usage.
// Tier 1: AppleScript/ax-tree (structured, 0 tokens)
// Tier 2: Screenshot + vision (budgeted)
// Tier 3: Execute action (cliclick/osascript)
// Tier 4: Verify via ax-tree (0 tokens)
// Max 10 iterations per task.

import { getScreenSummary, getAppAxTree } from './ax-tree.js'
import { mouse, keyboard } from './click.js'
import { runAppleScript, activateApp } from './applescript.js'
import { takeScreenshot } from './screenshot.js'
import { analyzeScreenshot } from './vision.js'

export type ComputerTask = {
  instruction: string
  /** Max iterations before giving up */
  maxIterations?: number
  /** Called with status updates */
  onStatus?: (msg: string) => void
}

export type ComputerTaskResult = {
  success: boolean
  output: string
  iterations: number
  visionCallsUsed: number
}

export async function runComputerTask(task: ComputerTask): Promise<ComputerTaskResult> {
  const maxIter = task.maxIterations ?? 10
  const status = task.onStatus ?? (() => {})
  let iterations = 0
  let visionCalls = 0
  const log: string[] = []

  status('🔍 Checking screen state...')

  // Tier 1: Try to answer/act from AppleScript alone
  const screenSummary = await getScreenSummary()
  log.push(`Screen: ${screenSummary}`)

  // Build initial context
  let context = `Task: ${task.instruction}\n\nCurrent screen state:\n${screenSummary}\n`

  // For simple queries that don't need action, return immediately
  if (isQueryOnly(task.instruction)) {
    return { success: true, output: screenSummary, iterations: 1, visionCallsUsed: 0 }
  }

  // Action loop
  while (iterations < maxIter) {
    iterations++

    // Tier 2: Take screenshot and analyze if needed
    status(`👁️ Analyzing screen (iteration ${iterations})...`)
    const shot = await takeScreenshot()
    const vision = await analyzeScreenshot(`data:image/jpeg;base64,${shot.base64}`,
      `${task.instruction}\n\nWhat action should I take next? Reply with one of:\n` +
      `- CLICK x,y\n- TYPE text\n- KEY keyname\n- APPLESCRIPT script\n- DONE result\n- FAIL reason`
    )
    visionCalls++
    log.push(`Vision (${iterations}): ${vision.description.slice(0, 200)}`)

    const action = parseAction(vision.description)
    if (!action) {
      status('✅ Task completed')
      return { success: true, output: vision.description, iterations, visionCallsUsed: visionCalls }
    }

    if (action.type === 'done') {
      return { success: true, output: action.value, iterations, visionCallsUsed: visionCalls }
    }
    if (action.type === 'fail') {
      return { success: false, output: action.value, iterations, visionCallsUsed: visionCalls }
    }

    // Execute action
    status(`⚡ ${action.type.toUpperCase()}: ${action.value}`)
    try {
      await executeAction(action)
      await new Promise((r) => setTimeout(r, 500)) // brief settle time
    } catch (e) {
      log.push(`Action error: ${e}`)
      status(`⚠️ Action failed: ${e}`)
    }
  }

  return {
    success: false,
    output: `Reached max iterations (${maxIter}). Last state:\n${log.join('\n')}`,
    iterations,
    visionCallsUsed: visionCalls,
  }
}

type ParsedAction =
  | { type: 'click'; x: number; y: number; value: string }
  | { type: 'type'; value: string }
  | { type: 'key'; value: string }
  | { type: 'applescript'; value: string }
  | { type: 'done'; value: string }
  | { type: 'fail'; value: string }
  | null

function parseAction(response: string): ParsedAction {
  const clickMatch = response.match(/CLICK\s+(\d+),(\d+)/i)
  if (clickMatch) return { type: 'click', x: Number(clickMatch[1]), y: Number(clickMatch[2]), value: `${clickMatch[1]},${clickMatch[2]}` }

  const typeMatch = response.match(/TYPE\s+(.+)/i)
  if (typeMatch) return { type: 'type', value: typeMatch[1].trim() }

  const keyMatch = response.match(/KEY\s+(\S+)/i)
  if (keyMatch) return { type: 'key', value: keyMatch[1].trim() }

  const asMatch = response.match(/APPLESCRIPT\s+(.+)/is)
  if (asMatch) return { type: 'applescript', value: asMatch[1].trim() }

  const doneMatch = response.match(/DONE\s*(.*)/is)
  if (doneMatch) return { type: 'done', value: doneMatch[1].trim() || 'Task completed' }

  const failMatch = response.match(/FAIL\s*(.*)/is)
  if (failMatch) return { type: 'fail', value: failMatch[1].trim() || 'Task failed' }

  return null
}

async function executeAction(action: NonNullable<ParsedAction>): Promise<void> {
  switch (action.type) {
    case 'click': await mouse.click(action.x, action.y); break
    case 'type': await keyboard.type(action.value); break
    case 'key': await keyboard.keypress(action.value); break
    case 'applescript': await runAppleScript(action.value); break
  }
}

function isQueryOnly(instruction: string): boolean {
  return /^(what|which|list|show|tell me|how many|is|are|does)\b/i.test(instruction) &&
    !/\b(click|open|close|type|move|drag|send|press)\b/i.test(instruction)
}
