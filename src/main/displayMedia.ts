import { desktopCapturer, DesktopCapturerSource, screen, session } from 'electron'
import { release } from 'os'
import { ScreenSource } from '../shared/types'
import { logEvent } from './eventLog'

/**
 * Reason the last getDisplayMedia request was refused. Chromium reports a bare
 * "user aborted" AbortError to the renderer whichever way the handler declines,
 * so the real cause is kept here for the renderer to read back.
 */
let lastError: string | null = null

export function getLastDisplayMediaError(): string | null {
  return lastError
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Environment details worth having in a bug report about capture failures. */
const diagnostics = (): string =>
  `${process.platform} ${release()}, Electron ${process.versions.electron}`

/** Which source the last request handed to Chromium, for the diagnostics panel. */
let lastPick: string | null = null

export function getLastScreenPick(): string | null {
  return lastPick
}

/**
 * Choose which screen to attach the loopback audio to. With one monitor any
 * source works, but with several, Chromium refuses a source it cannot map to a
 * live display — and taking sources[0] blindly can hand it exactly that. Prefer
 * the primary display, then any source carrying a display id.
 */
function pickScreen(sources: DesktopCapturerSource[]): DesktopCapturerSource {
  const primaryId = String(screen.getPrimaryDisplay().id)
  const chosen =
    sources.find((s) => s.display_id === primaryId) ??
    sources.find((s) => s.display_id) ??
    sources[0]

  lastPick =
    `${chosen.name} id=${chosen.id} display_id=${chosen.display_id || '(empty)'} ` +
    `(primary=${primaryId}, ${sources.length} screen${sources.length === 1 ? '' : 's'})`
  logEvent(`main: granted with ${lastPick}`)
  return chosen
}

/** Screen sources for the renderer's fallback capture path. */
export async function listScreenSources(): Promise<ScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
  return sources.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id }))
}

/**
 * Route getDisplayMedia to WASAPI loopback so the renderer can capture system
 * audio — what the other call participants are saying. Windows only.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    lastError = null
    logEvent(
      `main: display-media handler invoked (audioRequested=${request.audioRequested}, videoRequested=${request.videoRequested})`
    )
    try {
      // A zero thumbnail size skips grabbing screen bitmaps we never use, which
      // is both faster and one less thing that can fail.
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      })

      logEvent(`main: ${sources.length} screen source(s) enumerated`)

      if (sources.length === 0) {
        lastError =
          'Windows reported no capturable screen, so system audio could not be attached. ' +
          'This usually means the app lacks screen-capture access, or is running over Remote Desktop ' +
          `or in a session without a desktop. (${diagnostics()})`
        logEvent(`main: declined — no screen sources`)
        callback({})
        return
      }

      callback({
        video: pickScreen(sources),
        ...(request.audioRequested ? { audio: 'loopback' as const } : {})
      })
    } catch (err) {
      lastError = `Could not enumerate screen sources: ${describe(err)} (${diagnostics()})`
      logEvent(`main: declined — ${describe(err)}`)
      callback({})
    }
  })

  // Electron's defaults are permissive, but an explicit grant makes the audio
  // paths this app needs independent of any default change. 'media' covers
  // getUserMedia; 'display-capture' covers getDisplayMedia.
  const allowed = new Set(['media', 'display-capture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}
