import OpenAI from 'openai'
import { TranscriptSegment } from '../../shared/types'
import { getSettings } from '../settings'

let client: OpenAI | null = null
let clientKey = ''

function getClient(): OpenAI {
  const { openaiApiKey } = getSettings()
  if (!openaiApiKey) throw new Error('OpenAI API key not configured — open Settings.')
  if (!client || clientKey !== openaiApiKey) {
    client = new OpenAI({ apiKey: openaiApiKey })
    clientKey = openaiApiKey
  }
  return client
}

const TRANSLATE_SYSTEM = `You are a live interpreter for a video call between English and Vietnamese speakers.
Given one utterance, detect its language, then translate it:
- English input -> translate to Vietnamese
- Vietnamese input -> translate to English
- Any other language -> translate to English
Respond with JSON only: {"lang": "<ISO 639-1 code of the input>", "translation": "<translated text>"}
Keep the translation natural and conversational. Do not add commentary.`

export async function translateText(
  text: string
): Promise<{ translation: string; detectedLang: string }> {
  const { translateModel } = getSettings()
  const res = await getClient().chat.completions.create({
    model: translateModel,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM },
      { role: 'user', content: text }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 1000
  })
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}')
  return {
    translation: String(parsed.translation ?? ''),
    detectedLang: String(parsed.lang ?? 'unknown')
  }
}

const SUMMARY_SYSTEM = `You summarize live meeting / livestream transcripts.
The transcript below has two channels: [mic] is the app user speaking, [system] is everyone else on the call.
Write the summary in English, followed by a full Vietnamese translation of the same summary.
Structure each language section as:
## Overview  (2-3 sentences)
## Key points  (bullets)
## Questions raised  (bullets; note who asked if inferable, and whether it was answered)
## Action items  (bullets; "-" if none)`

export async function summarizeTranscript(segments: TranscriptSegment[]): Promise<string> {
  if (segments.length === 0) throw new Error('Nothing to summarize yet.')
  const { summaryModel } = getSettings()
  const transcript = segments
    .map((s) => `[${s.source}] (${s.at.slice(11, 19)}) ${s.text}`)
    .join('\n')
  const res = await getClient().chat.completions.create({
    model: summaryModel,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: transcript }
    ],
    temperature: 0.3,
    max_tokens: 3000
  })
  return res.choices[0]?.message?.content ?? ''
}
