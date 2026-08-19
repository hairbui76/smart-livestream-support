import { useEffect, useState } from 'react'
import { DownloadProgress, MODELS, ModelStatus } from '../../../shared/types'

const mib = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`

export default function ModelSetup({
  status,
  onStatusChange
}: {
  status: ModelStatus
  onStatusChange: (s: ModelStatus) => void
}): JSX.Element {
  const [selected, setSelected] = useState(status.activeModel)
  const [progress, setProgress] = useState<DownloadProgress | null>(status.downloading ?? null)
  const [error, setError] = useState('')

  useEffect(() => {
    return window.api.onModelProgress((p) => {
      setProgress(p.done ? null : p)
      if (p.error) setError(p.error)
      if (p.done && !p.error) void window.api.getModelStatus().then(onStatusChange)
    })
  }, [onStatusChange])

  const start = async (): Promise<void> => {
    setError('')
    setProgress({ name: selected, receivedBytes: 0, totalBytes: 0, done: false })
    onStatusChange(await window.api.downloadModel(selected))
  }

  if (progress) {
    const pct = progress.totalBytes
      ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
      : 0
    return (
      <div className="model-setup">
        <h3>Downloading speech model…</h3>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="muted">
          {pct}% — {mib(progress.receivedBytes)}
          {progress.totalBytes > 0 && ` of ${mib(progress.totalBytes)}`}
        </p>
        <p className="muted">
          This runs once. You can keep using the app; transcription starts when it finishes.
        </p>
        <button onClick={() => window.api.cancelModelDownload()}>Cancel</button>
      </div>
    )
  }

  return (
    <div className="model-setup">
      <h3>One-time setup</h3>
      <p className="muted">
        Speech-to-text runs locally on your machine, so a model has to be downloaded once. Nothing
        you say is ever uploaded.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="model-options">
        {MODELS.map((m) => {
          const installed = status.installed.includes(m.name)
          return (
            <label key={m.name} className={selected === m.name ? 'model-option active' : 'model-option'}>
              <input
                type="radio"
                name="model"
                checked={selected === m.name}
                onChange={() => setSelected(m.name)}
              />
              <span className="model-name">
                {m.label} · {mib(m.sizeBytes)}
                {installed && ' · installed'}
              </span>
              <span className="muted">{m.note}</span>
            </label>
          )
        })}
      </div>
      <button onClick={start}>
        {status.installed.includes(selected) ? 'Use this model' : `Download ${mib(
          MODELS.find((m) => m.name === selected)?.sizeBytes ?? 0
        )}`}
      </button>
    </div>
  )
}
