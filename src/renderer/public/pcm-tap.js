/**
 * Taps raw PCM from an audio graph and posts it to the main thread.
 *
 * This is a real file rather than a generated blob: URL on purpose. Worklet
 * modules are fetched under the page's script-src, and a blob: URL is refused
 * by a 'self' policy — which surfaces as an opaque "user aborted" AbortError.
 */
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    if (channels && channels[0]) {
      const length = channels[0].length
      const mono = new Float32Array(length)
      for (let c = 0; c < channels.length; c++) {
        const channel = channels[c]
        for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length
      }
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
