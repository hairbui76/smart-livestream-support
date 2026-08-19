import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { AppSettings, DEFAULT_SETTINGS } from '../shared/types'

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

let cached: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cached) return cached
  try {
    if (existsSync(settingsPath())) {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      const loaded: AppSettings = { ...DEFAULT_SETTINGS, ...raw }
      cached = loaded
      return loaded
    }
  } catch (err) {
    console.error('Failed to read settings, using defaults:', err)
  }
  cached = { ...DEFAULT_SETTINGS }
  return cached
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
