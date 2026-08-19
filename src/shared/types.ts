export type AudioSource = 'mic' | 'system'

export interface TranscriptSegment {
  id: string
  source: AudioSource
  text: string
  /** ISO timestamp when the segment was finalized */
  at: string
  lang?: string
}

export interface TranslationResult {
  segmentId: string
  translation: string
  detectedLang: string
}

export interface AppSettings {
  openaiApiKey: string
  translateModel: string
  summaryModel: string
  /** Path to the whisper.cpp CLI binary (whisper-cli.exe / main.exe) */
  whisperBinaryPath: string
  /** Path to a multilingual ggml model, e.g. ggml-small.bin */
  whisperModelPath: string
  /** 'auto' | 'en' | 'vi' — language hint passed to whisper */
  sttLanguage: string
  /** Enable live translation of each segment */
  autoTranslate: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  openaiApiKey: '',
  translateModel: 'gpt-4o-mini',
  summaryModel: 'gpt-4o',
  whisperBinaryPath: '',
  whisperModelPath: '',
  sttLanguage: 'auto',
  autoTranslate: true
}

export interface Api {
  sendAudioChunk(source: AudioSource, pcm: Float32Array): void
  setAudioState(source: AudioSource, active: boolean): void
  onSegment(cb: (s: TranscriptSegment) => void): () => void
  onTranslation(cb: (t: TranslationResult) => void): () => void
  onError(cb: (message: string) => void): () => void
  generateSummary(): Promise<string>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  windowControl(action: 'minimize' | 'hide' | 'close'): void
}

export const IPC = {
  audioChunk: 'audio:chunk',
  audioState: 'audio:state',
  sttSegment: 'stt:segment',
  sttError: 'stt:error',
  translationResult: 'translate:result',
  summaryGenerate: 'summary:generate',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  windowControl: 'window:control'
} as const
