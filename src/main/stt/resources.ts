import { existsSync } from 'fs'
import { join } from 'path'
import { getSettings } from '../settings'
import { bundledDir, resolveModelPath } from './modelManager'

export interface WhisperPaths {
  binary: string
  /** Resident HTTP server, when this install bundles it. */
  server: string
  model: string
}

/**
 * Resolve the whisper binary and model. An explicit binary path from Settings
 * wins; otherwise the binary bundled in the app is used. The model comes from
 * the download managed by modelManager.
 */
export function resolveWhisperPaths(): WhisperPaths | { error: string } {
  const { whisperBinaryPath } = getSettings()

  let binary = whisperBinaryPath
  if (!binary || !existsSync(binary)) {
    const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    const candidate = join(bundledDir(), name)
    binary = existsSync(candidate) ? candidate : ''
  }
  if (!binary) {
    return { error: 'whisper-cli binary not found — set its path in Settings.' }
  }

  // Bundled since v0.5.0. Older installs only have the CLI, which still works.
  const serverName = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
  const serverCandidate = join(bundledDir(), serverName)
  const server = existsSync(serverCandidate) ? serverCandidate : ''

  const model = resolveModelPath()
  if (!model) {
    return { error: 'Speech model not downloaded yet — open Settings and download it.' }
  }

  return { binary, server, model }
}
