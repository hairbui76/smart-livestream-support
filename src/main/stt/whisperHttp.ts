import { randomUUID } from 'crypto'
import { request } from 'http'
import { createServer } from 'net'

/**
 * HTTP plumbing for whisper.cpp's `whisper-server`.
 *
 * Deliberately free of Electron imports so it can be exercised against a real
 * server outside the app, the same way downloadFile.ts is.
 */

export interface InferenceResult {
  text: string
  /** Full language name as whisper reports it, e.g. "english". Only in verbose_json. */
  language?: string
}

/** Ask the OS for a port nothing else is using. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address && typeof address === 'object') {
        const { port } = address
        probe.close(() => resolve(port))
      } else {
        probe.close(() => reject(new Error('could not resolve a free port')))
      }
    })
  })
}

/** HTTP status of /health: 200 once the model is loaded, 503 while loading. */
export function health(port: number, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume() // drain; only the status matters
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

export function multipart(
  fields: Record<string, string>,
  wav: Buffer
): { body: Buffer; contentType: string } {
  const boundary = `----slsp${randomUUID().replace(/-/g, '')}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        'Content-Type: audio/wav\r\n\r\n'
    ),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  )
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

function post(port: number, body: Buffer, contentType: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/inference',
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': contentType, 'Content-Length': body.length }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode !== 200) {
            reject(new Error(`whisper-server returned ${res.statusCode}: ${text.slice(0, 200)}`))
            return
          }
          resolve(text)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`no response within ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end(body)
  })
}

/** Run one inference request and normalise the answer. */
export async function infer(
  port: number,
  wav: Buffer,
  fields: Record<string, string>,
  timeoutMs = 60_000
): Promise<InferenceResult> {
  const { body, contentType } = multipart(fields, wav)
  const raw = await post(port, body, contentType, timeoutMs)
  try {
    const parsed = JSON.parse(raw)
    return {
      text: String(parsed.text ?? ''),
      language: typeof parsed.language === 'string' ? parsed.language : undefined
    }
  } catch {
    return { text: raw } // older builds answer with plain text
  }
}
