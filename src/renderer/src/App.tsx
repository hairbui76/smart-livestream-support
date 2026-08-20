import { useEffect, useRef, useState } from 'react'
import type { ModelStatus, TranscriptSegment } from '../../shared/types'
import { Capture, startMicCapture, startSystemCapture } from './audio/capture'
import DiagnosticsPanel from './components/DiagnosticsPanel'
import ModelSetup from './components/ModelSetup'
import SettingsPanel from './components/SettingsPanel'
import SummaryPanel from './components/SummaryPanel'
import TranscriptPanel from './components/TranscriptPanel'

export interface Entry extends TranscriptSegment {
  translation?: string
  detectedLang?: string
}

export default function App(): JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [micOn, setMicOn] = useState(false)
  const [systemOn, setSystemOn] = useState(false)
  // Keyed so a mic failure and a system-audio failure stay separately visible
  // instead of one overwriting the other.
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [view, setView] = useState<'live' | 'summary' | 'settings' | 'model' | 'diagnostics'>(
    'live'
  )
  const [model, setModel] = useState<ModelStatus | null>(null)
  const [version, setVersion] = useState('')
  const micRef = useRef<Capture | null>(null)
  const systemRef = useRef<Capture | null>(null)

  const setError = (key: string, message: string): void =>
    setErrors((prev) => ({ ...prev, [key]: message }))
  const clearError = (key: string): void =>
    setErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })

  useEffect(() => {
    const offSegment = window.api.onSegment((s) =>
      setEntries((prev) => [...prev, s])
    )
    const offTranslation = window.api.onTranslation((t) =>
      setEntries((prev) =>
        prev.map((e) =>
          e.id === t.segmentId
            ? { ...e, translation: t.translation, detectedLang: t.detectedLang }
            : e
        )
      )
    )
    const offError = window.api.onError((m) => setError('engine', m))
    void window.api.getAppVersion().then(setVersion)
    return () => {
      offSegment()
      offTranslation()
      offError()
    }
  }, [])

  // On first launch the model has not been downloaded yet — send the user straight to setup.
  useEffect(() => {
    void window.api.getModelStatus().then((s) => {
      setModel(s)
      if (!s.ready) setView('model')
    })
  }, [])

  const toggleMic = async (): Promise<void> => {
    clearError('mic')
    if (micRef.current) {
      micRef.current.stop()
      micRef.current = null
      setMicOn(false)
      return
    }
    try {
      micRef.current = await startMicCapture()
      setMicOn(true)
    } catch (err) {
      setError('mic', `Mic: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const toggleSystem = async (): Promise<void> => {
    clearError('system')
    if (systemRef.current) {
      systemRef.current.stop()
      systemRef.current = null
      setSystemOn(false)
      return
    }
    try {
      systemRef.current = await startSystemCapture()
      setSystemOn(true)
    } catch (err) {
      setError('system', `Call audio: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="title">
          🎙 Livestream Support
          {version && <span className="version">v{version}</span>}
        </span>
        <div className="titlebar-actions">
          <button title="Hide (Ctrl+Shift+Space to restore)" onClick={() => window.api.windowControl('hide')}>
            —
          </button>
          <button title="Close" onClick={() => window.api.windowControl('close')}>
            ✕
          </button>
        </div>
      </header>

      <div className="toolbar">
        <button
          className={micOn ? 'active' : ''}
          onClick={toggleMic}
          disabled={!model?.ready}
          title={model?.ready ? 'Transcribe your microphone' : 'Download the speech model first'}
        >
          {micOn ? '⏹ Mic' : '🎤 Mic'}
        </button>
        <button
          className={systemOn ? 'active' : ''}
          onClick={toggleSystem}
          disabled={!model?.ready}
          title={model?.ready ? 'Transcribe the other participants' : 'Download the speech model first'}
        >
          {systemOn ? '⏹ Call audio' : '🔊 Call audio'}
        </button>
        <button className={view === 'summary' ? 'active' : ''} onClick={() => setView('summary')}>
          📝 Summary
        </button>
        <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
          ⚙
        </button>
        <button
          className={view === 'diagnostics' ? 'active' : ''}
          onClick={() => setView('diagnostics')}
          title="Environment report for troubleshooting"
        >
          🩺
        </button>
        {!model?.ready && (
          <button className={view === 'model' ? 'active' : ''} onClick={() => setView('model')}>
            ⬇ Model
          </button>
        )}
        {view !== 'live' && <button onClick={() => setView('live')}>◀ Live</button>}
      </div>

      {Object.entries(errors).map(([key, message]) => (
        <div key={key} className="error">
          <span>{message}</span>
          <div className="error-actions">
            <button onClick={() => setView('diagnostics')}>Diagnose</button>
            <button onClick={() => clearError(key)}>Dismiss</button>
          </div>
        </div>
      ))}

      <main className="content">
        {view === 'live' && <TranscriptPanel entries={entries} />}
        {view === 'summary' && <SummaryPanel />}
        {view === 'settings' && <SettingsPanel />}
        {view === 'model' && model && <ModelSetup status={model} onStatusChange={setModel} />}
        {view === 'diagnostics' && <DiagnosticsPanel />}
      </main>
    </div>
  )
}
