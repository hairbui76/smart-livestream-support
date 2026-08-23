import { ChildProcess, execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { cpus } from 'os'
import { tmpdir } from 'os'
import { join } from 'path'
import { logEvent } from '../eventLog'
import { resolveWhisperPaths } from './resources'
import { freePort, health, infer } from './whisperHttp'
import { encodeWav } from './wav'

const SAMPLE_RATE = 16000

/**
 * Frames of encoder context per second of audio. Whisper's encoder always runs
 * over a 30 s window of 1500 frames, so a 3 s utterance costs the same as a
 * 30 s one unless the context is trimmed to fit — which is what `audio_ctx` is
 * for. Trimming is the single largest win for short live utterances.
 */
const CTX_FRAMES_PER_SECOND = 50
const CTX_FULL = 1500
const CTX_MIN = 512 // below this, accuracy starts to suffer noticeably
const CTX_HEADROOM = 100 // ~2 s of slack so the tail of a clip is never clipped

export interface TranscribeOptions {
  language: string
  /** Provisional pass for speech still in progress — accuracy matters less. */
  partial: boolean
  /** Greedy decode, no temperature fallback, trimmed encoder context. */
  fast: boolean
}

export interface TranscribeResult {
  text: string
  /** Which backend produced it, for diagnostics. */
  engine: 'server' | 'cli'
  /** Wall-clock milliseconds spent inside whisper. */
  ms: number
  /** ISO code whisper detected, only when language was 'auto'. */
  detectedLanguage?: string
}

/**
 * whisper reports the language by full name; its own -l flag wants the code.
 * Anything missing here simply is not pinned, so auto-detect keeps running.
 */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', vietnamese: 'vi', korean: 'ko', japanese: 'ja', chinese: 'zh',
  french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt',
  russian: 'ru', thai: 'th', indonesian: 'id', malay: 'ms', hindi: 'hi',
  arabic: 'ar', dutch: 'nl', polish: 'pl', turkish: 'tr', ukrainian: 'uk',
  swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', czech: 'cs',
  romanian: 'ro', greek: 'el', hebrew: 'he', persian: 'fa', tagalog: 'tl',
  khmer: 'km', lao: 'lo', burmese: 'my', bengali: 'bn', tamil: 'ta'
}

function languageCode(reported: string): string | undefined {
  const key = reported.trim().toLowerCase()
  if (LANGUAGE_CODES[key]) return LANGUAGE_CODES[key]
  // Some builds already answer with a bare code.
  if (/^[a-z]{2}$/.test(key)) return key
  return undefined
}

/** Encoder context just large enough for this clip, in whisper's frame units. */
function audioCtxFor(seconds: number, fast: boolean): number {
  if (!fast) return 0 // 0 means "use all 1500 frames"
  const needed = Math.ceil(seconds * CTX_FRAMES_PER_SECOND) + CTX_HEADROOM
  return Math.min(CTX_FULL, Math.max(CTX_MIN, needed))
}

/**
 * Leave a core for the rest of the app. whisper-cli's own default caps at 4,
 * which wastes most of a modern laptop.
 */
function threadCount(): number {
  const n = cpus().length || 4
  return Math.max(2, Math.min(8, n - 1))
}

// ---------------------------------------------------------------------------
// Resident server
// ---------------------------------------------------------------------------

interface Server {
  child: ChildProcess
  port: number
}

let server: Server | null = null
let starting: Promise<Server | null> | null = null
let serverAttempts = 0
let lastEngine: TranscribeResult['engine'] | null = null
let lastMs = 0
let disabledReason = ''

const MAX_SERVER_ATTEMPTS = 2
const READY_TIMEOUT_MS = 120_000 // first load reads ~500 MB off a cold disk

