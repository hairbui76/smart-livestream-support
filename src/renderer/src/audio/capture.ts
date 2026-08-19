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

/** Capture the user's microphone. */
export async function startMicCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true }
  })
  return startCapture('mic', stream)
}

/**
 * Capture system (loopback) audio — what the other call participants say.
 * The main process routes this request to WASAPI loopback on Windows.
 */
export async function startSystemCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  // We only need the audio; drop the mandatory video track immediately.
  stream.getVideoTracks().forEach((t) => t.stop())
  const audioOnly = new MediaStream(stream.getAudioTracks())
  return startCapture('system', audioOnly)
}
