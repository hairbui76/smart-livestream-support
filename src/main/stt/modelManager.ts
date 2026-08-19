import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { DownloadProgress, MODELS, ModelStatus, ModelSpec } from '../../shared/types'
import { getSettings } from '../settings'
import { downloadWithResume } from './downloadFile'

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** First 4 bytes of a ggml file: magic 0x67676d6c stored little-endian. */
const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67])

/** Emit progress at most this often, to avoid flooding IPC. */
const PROGRESS_INTERVAL_MS = 400

export type ProgressHandler = (p: DownloadProgress) => void

interface ActiveDownload {
  name: string
  controller: AbortController
  progress: DownloadProgress
}

let active: ActiveDownload | null = null

function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function modelPath(name: string): string {
  return join(modelsDir(), name)
}

function specFor(name: string): ModelSpec | undefined {
  return MODELS.find((m) => m.name === name)
}

/** Directory holding the bundled whisper binary, in dev and packaged builds. */
export function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

/**
 * A model file counts as installed only at its exact expected size — a partial
 * or truncated file would make whisper fail with a confusing error instead.
 */
function isInstalled(name: string): boolean {
  const spec = specFor(name)
  const path = modelPath(name)
  if (!spec || !existsSync(path)) return false
  return statSync(path).size === spec.sizeBytes
}

/** Model files shipped inside the app bundle, if any (dev convenience). */
function bundledModel(): string | null {
  const dir = bundledDir()
  if (!existsSync(dir)) return null
  const found = readdirSync(dir).find((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
  return found ? join(dir, found) : null
}

/** Absolute path of the model to run with, or null when nothing is usable yet. */
export function resolveModelPath(): string | null {
  const { whisperModelPath, modelName } = getSettings()
  if (whisperModelPath && existsSync(whisperModelPath)) return whisperModelPath
  if (isInstalled(modelName)) return modelPath(modelName)
  return bundledModel()
}

export function getModelStatus(): ModelStatus {
  const { whisperModelPath, modelName } = getSettings()
  const override = whisperModelPath && existsSync(whisperModelPath) ? whisperModelPath : undefined
  return {
    activeModel: modelName,
    ready: resolveModelPath() !== null,
    overridePath: override,
    downloading: active?.progress,
    installed: MODELS.filter((m) => isInstalled(m.name)).map((m) => m.name)
  }
}

export function cancelDownload(): void {
  active?.controller.abort()
}

/**
 * Download a model into userData/models, resuming a previous partial download
 * when one is present. The partial file is kept on failure or cancellation so a
 * retry continues rather than starting over.
 */
export async function downloadModel(name: string, onProgress: ProgressHandler): Promise<void> {
  const spec = specFor(name)
  if (!spec) throw new Error(`Unknown model: ${name}`)
  if (active) throw new Error(`Already downloading ${active.name}.`)
  if (isInstalled(name)) return

  const controller = new AbortController()
  const progress: DownloadProgress = {
    name,
    receivedBytes: 0,
    totalBytes: spec.sizeBytes,
    done: false
  }
  active = { name, controller, progress }

  try {
    await downloadWithResume({
      url: `${BASE_URL}/${name}`,
      destPath: modelPath(name),
      expectedBytes: spec.sizeBytes,
      magic: GGML_MAGIC,
      signal: controller.signal,
      progressIntervalMs: PROGRESS_INTERVAL_MS,
      onProgress: (receivedBytes) => {
        progress.receivedBytes = receivedBytes
        onProgress({ ...progress })
      }
    })
    onProgress({ ...progress, receivedBytes: spec.sizeBytes, done: true })
  } catch (err) {
    const cancelled = controller.signal.aborted
    onProgress({
      ...progress,
      done: true,
      cancelled,
      error: cancelled ? undefined : err instanceof Error ? err.message : String(err)
    })
    if (!cancelled) throw err
  } finally {
    active = null
  }
}
