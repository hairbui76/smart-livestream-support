# Speech pipeline latency

Why the whisper flags in `src/main/stt/whisperEngine.ts` look the way they do.
Every number here was measured, not estimated — if you change a flag, re-measure
before deciding it made no difference.

## Where the delay comes from

A subtitle cannot appear until all of this has happened:

| Stage | Old cost | Now |
| --- | --- | --- |
| Wait for the speaker to stop | 800 ms of silence | 500 ms, and provisional text appears while they are still talking |
| Load the model | **every utterance** (~500 MB) | once, at startup |
| Encode | full 30 s window, always | window sized to the clip |
| Detect the language | **every utterance**, extra full encoder pass | once per source, then reused |
| Decode | beam search, width 5 | greedy |
| Recover from a bad decode | up to 6 re-decodes, silently | disabled in fast mode |

## Measurements

Machine: Xeon E5-2696 v3 @ 2.30 GHz (old and slow — a modern laptop is faster,
but the *ratios* hold). Model `ggml-small.bin`, a 2.5 s clip of speech.

Through `whisper-cli`, one process per utterance:

```
old flags  (-l auto -nt -t 4)                        13.47 s wall
fast flags (-l auto -nt -t 8 -bs 1 -bo 1 -nf -ac 512) 4.87 s wall
fast flags with the language pinned (-l en)            1.63 s wall
```

All three produced identical text: `And so, my fellow Americans,`

Through the resident `whisper-server`, no per-utterance model load:

```
old configuration (auto, full context, beam 5)  4717 ms
new configuration (pinned language, ac 512)     1235 ms   → 3.8x
second request (model already resident)         1293 ms
```

Server startup: 524 ms to `/health` 200, paid once.

## The three findings that mattered

**Auto-detect costs an entire extra encoder pass, at full context.** This is the
one that surprises people. `-l auto` runs the encoder twice — once to identify
the language, once to transcribe — and the detection pass ignores `audio_ctx`:

```
-l auto → encode 4187 ms / 2 runs     4.91 s total
-l en   → encode  988 ms / 1 run      1.63 s total
```

So the app detects the language once per audio source, remembers it, and
re-checks every 20 utterances in case the speaker switches. Choosing the
language explicitly in Settings skips even the first detection.

**Whisper always pads audio to 30 seconds.** The encoder runs over 1500 frames
whether the clip is 1 second or 30. `-ac`/`audio_ctx` trims that window to fit
the clip, which is why a 2.5 s utterance no longer costs what a 30 s one does.
Sized at ~50 frames per second of audio plus headroom, floored at 512.

**`whisper-cli` is a batch tool with batch defaults.** Beam search width 5 and
temperature fallback are right for transcribing a file overnight and wrong for a
live call, where a predictable 1 s beats an unpredictable 1–6 s. whisper.cpp's
own streaming example (`examples/stream`) decodes greedily for the same reason.

## Things that look wrong but are not

- **`whisper-server` has no `--no-context` flag** despite its README listing
  `-nc`. It rejects the flag and exits immediately. Cross-segment context is
  already off by default there, so the app passes nothing. The server's stderr
  is captured into the app log precisely so a mistake like this is visible
  instead of silently falling back to the slow path.
- **`audio_ctx` is sent per request, not at startup.** Every utterance has a
  different length, so the window has to be sized per request.
- **`no_language_probabilities: true` is always sent.** Without it, the
  `verbose_json` response format computes a full probability table over ~99
  languages — an extra pass, purely to fill in a field nothing reads.
- **Partial results are dropped, not queued.** If the engine is busy with a
  final, a skipped draft costs nothing while a queued one delays the text that
  actually matters.

## If it is still slow

1. Set the speech language explicitly instead of Auto-detect.
2. Switch to `ggml-base.bin` in the model panel — a much smaller model.
3. Check the 🩺 panel: every utterance logs its audio length, engine, wall time,
   and realtime factor, e.g.

   ```
   stt: mic 2.4s audio → 830 ms on server (2.9x realtime, waited 0 ms, queue 0)
   ```

   Below 1.0x realtime the app cannot keep up with continuous speech and the lag
   will grow; the log says so explicitly when the queue backs up.
