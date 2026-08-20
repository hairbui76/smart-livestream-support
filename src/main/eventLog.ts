import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

const MAX_BYTES = 128 * 1024

const logPath = (): string => join(app.getPath('userData'), 'capture.log')

/**
 * Append one capture event to a log in userData. Events from both processes go
 * here, so a failure stays readable after a restart — the diagnostics report no
 * longer depends on being opened before the app is reopened.
 */
export function logEvent(message: string): void {
  try {
    const path = logPath()
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      // Keep the newest half rather than growing without bound.
      writeFileSync(path, readFileSync(path, 'utf-8').slice(-MAX_BYTES / 2), 'utf-8')
    }
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, 'utf-8')
  } catch {
    // Logging must never be the reason capture fails.
  }
}

export function readLogTail(lines = 30): string[] {
  try {
    const path = logPath()
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').trimEnd().split('\n').slice(-lines)
  } catch {
    return []
  }
}
