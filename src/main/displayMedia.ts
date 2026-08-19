import { desktopCapturer, session } from 'electron'
import { release } from 'os'

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

/**
 * Route getDisplayMedia to WASAPI loopback so the renderer can capture system
 * audio — what the other call participants are saying. Windows only.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    lastError = null
    try {
      // A zero thumbnail size skips grabbing screen bitmaps we never use, which
      // is both faster and one less thing that can fail.
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      })

      if (sources.length === 0) {
        lastError =
          'Windows reported no capturable screen, so system audio could not be attached. ' +
          'This usually means the app lacks screen-capture access, or is running over Remote Desktop ' +
          `or in a session without a desktop. (${diagnostics()})`
        callback({})
        return
      }

      callback({
        video: sources[0],
        ...(request.audioRequested ? { audio: 'loopback' as const } : {})
      })
    } catch (err) {
      lastError = `Could not enumerate screen sources: ${describe(err)} (${diagnostics()})`
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
