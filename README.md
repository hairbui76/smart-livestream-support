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

## Installing

Grab the installer from the [latest release](https://github.com/hairbui76/smart-livestream-support/releases/latest) and run it.

**On first launch** the app asks for a one-time speech-model download and shows progress:

| Model | Size | When to pick it |
| --- | --- | --- |
| Base | 141 MB | Slower CPUs; faster but less accurate |
| Small | 465 MB | Recommended — best accuracy/speed balance |

The model lands in `%APPDATA%/Smart Livestream Support/models/` and is reused on every later launch. Downloads resume if interrupted, and are verified by exact size and file signature before being used. Only the model download touches the network for speech — **transcription itself always runs locally**, so no audio leaves your machine.

Then paste an OpenAI API key (from https://platform.openai.com/api-keys) into **⚙ Settings** to enable translation and summaries. Defaults: `gpt-4o-mini` for live translation (fast/cheap), `gpt-4o` for summaries.

## Developing

```bash
npm install
bash scripts/download-whisper.sh   # fetches whisper-cli.exe + DLLs (git-ignored)
```

The whisper binary (~20 MB) is bundled into builds; the model is not. Add `--with-model` to the script to also pre-download `ggml-small.bin` into `resources/whisper/`, which the app will then use instead of downloading at runtime — handy when working offline.

To use a different binary (e.g. a CUDA build) or model, set explicit paths in **⚙ Settings**; they override both the bundle and the download.

## Run in development

```bash
npm run dev
```

> The capture-hiding and system-audio loopback features are Windows-specific; on Linux/macOS the app runs but those features degrade.

## Build a Windows installer

**On Windows** — produces `release/Smart Livestream Support Setup <version>.exe`:

```bash
npm run dist:win
```

**On Linux/macOS** — building the NSIS installer for Windows requires `wine`. Without it, you can still produce a portable ZIP (unzip and run the `.exe` inside; no installer):

```bash
npm run dist:win:zip
```

## Releases

Versioning and changelog are handled by [release-please](https://github.com/googleapis/release-please), driven by [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: …` → minor bump · `fix: …` → patch bump · `feat!: …` / `BREAKING CHANGE:` → major bump
- Pushing to `main` opens/updates a **release PR** that bumps the version and writes `CHANGELOG.md`
- **Merging that PR** creates the git tag and GitHub Release, then `.github/workflows/release.yml` builds the Windows installer on a `windows-latest` runner and attaches it to the release

The installer job downloads the whisper binary itself, since it is git-ignored. The installer stays under ~100 MB because the speech model is fetched by the app on first launch instead of being packaged.

> Builds are **unsigned**, so Windows SmartScreen will warn on first run ("More info" → "Run anyway"). Add a code-signing certificate to `electron-builder.yml` for public distribution.

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
  ├─ modelManager: first-launch model download (resumable, verified)
  ├─ OpenAI translate (gpt-4o-mini): EN↔VI per segment
  └─ OpenAI summarize (gpt-4o): full-transcript summary on demand
```

## Notes & limits

- Transcript lives in memory only; closing the app clears it.
- The API key is stored in plaintext in Electron's `userData/settings.json`.
- Latency per utterance ≈ utterance length detection (0.8 s silence) + whisper inference. Use `ggml-base.bin` or a machine with a fast CPU if `small` feels slow.
