import { app } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { getSettings } from '../settings'

/** Directory holding the bundled whisper binary + model, in dev and packaged builds. */
function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'resources', 'whisper')
}

export interface WhisperPaths {
  binary: string
  model: string
}

/**
 * Resolve the whisper binary and model. Explicit paths from Settings win;
 * otherwise fall back to the copies bundled under resources/whisper.
 */
export function resolveWhisperPaths(): WhisperPaths | { error: string } {
  const { whisperBinaryPath, whisperModelPath } = getSettings()
  const dir = bundledDir()

  let binary = whisperBinaryPath
  if (!binary || !existsSync(binary)) {
    const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    const candidate = join(dir, name)
    binary = existsSync(candidate) ? candidate : ''
  }

  let model = whisperModelPath
  if (!model || !existsSync(model)) {
    const found = existsSync(dir)
      ? readdirSync(dir).find((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      : undefined
    model = found ? join(dir, found) : ''
  }

  if (!binary) return { error: 'whisper-cli binary not found (bundle missing and no path set in Settings).' }
  if (!model) return { error: 'Whisper model (.bin) not found (bundle missing and no path set in Settings).' }
  return { binary, model }
}
