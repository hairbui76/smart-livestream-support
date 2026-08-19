import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AudioSource, TranscriptSegment } from '../../shared/types'
import { getSettings } from '../settings'
import { resolveWhisperPaths } from './resources'
import { encodeWav } from './wav'

const SAMPLE_RATE = 16000

// Voice-activity detection tuning (all in samples at 16 kHz)
const FRAME = 480 // 30 ms
const RMS_THRESHOLD = 0.012
const SILENCE_TO_CLOSE = SAMPLE_RATE * 0.8 // 800 ms of silence ends an utterance
const MIN_SPEECH = SAMPLE_RATE * 0.4 // ignore blips under 400 ms
const MAX_SEGMENT = SAMPLE_RATE * 12 // force-cut utterances at 12 s
const PRE_ROLL = SAMPLE_RATE * 0.3 // keep 300 ms before speech onset

type SegmentHandler = (segment: TranscriptSegment) => void
type ErrorHandler = (message: string) => void

/**
 * Buffers 16 kHz mono PCM for one audio source, cuts it into utterances with a
 * simple energy-based VAD, and transcribes each utterance with a local
 * whisper.cpp CLI binary.
 */
export class WhisperService {
  private buffer: Float32Array[] = []
  private bufferedSamples = 0
  private inSpeech = false
  private silenceRun = 0
  private preRoll: Float32Array[] = []
  private preRollSamples = 0
  private queue: Promise<void> = Promise.resolve()

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
    const voiced = rms > RMS_THRESHOLD

    if (!this.inSpeech) {
      if (voiced) {
        this.inSpeech = true
        this.silenceRun = 0
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

  private closeSegment(): void {
    const merged = new Float32Array(this.bufferedSamples)
    let off = 0
    for (const part of this.buffer) {
      merged.set(part, off)
      off += part.length
    }
    // serialize transcriptions per source so whisper processes don't pile up
    this.queue = this.queue.then(() => this.transcribe(merged)).catch(() => {})
  }

  private async transcribe(samples: Float32Array): Promise<void> {
    const { sttLanguage } = getSettings()
    const resolved = resolveWhisperPaths()
    if ('error' in resolved) {
      this.onError(resolved.error)
      return
    }
    const { binary, model } = resolved

    const wavPath = join(tmpdir(), `sls-${this.source}-${randomUUID()}.wav`)
    await writeFile(wavPath, encodeWav(samples, SAMPLE_RATE))
    try {
      const text = await new Promise<string>((resolve, reject) => {
        execFile(
          binary,
          ['-m', model, '-f', wavPath, '-l', sttLanguage || 'auto', '-nt', '-np', '-t', '4'],
          { timeout: 60_000, windowsHide: true },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        )
      })
      const cleaned = text.replace(/\s+/g, ' ').trim()
      // whisper emits noise markers like [BLANK_AUDIO] or (music) on non-speech
      if (!cleaned || /^[[(].*[\])]$/.test(cleaned)) return
      this.onSegment({
        id: randomUUID(),
        source: this.source,
        text: cleaned,
        at: new Date().toISOString()
      })
    } catch (err) {
      this.onError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      unlink(wavPath).catch(() => {})
    }
  }
}
