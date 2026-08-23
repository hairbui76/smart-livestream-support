import { randomUUID } from 'crypto'
import { AudioSource, TranscriptSegment } from '../../shared/types'
import { logEvent } from '../eventLog'
import { getSettings } from '../settings'
import { transcribe } from './whisperEngine'

const SAMPLE_RATE = 16000

// Voice-activity detection tuning (all in samples at 16 kHz)
const FRAME = 480 // 30 ms
const SILENCE_TO_CLOSE = SAMPLE_RATE * 0.5 // 500 ms of silence ends an utterance
const MIN_SPEECH = SAMPLE_RATE * 0.4 // ignore blips under 400 ms
const MAX_SEGMENT = SAMPLE_RATE * 7 // force-cut utterances at 7 s
const PRE_ROLL = SAMPLE_RATE * 0.3 // keep 300 ms before speech onset
const PARTIAL_EVERY = SAMPLE_RATE * 1.2 // provisional pass every 1.2 s of speech

/**
 * Auto-detect costs a whole extra encoder pass at full context — roughly three
 * times the work of transcribing with a known language. So detect once, reuse
 * the answer, and re-check occasionally in case the speaker switches language.
 */
const REDETECT_AFTER = 20

/**
 * Energy thresholds. A single fixed threshold either misses a quiet headset or
 * triggers constantly on a noisy room, so the floor tracks the room and speech
 * has to stand clear of it. Two levels give hysteresis: it takes more energy to
 * start an utterance than to stay in one, so words are not chopped mid-syllable.
 */
const ABSOLUTE_FLOOR = 0.006
const OPEN_MARGIN = 3.0 // enter speech at 3x the noise floor
const CLOSE_MARGIN = 1.8 // stay in speech down to 1.8x
const FLOOR_ALPHA = 0.05 // how fast the noise floor follows the room

type SegmentHandler = (segment: TranscriptSegment) => void
type ErrorHandler = (message: string) => void

/**
 * Buffers 16 kHz mono PCM for one audio source, cuts it into utterances with an
 * energy-based VAD, and transcribes each one.
 *
 * While someone is still speaking it also emits provisional text every second
 * or so, sharing the id of the final segment that later replaces it. Waiting
 * for a full utterance before showing anything is what makes subtitles feel
 * slow, even when transcription itself is fast.
 */
export class WhisperService {
  private buffer: Float32Array[] = []
  private bufferedSamples = 0
  private inSpeech = false
  private silenceRun = 0
  private preRoll: Float32Array[] = []
  private preRollSamples = 0
  private queue: Promise<void> = Promise.resolve()
  private queueDepth = 0

  private noiseFloor = ABSOLUTE_FLOOR
  private utteranceId = randomUUID()
  private lastPartialAt = 0
  private partialInFlight = false
  private finalized = new Set<string>()
  private pinnedLanguage: string | null = null
  private sinceDetect = 0

  constructor(
    private source: AudioSource,
    private onSegment: SegmentHandler,
    private onError: ErrorHandler
  ) {}

  feed(chunk: Float32Array): void {
    for (let off = 0; off < chunk.length; off += FRAME) {
      const frame = chunk.subarray(off, Math.min(off + FRAME, chunk.length))
      this.feedFrame(frame)
    }
  }

  /** Flush whatever is buffered (e.g. when capture stops). */
  flush(): void {
    if (this.bufferedSamples >= MIN_SPEECH) this.closeSegment()
    this.reset()
  }

  private feedFrame(frame: Float32Array): void {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)

    const openAt = Math.max(ABSOLUTE_FLOOR, this.noiseFloor * OPEN_MARGIN)
    const closeAt = Math.max(ABSOLUTE_FLOOR * 0.8, this.noiseFloor * CLOSE_MARGIN)
    const voiced = this.inSpeech ? rms > closeAt : rms > openAt

    if (!voiced) {
      // Only silence updates the floor, otherwise speech would raise it until
      // the speaker is treated as background noise.
      this.noiseFloor = this.noiseFloor * (1 - FLOOR_ALPHA) + rms * FLOOR_ALPHA
    }

    if (!this.inSpeech) {
      if (voiced) {
        this.inSpeech = true
        this.silenceRun = 0
        this.utteranceId = randomUUID()
        this.lastPartialAt = 0
        // include pre-roll so the first syllable isn't clipped
        this.buffer = [...this.preRoll]
        this.bufferedSamples = this.preRollSamples
        this.pushSamples(frame)
      } else {
        this.preRoll.push(Float32Array.from(frame))
        this.preRollSamples += frame.length
        while (this.preRollSamples > PRE_ROLL && this.preRoll.length > 1) {
          this.preRollSamples -= this.preRoll[0].length
          this.preRoll.shift()
        }
      }
      return
    }

    this.pushSamples(frame)
    this.silenceRun = voiced ? 0 : this.silenceRun + frame.length

    if (this.silenceRun >= SILENCE_TO_CLOSE || this.bufferedSamples >= MAX_SEGMENT) {
      if (this.bufferedSamples - this.silenceRun >= MIN_SPEECH) this.closeSegment()
      this.reset()
      return
    }

