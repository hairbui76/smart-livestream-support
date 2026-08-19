# Smart Livestream Support

A floating AI toolbox for livestreams and video calls on **Windows**. It stays on top of every window for you, but is **invisible to screen sharing and recording** (Zoom, Meet, Teams, OBS, …).

## Features

- **Hidden from capture** — uses `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` via Electron's `setContentProtection`. Requires Windows 10 2004+.
- **Live transcription** of two channels:
  - 🎤 **Mic** — what you say (microphone)
  - 🔊 **Call audio** — what everyone else says (WASAPI system loopback)
  - Speech-to-text runs **locally** with [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — private, free, offline.
- **Live translation** English ↔ Vietnamese for every utterance (OpenAI).
- **Meeting summary** on demand — overview, key points, questions raised, action items, in English and Vietnamese.
- **Panic key**: `Ctrl+Shift+Space` instantly hides/shows the toolbox.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. whisper.cpp (local speech-to-text) — bundled

`resources/whisper/` ships with `whisper-cli.exe` (whisper.cpp v1.9.2, Windows x64), its DLLs, and the multilingual `ggml-small.bin` model — the app finds them automatically, and `npm run dist:win` packs them into the installer. **No setup needed.**

These files are git-ignored (487 MB model); after a fresh clone, restore them with:

```bash
bash scripts/download-whisper.sh
```

To use a different binary (e.g. a CUDA build) or model, set explicit paths in **⚙ Settings** — they override the bundled copies.

### 3. OpenAI API key

Create a key at https://platform.openai.com/api-keys and paste it in **⚙ Settings**. Defaults: `gpt-4o-mini` for live translation (fast/cheap), `gpt-4o` for summaries.

## Run in development

```bash
npm run dev
```

> The capture-hiding and system-audio loopback features are Windows-specific; on Linux/macOS the app runs but those features degrade.

## Build a Windows installer

```bash
npm run dist:win
```

Output lands in `release/`.

## How it works

```
Renderer (React UI)
  ├─ getUserMedia (mic) ──┐
  ├─ getDisplayMedia ─────┤  AudioWorklet taps PCM, downsamples to 16 kHz mono,
  │   (WASAPI loopback)   │  batches ~250 ms chunks over IPC
  ▼                       ▼
Main process
  ├─ WhisperService (per source): energy-based VAD cuts utterances,
  │    runs whisper.cpp CLI on each utterance → transcript segment
  ├─ OpenAI translate (gpt-4o-mini): EN↔VI per segment
  └─ OpenAI summarize (gpt-4o): full-transcript summary on demand
```

## Notes & limits

- Transcript lives in memory only; closing the app clears it.
- The API key is stored in plaintext in Electron's `userData/settings.json`.
- Latency per utterance ≈ utterance length detection (0.8 s silence) + whisper inference. Use `ggml-base.bin` or a machine with a fast CPU if `small` feels slow.
