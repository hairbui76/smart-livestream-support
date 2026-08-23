import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { AudioSource, IPC, TranscriptSegment } from '../shared/types'
import { summarizeTranscript, translateText } from './ai/openaiService'
import { collectDiagnostics, formatDiagnostics } from './diagnostics'
import { getLastDisplayMediaError, listScreenSources } from './displayMedia'
import { logEvent } from './eventLog'
import { getSettings, setSettings } from './settings'
import { cancelDownload, downloadModel, getModelStatus } from './stt/modelManager'
import { WhisperService } from './stt/whisperService'

export function registerIpc(getWin: () => BrowserWindow | null): void {
  const transcript: TranscriptSegment[] = []

  const send = (channel: string, payload: unknown): void => {
    getWin()?.webContents.send(channel, payload)
  }

  const handleSegment = (segment: TranscriptSegment): void => {
    send(IPC.sttSegment, segment)
    // Provisional text is replaced within a second or two: keeping it out of the
    // transcript keeps summaries clean, and out of translation keeps the API
    // bill down — both would otherwise see every draft of every sentence.
    if (segment.partial) return
    transcript.push(segment)
    if (getSettings().autoTranslate) {
      translateText(segment.text)
        .then(({ translation, detectedLang }) =>
          send(IPC.translationResult, { segmentId: segment.id, translation, detectedLang })
        )
        .catch((err) => send(IPC.sttError, `Translation failed: ${err.message}`))
    }
  }

  const services: Record<AudioSource, WhisperService> = {
    mic: new WhisperService('mic', handleSegment, (m) => send(IPC.sttError, m)),
    system: new WhisperService('system', handleSegment, (m) => send(IPC.sttError, m))
  }

  ipcMain.on(IPC.audioChunk, (_e, source: AudioSource, buf: ArrayBuffer) => {
    services[source]?.feed(new Float32Array(buf))
  })

  ipcMain.on(IPC.audioState, (_e, source: AudioSource, active: boolean) => {
    if (!active) services[source]?.flush()
  })

  ipcMain.handle(IPC.summaryGenerate, () => summarizeTranscript(transcript))

  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch) => setSettings(patch))

  ipcMain.handle(IPC.displayMediaError, () => getLastDisplayMediaError())

  ipcMain.handle(IPC.screenSources, () => listScreenSources())

  ipcMain.handle(IPC.appVersion, () => app.getVersion())

  ipcMain.handle(IPC.diagnostics, async () => {
    const data = await collectDiagnostics()
    return { data, text: formatDiagnostics(data) }
  })

  // Copying via the main process avoids depending on renderer clipboard permissions.
  ipcMain.on(IPC.clipboardWrite, (_e, text: string) => clipboard.writeText(text))

  ipcMain.on(IPC.logEvent, (_e, message: string) => logEvent(message))

  ipcMain.handle(IPC.modelStatus, () => getModelStatus())

  ipcMain.handle(IPC.modelDownload, async (_e, name: string) => {
    // Remember the choice so the next launch resolves the same model.
    setSettings({ modelName: name })
    try {
      await downloadModel(name, (p) => send(IPC.modelProgress, p))
    } catch {
      // The progress event already carried the message to the renderer.
    }
    return getModelStatus()
  })

  ipcMain.on(IPC.modelCancel, () => cancelDownload())

  ipcMain.on(IPC.windowControl, (_e, action: 'minimize' | 'hide' | 'close') => {
    const win = getWin()
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'hide') win.hide()
    else win.close()
  })
}
