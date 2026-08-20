import { useEffect, useState } from 'react'

export default function DiagnosticsPanel(): JSX.Element {
  const [text, setText] = useState('')
  const [devices, setDevices] = useState('')
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

  const full = devices ? `${text}\n${devices}` : text

  return (
    <div className="diagnostics">
      <p className="muted">
        Paste this when reporting a problem — it shows which build is running and what Windows
        reported.
      </p>
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
        <button onClick={run}>Re-run</button>
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
