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
  /** Explicit path to a ggml model — overrides the downloaded one when set */
  whisperModelPath: string
  /** Which catalog model to use; downloaded into userData/models on first launch */
  modelName: string
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
  modelName: 'ggml-small.bin',
  sttLanguage: 'auto',
  autoTranslate: true
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

export interface Api {
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
  modelStatus: 'model:status',
  modelDownload: 'model:download',
  modelCancel: 'model:cancel',
  modelProgress: 'model:progress',
  windowControl: 'window:control'
} as const