/** Poll /health until the model is loaded; the port only binds after that. */
async function waitForReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastErr = 'no response'
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`whisper-server exited early (code ${child.exitCode ?? child.signalCode})`)
    }
    try {
      const status = await health(port)
      if (status === 200) return
      lastErr = `health returned ${status}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`whisper-server did not become ready within 120 s (${lastErr})`)
}

async function startServer(): Promise<Server | null> {
  if (disabledReason) return null
  if (serverAttempts >= MAX_SERVER_ATTEMPTS) {
    disabledReason = `gave up after ${serverAttempts} failed starts`
    return null
  }
  serverAttempts++

  const resolved = resolveWhisperPaths()
  if ('error' in resolved) return null
  if (!resolved.server) {
    // Installs from before the server was bundled still work, just slower.
    disabledReason = 'whisper-server not bundled in this install'
    logEvent(`stt: ${disabledReason}; using per-utterance whisper-cli`)
    return null
  }

  const port = await freePort()
  const args = [
    '-m', resolved.model,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', String(threadCount()),
    '-nt', // no timestamps in the output text
    '-sns' // suppress non-speech tokens like (music)
    // Cross-segment context is already off by default in whisper-server, which
    // is what we want: one bad guess must not poison the next utterance.
  ]

  logEvent(`stt: starting whisper-server on port ${port} with ${threadCount()} threads`)
  // Keep stderr: when the server refuses to start, its own message is the only
  // thing that explains why, and this app gets debugged from user logs.
  const child = spawn(resolved.server, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-2000)
  })

  child.on('exit', (code, signal) => {
    logEvent(`stt: whisper-server exited (code ${code ?? signal})`)
    if (server?.child === child) server = null
  })
  child.on('error', (err) => logEvent(`stt: whisper-server error — ${err.message}`))

  try {
    await waitForReady(port, child)
  } catch (err) {
    child.kill()
    const why = err instanceof Error ? err.message : String(err)
    const detail = stderrTail.trim().split('\n').slice(-3).join(' | ')
    logEvent(`stt: whisper-server unusable — ${why}${detail ? ` — ${detail}` : ''}`)
    return null
  }

  logEvent('stt: whisper-server ready (model stays loaded between utterances)')
  return { child, port }
}

/** Start the server at most once at a time; null means "use the CLI". */
async function getServer(): Promise<Server | null> {
  if (server) return server
  if (!starting) {
    // Never let a startup failure reach the caller: the CLI fallback is there
    // precisely so a missing or broken server still transcribes the utterance.
    starting = startServer()
      .catch((err) => {
        logEvent(`stt: whisper-server start failed — ${err instanceof Error ? err.message : err}`)
        return null
      })
      .then((s) => {
        server = s
        starting = null
        return s
      })
  }
  return starting
}

/** Kill the resident server so it cannot outlive the app. */
export function stopEngine(): void {
  if (server) {
    server.child.kill()
    server = null
  }
}

export function engineStatus(): string {
  if (!lastEngine) return disabledReason ? `not started (${disabledReason})` : 'not started yet'
  const suffix = disabledReason ? ` (${disabledReason})` : ''
  return `${lastEngine}, last utterance took ${lastMs} ms${suffix}`
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function transcribeViaServer(
  port: number,
  wav: Buffer,
  seconds: number,
  opts: TranscribeOptions
): Promise<{ text: string; detectedLanguage?: string }> {
  const language = opts.language || 'auto'
  const detecting = language === 'auto'
  const { text, language: reported } = await infer(port, wav, {
    // verbose_json is what reports the language back, so auto-detect only has
    // to be paid for once per source instead of on every utterance.
    response_format: detecting ? 'verbose_json' : 'json',
    no_language_probabilities: 'true', // the probability table costs an extra pass
    language,
    no_timestamps: 'true',
    audio_ctx: String(audioCtxFor(seconds, opts.fast)),
    // Greedy: whisper.cpp's own live-streaming example decodes this way.
    beam_size: opts.fast ? '-1' : '5',
    best_of: opts.fast ? '1' : '5',
    temperature: '0.0',
    // Temperature fallback silently re-decodes up to six times on hard audio,
    // which is where the worst latency spikes come from.
    temperature_inc: opts.fast ? '0.0' : '0.2',
    suppress_nst: 'true'
  })
  return {
    text,
    detectedLanguage: detecting && reported ? languageCode(reported) : undefined
  }
}

async function transcribeViaCli(
  binary: string,
  model: string,
  wavPath: string,
  seconds: number,
  opts: TranscribeOptions
): Promise<{ text: string; detectedLanguage?: string }> {
  const language = opts.language || 'auto'
  const detecting = language === 'auto'
  const args = ['-m', model, '-f', wavPath, '-l', language, '-nt', '-t', String(threadCount())]
  // -np silences whisper's own log, which is also where the detected language
  // is announced, so keep the log when there is something to learn from it.
  if (!detecting) args.push('-np')
  if (opts.fast) {
    args.push('-bs', '1', '-bo', '1', '-nf', '-ac', String(audioCtxFor(seconds, true)))
  }

  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(binary, args, { timeout: 60_000, windowsHide: true }, (err, out, errOut) =>
        err ? reject(err) : resolve({ stdout: out, stderr: errOut })
      )
    }
  )

  const match = detecting ? /auto-detected language:\s*([a-z]{2})\b/i.exec(stderr) : null
  return { text: stdout, detectedLanguage: match ? match[1].toLowerCase() : undefined }
}

/**
 * Transcribe one utterance. Prefers the resident server — which keeps the model
 * in memory instead of reloading ~500 MB per utterance — and falls back to a
 * one-shot CLI run whenever the server is unavailable.
 */
export async function transcribe(
  samples: Float32Array,
  opts: TranscribeOptions
): Promise<TranscribeResult> {
  const resolved = resolveWhisperPaths()
  if ('error' in resolved) throw new Error(resolved.error)

  const seconds = samples.length / SAMPLE_RATE
  const wav = encodeWav(samples, SAMPLE_RATE)
  const started = Date.now()

  const active = await getServer()
  if (active) {
    try {
      const { text, detectedLanguage } = await transcribeViaServer(active.port, wav, seconds, opts)
      lastEngine = 'server'
      lastMs = Date.now() - started
      return { text, engine: 'server', ms: lastMs, detectedLanguage }
    } catch (err) {
      // Fall through to the CLI rather than losing the utterance.
      logEvent(`stt: server request failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const wavPath = join(tmpdir(), `sls-${randomUUID()}.wav`)
  await writeFile(wavPath, wav)
  try {
    const { text, detectedLanguage } = await transcribeViaCli(
      resolved.binary,
      resolved.model,
      wavPath,
      seconds,
      opts
    )
    lastEngine = 'cli'
    lastMs = Date.now() - started
    return { text, engine: 'cli', ms: lastMs, detectedLanguage }
  } finally {
    unlink(wavPath).catch(() => {})
  }
}
