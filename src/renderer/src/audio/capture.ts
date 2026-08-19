import type { AudioSource } from '../../../shared/types'

const TARGET_RATE = 16000

// AudioWorklet processor, loaded from a Blob URL to keep bundling simple.
// Posts Float32Array blocks of raw PCM at the context sample rate.
const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]
    if (ch && ch[0]) {
      // Mix down to mono
      const n = ch[0].length
      const mono = new Float32Array(n)
      for (let c = 0; c < ch.length; c++) {
        for (let i = 0; i < n; i++) mono[i] += ch[c][i] / ch.length
      }
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input
  const ratio = fromRate / TARGET_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0)
  }
  return out
}

export interface Capture {
  stop(): void
}

async function startCapture(source: AudioSource, stream: MediaStream): Promise<Capture> {
  const ctx = new AudioContext()
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  await ctx.audioWorklet.addModule(workletUrl)
  URL.revokeObjectURL(workletUrl)

  const src = ctx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(ctx, 'pcm-tap')
  src.connect(tap)
  // Not connected to ctx.destination on purpose — we only tap, never play back.

  // Batch ~250 ms of audio per IPC message to keep message volume low.
  let pending: Float32Array[] = []
  let pendingLen = 0
  const batchSize = Math.floor(ctx.sampleRate * 0.25)

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    pending.push(e.data)
    pendingLen += e.data.length
    if (pendingLen >= batchSize) {
      const merged = new Float32Array(pendingLen)
      let off = 0
      for (const p of pending) {
        merged.set(p, off)
        off += p.length
      }
      pending = []
      pendingLen = 0
      window.api.sendAudioChunk(source, downsample(merged, ctx.sampleRate))
    }
  }

  window.api.setAudioState(source, true)

  return {
    stop() {
      window.api.setAudioState(source, false)
      tap.port.onmessage = null
      src.disconnect()
      tap.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

/**
 * Turn a media error into something the user can act on. Chromium's own
 * messages ("The user aborted a request") say nothing about the real cause.
 */
async function explain(err: unknown, kind: AudioSource): Promise<string> {
  const name = err instanceof DOMException ? err.name : ''
  const detail = err instanceof Error ? err.message : String(err)

  if (kind === 'system' && (name === 'AbortError' || name === 'NotAllowedError')) {
    // The main process knows why it declined; Chromium does not pass it through.
    const reason = await window.api.getDisplayMediaError()
    if (reason) return reason
  }

  switch (name) {
    case 'NotAllowedError':
      return kind === 'mic'
        ? 'Microphone access was refused. In Windows, open Settings → Privacy & security → Microphone and turn on "Let desktop apps access your microphone".'
        : 'Screen and audio capture was refused by Windows.'
    case 'NotFoundError':
      return 'No microphone was found. Connect one, or choose a different input device in Windows sound settings.'
    case 'NotReadableError':
      return 'The audio device could not be opened — another app may have exclusive use of it.'
    case 'AbortError':
      return kind === 'mic'
        ? `Windows would not start microphone capture (${detail}). The device may be held exclusively by another app, or you may be on a Remote Desktop session with no audio input.`
        : `Windows would not start system-audio capture (${detail}). Loopback capture needs a local desktop session on Windows 10 2004 or newer.`
    default:
      return name ? `${name}: ${detail}` : detail
  }
}

/** Capture the user's microphone. */
export async function startMicCapture(): Promise<Capture> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    throw new Error(await explain(err, 'mic'))
  }
  return startCapture('mic', stream)
}

/**
 * Capture system (loopback) audio — what the other call participants say.
 * The main process routes this request to WASAPI loopback on Windows.
 */
export async function startSystemCapture(): Promise<Capture> {
  let stream: MediaStream
  try {
    // Video has to be requested even though it is discarded: getDisplayMedia
    // rejects an audio-only request, and the loopback audio rides along with a
    // screen source.
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  } catch (err) {
    throw new Error(await explain(err, 'system'))
  }

  stream.getVideoTracks().forEach((t) => t.stop())
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    // Without this the app would sit silently recording nothing at all.
    throw new Error(
      'Windows granted screen capture but no audio track, so there is nothing to transcribe. ' +
        'System-audio loopback needs Windows 10 2004 or newer.'
    )
  }
  return startCapture('system', new MediaStream(audioTracks))
}
