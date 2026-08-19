import { BrowserWindow, ipcMain } from 'electron'
import { AudioSource, IPC, TranscriptSegment } from '../shared/types'
import { summarizeTranscript, translateText } from './ai/openaiService'
import { getSettings, setSettings } from './settings'
import { WhisperService } from './stt/whisperService'

export function registerIpc(getWin: () => BrowserWindow | null): void {
  const transcript: TranscriptSegment[] = []

  const send = (channel: string, payload: unknown): void => {
    getWin()?.webContents.send(channel, payload)
  }

  const handleSegment = (segment: TranscriptSegment): void => {
    transcript.push(segment)
    send(IPC.sttSegment, segment)
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

  ipcMain.on(IPC.windowControl, (_e, action: 'minimize' | 'hide' | 'close') => {
    const win = getWin()
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'hide') win.hide()
    else win.close()
  })
}