    if (this.bufferedSamples - this.lastPartialAt >= PARTIAL_EVERY) {
      this.lastPartialAt = this.bufferedSamples
      this.emitPartial()
    }
  }

  private pushSamples(frame: Float32Array): void {
    this.buffer.push(Float32Array.from(frame))
    this.bufferedSamples += frame.length
  }

  private reset(): void {
    this.buffer = []
    this.bufferedSamples = 0
    this.inSpeech = false
    this.silenceRun = 0
    this.preRoll = []
    this.preRollSamples = 0
  }

  /** The language to ask whisper for: explicit setting, or the pinned guess. */
  private language(): string {
    const { sttLanguage } = getSettings()
    if (sttLanguage !== 'auto') return sttLanguage
    if (this.pinnedLanguage && this.sinceDetect < REDETECT_AFTER) return this.pinnedLanguage
    return 'auto'
  }

  private recordDetection(detected: string | undefined): void {
    if (getSettings().sttLanguage !== 'auto') return
    if (detected) {
      if (detected !== this.pinnedLanguage) {
        logEvent(`stt: ${this.source} language detected as ${detected}`)
      }
      this.pinnedLanguage = detected
      this.sinceDetect = 0
    } else if (this.pinnedLanguage) {
      this.sinceDetect++
    }
  }

  private merged(): Float32Array {
    const out = new Float32Array(this.bufferedSamples)
    let off = 0
    for (const part of this.buffer) {
      out.set(part, off)
      off += part.length
    }
    return out
  }

  /**
   * Provisional text for speech still in progress. Partials are droppable by
   * design: if the engine is busy with a final, skipping one costs nothing,
   * whereas queueing it would delay the text that actually matters.
   */
  private emitPartial(): void {
    const { livePartials, fastMode } = getSettings()
    if (!livePartials) return
    if (this.partialInFlight || this.queueDepth > 0) return
    if (this.bufferedSamples < MIN_SPEECH) return

    const id = this.utteranceId
    const samples = this.merged()
    this.partialInFlight = true

    void transcribe(samples, { language: this.language(), partial: true, fast: fastMode })
      .then(({ text, detectedLanguage }) => {
        this.recordDetection(detectedLanguage)
        // The utterance may have ended while this was running; a late partial
        // would overwrite the final wording with a worse guess.
        if (this.finalized.has(id)) return
        const cleaned = clean(text)
        if (!cleaned) return
        this.onSegment({
          id,
          source: this.source,
          text: cleaned,
          at: new Date().toISOString(),
          partial: true
        })
      })
      .catch(() => {
        // Partials are best-effort; the final pass reports real failures.
      })
      .finally(() => {
        this.partialInFlight = false
      })
  }

  private closeSegment(): void {
    const id = this.utteranceId
    const samples = this.merged()
    this.finalized.add(id)
    // Keep the set from growing for the whole session.
    if (this.finalized.size > 200) {
      this.finalized = new Set([...this.finalized].slice(-50))
    }

    const queuedAt = Date.now()
    this.queueDepth++
    // serialize transcriptions per source so whisper requests don't pile up
    this.queue = this.queue
      .then(() => this.transcribeFinal(id, samples, queuedAt))
      .catch(() => {})
      .finally(() => {
        this.queueDepth--
      })
  }

  private async transcribeFinal(
    id: string,
    samples: Float32Array,
    queuedAt: number
  ): Promise<void> {
    const { fastMode } = getSettings()
    const seconds = samples.length / SAMPLE_RATE
    const waited = Date.now() - queuedAt

    try {
      const { text, engine, ms, detectedLanguage } = await transcribe(samples, {
        language: this.language(),
        partial: false,
        fast: fastMode
      })
      this.recordDetection(detectedLanguage)
      const speed = ms > 0 ? (seconds * 1000) / ms : 0
      logEvent(
        `stt: ${this.source} ${seconds.toFixed(1)}s audio → ${ms} ms on ${engine} ` +
          `(${speed.toFixed(1)}x realtime, waited ${waited} ms, queue ${this.queueDepth - 1})`
      )
      // Falling behind compounds: every extra second of lag stays for the rest
      // of the session, so make it visible rather than silently drifting.
      if (this.queueDepth > 2) {
        logEvent(`stt: ${this.source} is falling behind — ${this.queueDepth} utterances queued`)
      }

      const cleaned = clean(text)
      if (!cleaned) {
        // A partial may already be on screen; replace it with nothing sensible.
        return
      }
      this.onSegment({
        id,
        source: this.source,
        text: cleaned,
        at: new Date().toISOString(),
        lang: this.pinnedLanguage ?? undefined
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logEvent(`stt: ${this.source} transcription failed — ${message}`)
      this.onError(`Transcription failed: ${message}`)
    }
  }
}

/** whisper emits noise markers like [BLANK_AUDIO] or (music) on non-speech. */
function clean(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned || /^[[(].*[\])]$/.test(cleaned)) return ''
  return cleaned
}
