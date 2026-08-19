import { createWriteStream, existsSync, statSync } from 'fs'
import { open, rename, unlink } from 'fs/promises'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

export interface DownloadOptions {
  url: string
  /** Final path; the download lands at `${destPath}.part` until verified. */
  destPath: string
  /** Exact expected byte count, used for progress and for verification. */
  expectedBytes: number
  /** Optional magic bytes the finished file must start with. */
  magic?: Buffer
  signal?: AbortSignal
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  /** Minimum gap between onProgress calls, in ms. */
  progressIntervalMs?: number
}

/**
 * Download a large file to `destPath`, resuming a prior partial attempt when one
 * exists. The partial file is left in place on failure so a retry continues from
 * where it stopped; the final rename only happens after verification, so
 * `destPath` never holds a truncated file.
 */
export async function downloadWithResume(opts: DownloadOptions): Promise<void> {
  const { url, destPath, expectedBytes, magic, signal, onProgress } = opts
  const interval = opts.progressIntervalMs ?? 400
  const part = `${destPath}.part`

  let resumeFrom = existsSync(part) ? statSync(part).size : 0
  // A .part at or past the full size is not resumable — it is corrupt.
  if (resumeFrom >= expectedBytes) {
    await unlink(part).catch(() => {})
    resumeFrom = 0
  }

  const res = await fetch(url, {
    headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {},
    signal,
    redirect: 'follow'
  })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`)
  }
  // 200 in reply to a Range request means the server ignored it: restart.
  if (resumeFrom > 0 && res.status !== 206) resumeFrom = 0

  let received = resumeFrom
  let lastEmit = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      const now = performance.now()
      if (now - lastEmit > interval) {
        lastEmit = now
        onProgress?.(received, expectedBytes)
      }
      cb(null, chunk)
    }
  })

  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    counter,
    createWriteStream(part, { flags: resumeFrom > 0 ? 'a' : 'w' }),
    { signal }
  )

  await verifyFile(part, expectedBytes, magic)
  await rename(part, destPath)
  onProgress?.(expectedBytes, expectedBytes)
}

/** Throw unless the file is exactly the expected size and starts with `magic`. */
export async function verifyFile(
  path: string,
  expectedBytes: number,
  magic?: Buffer
): Promise<void> {
  const size = statSync(path).size
  if (size !== expectedBytes) {
    throw new Error(
      `Downloaded file is ${size} bytes, expected ${expectedBytes} — the download was incomplete.`
    )
  }
  if (!magic) return
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(magic.length)
    await fh.read(head, 0, magic.length, 0)
    if (!head.equals(magic)) {
      throw new Error('Downloaded file has an unexpected format — the download may have been redirected.')
    }
  } finally {
    await fh.close()
  }
}
