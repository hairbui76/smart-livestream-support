import { app, desktopCapturer } from 'electron'
import { existsSync } from 'fs'
import { release } from 'os'
import { Diagnostics } from '../shared/types'
import { getLastDisplayMediaError } from './displayMedia'
import { resolveModelPath } from './stt/modelManager'
import { resolveWhisperPaths } from './stt/resources'

/**
 * Collect everything needed to explain a capture failure without a debugger on
 * the user's machine. Screen sources are enumerated here on purpose: it
 * exercises the same call the display-media handler depends on.
 */
export async function collectDiagnostics(): Promise<Diagnostics> {
  let screenSources: string[] = []
  let screenSourceError: string | undefined

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    screenSources = sources.map((s) => `${s.name} (${s.id})`)
  } catch (err) {
    screenSourceError = err instanceof Error ? err.message : String(err)
  }

  const paths = resolveWhisperPaths()
  const modelPath = resolveModelPath()

  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    packaged: app.isPackaged,
    screenSources,
    screenSourceError,
    whisperBinary:
      'error' in paths
        ? { path: paths.error, exists: false }
        : { path: paths.binary, exists: existsSync(paths.binary) },
    modelPath,
    lastDisplayMediaError: getLastDisplayMediaError()
  }
}

/** Render diagnostics as the plain text block a user can paste into a report. */
export function formatDiagnostics(d: Diagnostics, extra: string[] = []): string {
  const lines = [
    `App           ${d.appVersion}${d.packaged ? '' : ' (dev build, not packaged)'}`,
    `Electron      ${d.electron} · Chrome ${d.chrome} · Node ${d.node}`,
    `OS            ${d.platform} ${d.osRelease} ${d.arch}`,
    `Screens       ${
      d.screenSourceError
        ? `ERROR: ${d.screenSourceError}`
        : d.screenSources.length === 0
          ? 'none found (system audio cannot attach)'
          : d.screenSources.join(', ')
    }`,
    `whisper-cli   ${d.whisperBinary.exists ? d.whisperBinary.path : `MISSING — ${d.whisperBinary.path}`}`,
    `Model         ${d.modelPath ?? 'not downloaded'}`,
    `Last capture  ${d.lastDisplayMediaError ?? 'no failure recorded'}`,
    ...extra
  ]
  return lines.join('\n')
}
