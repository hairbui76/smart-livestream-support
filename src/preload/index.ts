import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  AppSettings,
  AudioSource,
  TranscriptSegment,
  TranslationResult
} from '../shared/types'
import { IPC } from '../shared/types'

const api: Api = {
  sendAudioChunk(source: AudioSource, pcm: Float32Array): void {
    // Transfer the underlying buffer; structured clone handles ArrayBuffer fine.
    ipcRenderer.send(IPC.audioChunk, source, pcm.buffer)
  },
  setAudioState(source: AudioSource, active: boolean): void {
    ipcRenderer.send(IPC.audioState, source, active)
  },
  onSegment(cb: (s: TranscriptSegment) => void): () => void {
    const listener = (_e: unknown, s: TranscriptSegment): void => cb(s)
    ipcRenderer.on(IPC.sttSegment, listener)
    return () => ipcRenderer.removeListener(IPC.sttSegment, listener)
  },
  onTranslation(cb: (t: TranslationResult) => void): () => void {
    const listener = (_e: unknown, t: TranslationResult): void => cb(t)
    ipcRenderer.on(IPC.translationResult, listener)
    return () => ipcRenderer.removeListener(IPC.translationResult, listener)
  },
  onError(cb: (message: string) => void): () => void {
    const listener = (_e: unknown, m: string): void => cb(m)
    ipcRenderer.on(IPC.sttError, listener)
    return () => ipcRenderer.removeListener(IPC.sttError, listener)
  },
  generateSummary(): Promise<string> {
    return ipcRenderer.invoke(IPC.summaryGenerate)
  },
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(IPC.settingsGet)
  },
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  windowControl(action: 'minimize' | 'hide' | 'close'): void {
    ipcRenderer.send(IPC.windowControl, action)
  }
}

contextBridge.exposeInMainWorld('api', api)
