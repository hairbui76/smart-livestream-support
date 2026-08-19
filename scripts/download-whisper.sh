#!/usr/bin/env bash
# Downloads the whisper.cpp Windows binary into resources/whisper/.
# These files are git-ignored; run this once after cloning the repo.
#
# The speech model is NOT needed here — the app downloads it into userData on
# first launch. Pass --with-model to grab it anyway (useful offline).
set -euo pipefail

WHISPER_VERSION="v1.9.2"
MODEL="ggml-small.bin" # multilingual, needed for Vietnamese
WITH_MODEL="${1:-}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/resources/whisper"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f whisper-cli.exe ]; then
  echo "Downloading whisper.cpp $WHISPER_VERSION (Windows x64)..."
  curl -L -o whisper-bin-x64.zip \
    "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION/whisper-bin-x64.zip"
  unzip -o -q whisper-bin-x64.zip -d _tmp
  mv _tmp/Release/whisper-cli.exe .
  mv _tmp/Release/whisper.dll _tmp/Release/ggml*.dll .
  /bin/rm -rf _tmp whisper-bin-x64.zip
fi

if [ "$WITH_MODEL" = "--with-model" ] && [ ! -f "$MODEL" ]; then
  echo "Downloading $MODEL (~465 MB)..."
  curl -L -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
fi

echo "Done. Contents of $DIR:"
ls -la "$DIR"
