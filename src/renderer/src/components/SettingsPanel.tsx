import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/types'

export default function SettingsPanel(): JSX.Element {
  const [settings, setLocal] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.getSettings().then(setLocal)
  }, [])

  if (!settings) return <div className="empty">Loading…</div>

  const update = (patch: Partial<AppSettings>): void => {
    setLocal({ ...settings, ...patch })
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    await window.api.setSettings(settings)
    setSaved(true)
  }

  return (
    <div className="settings">
      <label>
        OpenAI API key
        <input
          type="password"
          value={settings.openaiApiKey}
          onChange={(e) => update({ openaiApiKey: e.target.value })}
          placeholder="sk-…"
        />
      </label>
      <label>
        Translation model
        <input
          value={settings.translateModel}
          onChange={(e) => update({ translateModel: e.target.value })}
        />
      </label>
      <label>
        Summary model
        <input
          value={settings.summaryModel}
          onChange={(e) => update({ summaryModel: e.target.value })}
        />
      </label>
      <label>
        whisper.cpp binary path (optional — bundled whisper-cli is used if empty)
        <input
          value={settings.whisperBinaryPath}
          onChange={(e) => update({ whisperBinaryPath: e.target.value })}
          placeholder="(auto: bundled whisper-cli.exe)"
        />
      </label>
      <label>
        Whisper model path (optional — bundled ggml-small is used if empty)
        <input
          value={settings.whisperModelPath}
          onChange={(e) => update({ whisperModelPath: e.target.value })}
          placeholder="(auto: bundled ggml-small.bin)"
        />
      </label>
      <label>
        Speech language
        <select
          value={settings.sttLanguage}
          onChange={(e) => update({ sttLanguage: e.target.value })}
        >
          <option value="auto">Auto-detect</option>
          <option value="en">English</option>
          <option value="vi">Vietnamese</option>
        </select>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={settings.autoTranslate}
          onChange={(e) => update({ autoTranslate: e.target.checked })}
        />
        Auto-translate every utterance (EN ↔ VI)
      </label>
      <button onClick={save}>{saved ? '✓ Saved' : 'Save settings'}</button>
    </div>
  )
}
