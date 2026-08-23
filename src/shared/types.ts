export type AudioSource = 'mic' | 'system'

export interface TranscriptSegment {
  id: string
  source: AudioSource
  text: string
  /** ISO timestamp when the segment was finalized */
  at: string
  lang?: string
  /**
   * True while the utterance is still being spoken. Partials share the id of
   * the final segment that replaces them, so the UI updates in place.
   */
  partial?: boolean
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
  /** Explicit path to a ggml model — overrides the downloaded one when set */
  whisperModelPath: string
  /** Which catalog model to use; downloaded into userData/models on first launch */
  modelName: string
  /** 'auto' | 'en' | 'vi' — language hint passed to whisper */
  sttLanguage: string
  /** Enable live translation of each segment */
  autoTranslate: boolean
  /**
   * Show provisional text while someone is still speaking, replaced by the
   * final wording when the utterance ends.
   */
  livePartials: boolean
  /**
   * Trade a little accuracy for much lower latency: greedy decoding, no
   * temperature fallback, and an encoder window sized to the clip instead of
   * the full 30 s whisper always pads to.
   */
  fastMode: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  openaiApiKey: '',
  translateModel: 'gpt-4o-mini',
  summaryModel: 'gpt-4o',
  whisperBinaryPath: '',
  whisperModelPath: '',
  modelName: 'ggml-small.bin',
  sttLanguage: 'auto',
  autoTranslate: true,
  livePartials: true,
  fastMode: true
}

export interface ModelSpec {
  name: string
  label: string
  sizeBytes: number
  note: string
}

/**
 * Downloadable whisper models. Only multilingual builds are listed — the `.en`
 * variants cannot transcribe Vietnamese.
 */
export const MODELS: ModelSpec[] = [
  {
    name: 'ggml-base.bin',
    label: 'Base',
    sizeBytes: 147951465,
    note: 'Fastest. Use on slower CPUs; less accurate.'
  },
  {
    name: 'ggml-small.bin',
    label: 'Small',
    sizeBytes: 487601967,
    note: 'Recommended. Best accuracy/speed balance.'
  }
]

export interface ModelStatus {
  /** Model the app will use, per settings */
  activeModel: string
  /** True when the active model is present on disk and usable */
  ready: boolean
  /** Set when an explicit path in Settings is being used instead of a download */
  overridePath?: string
  downloading?: DownloadProgress
  installed: string[]
}

export interface DownloadProgress {
  name: string
  receivedBytes: number
  totalBytes: number
  done: boolean
  /** Present when the download failed; absent on success or cancellation */
  error?: string
  cancelled?: boolean
}

export interface ScreenSource {
  id: string
  name: string
  displayId: string
}

export interface Diagnostics {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  osRelease: string
  arch: string
  packaged: boolean
  screenSources: string[]
  screenSourceError?: string
  displayCount: number
  lastScreenPick: string | null
  whisperBinary: { path: string; exists: boolean }
  modelPath: string | null
  lastDisplayMediaError: string | null
  /** Which whisper backend is in use, and how it is performing. */
  sttEngine: string
  /** Recent capture events from both processes, oldest first. */
  log: string[]
}

export interface Api {
  getAppVersion(): Promise<string>
  getDiagnostics(): Promise<{ data: Diagnostics; text: string }>
  copyToClipboard(text: string): void
  /** Record a renderer-side capture event into the shared log. */
  logEvent(message: string): void
  sendAudioChunk(source: AudioSource, pcm: Float32Array): void
  setAudioState(source: AudioSource, active: boolean): void
  onSegment(cb: (s: TranscriptSegment) => void): () => void
  onTranslation(cb: (t: TranslationResult) => void): () => void
  onError(cb: (message: string) => void): () => void
  generateSummary(): Promise<string>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Why the last getDisplayMedia request was refused, if it was. */
  getDisplayMediaError(): Promise<string | null>
  getScreenSources(): Promise<ScreenSource[]>
  getModelStatus(): Promise<ModelStatus>
  downloadModel(name: string): Promise<ModelStatus>
  cancelModelDownload(): void
  onModelProgress(cb: (p: DownloadProgress) => void): () => void
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
  displayMediaError: 'display:last-error',
  screenSources: 'display:sources',
  appVersion: 'app:version',
  diagnostics: 'app:diagnostics',
  clipboardWrite: 'app:clipboard-write',
  logEvent: 'app:log-event',
  modelStatus: 'model:status',
  modelDownload: 'model:download',
  modelCancel: 'model:cancel',
  modelProgress: 'model:progress',
  windowControl: 'window:control'
} as const
