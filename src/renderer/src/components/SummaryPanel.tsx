import { useState } from 'react'

export default function SummaryPanel(): JSX.Element {
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const generate = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setSummary(await window.api.generateSummary())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="summary">
      <button onClick={generate} disabled={busy}>
        {busy ? 'Summarizing…' : summary ? '🔄 Regenerate summary' : '📝 Generate summary'}
      </button>
      {error && <div className="error">{error}</div>}
      {summary && <pre className="summary-text">{summary}</pre>}
      {!summary && !busy && !error && (
        <div className="empty">Summarizes the whole meeting so far — in English and Vietnamese.</div>
      )}
    </div>
  )
}
