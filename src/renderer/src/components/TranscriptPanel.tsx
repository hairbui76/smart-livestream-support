import { useEffect, useRef } from 'react'
import type { Entry } from '../App'

export default function TranscriptPanel({ entries }: { entries: Entry[] }): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  if (entries.length === 0) {
    return (
      <div className="empty">
        Turn on <b>Mic</b> and/or <b>Call audio</b> to start live transcription.
        <br />
        <small>Ctrl+Shift+Space hides/shows this toolbox instantly.</small>
      </div>
    )
  }

  return (
    <div className="transcript">
      {entries.map((e) => (
        <div key={e.id} className={`entry ${e.source}`}>
          <div className="entry-meta">
            <span className="badge">{e.source === 'mic' ? 'You' : 'Call'}</span>
            <span className="time">{e.at.slice(11, 19)}</span>
            {e.detectedLang && <span className="lang">{e.detectedLang}</span>}
          </div>
          <div className="entry-text">{e.text}</div>
          {e.translation && <div className="entry-translation">{e.translation}</div>}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
