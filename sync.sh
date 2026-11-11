#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
live="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mod="docker-manager"
src="$root/mods/$mod"
dst="$live/$mod"

if [ ! -d "$src" ]; then
  echo "missing $src" >&2
  exit 1
fi

mkdir -p "$dst"
rsync -a --delete \
  --exclude 'gpui-kit.d.ts' \
  --exclude 'jsconfig.json' \
  --exclude '.cache-*' \
  --exclude '__pycache__' \
  "$src/" "$dst/"
herdr-app check "$dst"

echo "Synced: $mod -> $dst"
