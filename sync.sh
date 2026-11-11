#!/bin/sh
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.config/herdr-app/mods/docker-manager"
mkdir -p "$TARGET"
cp -r "$ROOT/mods/docker-manager/"* "$TARGET/"
export PATH="$HOME/.local/bin:$PATH"
herdr-app check "$ROOT/mods/docker-manager"
