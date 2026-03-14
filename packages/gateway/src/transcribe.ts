// Voice transcription — converts audio (ogg/mp3/mp4) to text.
// Priority: 1) Groq Whisper API (GROQ_API_KEY — free tier)
//           2) OpenAI Whisper API (OPENAI_API_KEY)
//           3) null — bot sends friendly "transcription not configured" message

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createLogger } from './logger.js'

const log = createLogger('transcribe')

const MEDIA_MAX_BYTES = 25 * 1024 * 1024 // 25 MB Groq/OpenAI limit

export async function transcribeAudio(base64Audio: string, mimeType: string): Promise<string | null> {
  const groqKey = process.env.GROQ_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (!groqKey && !openaiKey) return null

  const ext = mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3'
    : mimeType.includes('mp4') ? 'mp4'
    : mimeType.includes('webm') ? 'webm'
    : 'ogg'

  const tmpInput = path.join(os.tmpdir(), `hydra-voice-${Date.now()}.${ext}`)
  const tmpWav   = path.join(os.tmpdir(), `hydra-voice-${Date.now()}.wav`)

  try {
    const buf = Buffer.from(base64Audio, 'base64')
    if (buf.length > MEDIA_MAX_BYTES) {
      log.warn(`Voice file too large: ${buf.length} bytes`)
      return null
    }
    fs.writeFileSync(tmpInput, buf)

    // Convert to 16kHz mono WAV for best transcription accuracy
    let audioPath = tmpInput
    try {
      execSync(`ffmpeg -y -i "${tmpInput}" -ar 16000 -ac 1 -c:a pcm_s16le "${tmpWav}" 2>/dev/null`, { timeout: 15000 })
      if (fs.existsSync(tmpWav)) audioPath = tmpWav
    } catch {
      log.debug('ffmpeg conversion failed, using original audio')
    }

    if (groqKey)  return await transcribeWithAPI(audioPath, groqKey,  'https://api.groq.com/openai/v1/audio/transcriptions', 'whisper-large-v3-turbo')
    if (openaiKey) return await transcribeWithAPI(audioPath, openaiKey, 'https://api.openai.com/v1/audio/transcriptions', 'whisper-1')
    return null
  } finally {
    try { fs.unlinkSync(tmpInput) } catch {}
    try { fs.unlinkSync(tmpWav)   } catch {}
  }
}

async function transcribeWithAPI(filePath: string, apiKey: string, url: string, model: string): Promise<string | null> {
  try {
    const fileBuffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).slice(1) || 'wav'
    const blob = new Blob([fileBuffer], { type: `audio/${ext}` })

    const form = new FormData()
    form.append('file', blob, `audio.${ext}`)
    form.append('model', model)
    form.append('response_format', 'text')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      })
      if (!res.ok) {
        log.warn(`Transcription API ${url} returned ${res.status}: ${await res.text()}`)
        return null
      }
      const text = (await res.text()).trim()
      log.info(`Transcribed ${fileBuffer.length} bytes → "${text.slice(0, 80)}"`)
      return text || null
    } finally {
      clearTimeout(timeout)
    }
  } catch (e) {
    log.warn(`Transcription error: ${e}`)
    return null
  }
}

export function isTranscriptionConfigured(): boolean {
  return !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY)
}
