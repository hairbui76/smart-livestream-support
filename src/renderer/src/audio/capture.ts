import type { AudioSource, ScreenSource } from '../../../shared/types'

const TARGET_RATE = 16000

/** Inline copy of public/pcm-tap.js, used only if the file cannot be fetched. */
const WORKLET_FALLBACK_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]
    if (ch && ch[0]) {
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

/**
 * Load the PCM tap processor into an audio context.
 *
 * The worklet ships as a real file so it satisfies a `script-src 'self'`
 * policy. A blob: URL — the obvious shortcut — is refused by that policy, and
 * addModule reports the refusal as `AbortError: The user aborted a request`,
 * which looks nothing like a CSP problem. The blob route is kept only as a
 * fallback, and both failures are reported together.
 */
async function loadWorklet(ctx: AudioContext): Promise<void> {
  const fileUrl = new URL('pcm-tap.js', window.location.href).href
  try {
    await ctx.audioWorklet.addModule(fileUrl)
    window.api.logEvent(`renderer: worklet loaded from ${fileUrl}`)
    return
  } catch (fileErr) {
    window.api.logEvent(`renderer: worklet file failed — ${errText(fileErr)}; trying blob`)

    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_FALLBACK_SOURCE], { type: 'text/javascript' })
    )
    try {
      await ctx.audioWorklet.addModule(blobUrl)
      window.api.logEvent('renderer: worklet loaded from blob fallback')
      return
    } catch (blobErr) {
      window.api.logEvent(`renderer: worklet blob failed — ${errText(blobErr)}`)
      throw new Error(
        'Audio processing could not start: the audio worklet failed to load. ' +
          `File route: ${errText(fileErr)}. Blob route: ${errText(blobErr)}.`
      )
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }
}

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
  try {
    await loadWorklet(ctx)
  } catch (err) {
    void ctx.close()
    stream.getTracks().forEach((t) => t.stop())
    throw err
  }

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

/**
 * Count audio devices of a kind. Labels are hidden before permission is
 * granted, but the entries themselves are still listed, so this distinguishes
 * "no hardware at all" from "permission not granted yet".
 */
async function countDevices(kind: MediaDeviceKind): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === kind).length
  } catch {
    return -1 // unknown; do not block on it
  }
}

/** Capture the user's microphone. */
export async function startMicCapture(): Promise<Capture> {
  if ((await countDevices('audioinput')) === 0) {
    throw new Error(
      'Windows reports no microphone at all. This is normal on a virtual machine or a Remote ' +
        'Desktop session; on a physical PC, check that the mic is plugged in and enabled in ' +
        'Settings → System → Sound → Input.'
    )
  }

  let stream: MediaStream
  window.api.logEvent('renderer: mic getUserMedia requested')
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    window.api.logEvent(`renderer: mic FAILED ${errName(err)} — ${errText(err)}`)
    throw new Error(await explain(err, 'mic'))
  }
  const label = stream.getAudioTracks()[0]?.label ?? 'no label'
  window.api.logEvent(`renderer: mic stream acquired (${label})`)
  const capture = await startCapture('mic', stream)
  window.api.logEvent('renderer: mic capture running')
  return capture
}

const errName = (err: unknown): string =>
  err instanceof DOMException ? err.name : err instanceof Error ? err.constructor.name : 'unknown'
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Capture system (loopback) audio — what the other call participants say.
 * The main process routes this request to WASAPI loopback on Windows.
 */
export async function startSystemCapture(): Promise<Capture> {
  if ((await countDevices('audiooutput')) === 0) {
    throw new Error(
      'Windows reports no audio playback device, so there is no output to loop back. This is ' +
        'normal on a virtual machine or a Remote Desktop session; on a physical PC, enable a ' +
        'speaker or headphone device in Settings → System → Sound → Output.'
    )
  }

  const attempts: string[] = []

  // Preferred path: getDisplayMedia, routed to WASAPI loopback by the main
  // process. Video has to be requested even though it is discarded — an
  // audio-only request is rejected, and loopback rides along with a screen.
  window.api.logEvent('renderer: system getDisplayMedia requested')
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    // Must be awaited inside the try: returning the promise would let a
    // rejection escape this catch, skipping the fallback route below.
    const capture = await startCapture('system', audioOnly(stream))
    window.api.logEvent('renderer: system capture running via getDisplayMedia')
    return capture
  } catch (err) {
    window.api.logEvent(`renderer: getDisplayMedia FAILED ${errName(err)} — ${errText(err)}`)
    attempts.push(`getDisplayMedia: ${await explain(err, 'system')}`)
  }

  // Fallback: the legacy desktop-capture constraint. It bypasses
  // getDisplayMedia entirely, so it can succeed when Chromium refuses the
  // modern path — which is what happens on some multi-monitor setups. Each
  // screen is tried, since only some of them may be accepted.
  let sources: ScreenSource[] = []
  try {
    sources = await window.api.getScreenSources()
  } catch (err) {
    attempts.push(`screen enumeration: ${err instanceof Error ? err.message : String(err)}`)
  }

  for (const source of sources) {
    window.api.logEvent(`renderer: trying legacy desktop constraint on ${source.name}`)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } }
      } as unknown as MediaStreamConstraints)
      const capture = await startCapture('system', audioOnly(stream))
      window.api.logEvent(`renderer: system capture running via legacy route on ${source.name}`)
      return capture
    } catch (err) {
      window.api.logEvent(`renderer: legacy ${source.name} FAILED ${errName(err)} — ${errText(err)}`)
      attempts.push(`${source.name}: ${errText(err)}`)
    }
  }

  window.api.logEvent(`renderer: system capture exhausted all ${attempts.length} route(s)`)
  throw new Error(
    `System audio could not be captured. Tried ${attempts.length} route${
      attempts.length === 1 ? '' : 's'
    }:\n• ${attempts.join('\n• ')}`
  )
}

/** Keep only the audio; the video track is a means to an end here. */
function audioOnly(stream: MediaStream): MediaStream {
  stream.getVideoTracks().forEach((t) => t.stop())
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    // Without this the app would sit silently recording nothing at all.
    throw new Error('granted screen capture but no audio track, so there is nothing to transcribe')
  }
  return new MediaStream(audioTracks)
}
