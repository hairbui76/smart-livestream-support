import { useEffect, useState } from 'react'
import { startMicCapture, startSystemCapture } from '../audio/capture'

export default function DiagnosticsPanel(): JSX.Element {
  const [text, setText] = useState('')
  const [devices, setDevices] = useState('')
  const [testing, setTesting] = useState('')
  const [copied, setCopied] = useState(false)

  const run = async (): Promise<void> => {
    setCopied(false)
    const [{ text: report }, inputs] = await Promise.all([
      window.api.getDiagnostics(),
      listAudioInputs()
    ])
    setText(report)
    setDevices(inputs)
  }

  useEffect(() => {
    void run()
  }, [])

  /**
   * Exercise a capture path and immediately release it. Running the test from
   * here means the log always contains a fresh attempt when the report is
   * copied, with no particular order for the user to remember.
   */
  const test = async (kind: 'mic' | 'system'): Promise<void> => {
    setTesting(`Testing ${kind === 'mic' ? 'microphone' : 'system audio'}…`)
    try {
      const capture = kind === 'mic' ? await startMicCapture() : await startSystemCapture()
      capture.stop()
      setTesting(`✓ ${kind === 'mic' ? 'Microphone' : 'System audio'} works`)
    } catch (err) {
      setTesting(`✕ ${err instanceof Error ? err.message : String(err)}`)
    }
    await run()
  }

  const full = devices ? `${text}\n${devices}` : text

  return (
    <div className="diagnostics">
      <p className="muted">
        Run a test, then copy the report — it records what Windows did on every capture attempt,
        including previous runs of the app.
      </p>
      <div className="diag-actions">
        <button onClick={() => test('mic')}>Test microphone</button>
        <button onClick={() => test('system')}>Test system audio</button>
      </div>
      {testing && <div className="diag-result">{testing}</div>}
      <pre className="diag-text">{full || 'Collecting…'}</pre>
      <div className="diag-actions">
        <button
          onClick={() => {
            window.api.copyToClipboard(full)
            setCopied(true)
          }}
        >
          {copied ? '✓ Copied' : 'Copy report'}
        </button>
        <button onClick={run}>Refresh</button>
      </div>
    </div>
  )
}

/**
 * Audio device inventory, which only the renderer can see. Zero inputs or zero
 * outputs is the signature of a VM or Remote Desktop session, where neither
 * microphone capture nor loopback can work.
 */
async function listAudioInputs(): Promise<string> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const describe = (kind: MediaDeviceKind): string => {
      const found = devices.filter((d) => d.kind === kind)
      if (found.length === 0) return 'NONE DETECTED'
      // Labels stay blank until microphone permission has been granted once.
      return `${found.length}: ${found.map((d) => d.label || '(label hidden)').join(', ')}`
    }
    return [
      `Audio inputs  ${describe('audioinput')}`,
      `Audio outputs ${describe('audiooutput')}`
    ].join('\n')
  } catch (err) {
    return `Audio devices ERROR: ${err instanceof Error ? err.message : String(err)}`
  }
}
