import { app, BrowserWindow, desktopCapturer, globalShortcut, session } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 440,
    height: 680,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // The whole point: exclude this window from screen capture / sharing.
  // On Windows this maps to SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE).
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Route getDisplayMedia to WASAPI loopback so the renderer can capture
  // system audio (what the other call participants are saying). Windows only.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}))
  })

  createWindow()
  registerIpc(() => win)

  // Panic key: instantly hide/show the toolbox.
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!win) return
    win.isVisible() ? win.hide() : win.show()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())
