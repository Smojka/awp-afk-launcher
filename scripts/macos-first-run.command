#!/bin/bash
set -euo pipefail

APP_NAMES=("ChunkKeeper.app" "ChunkKeeper Web.app")
INSTALL_DIR="/Applications"

if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
fi

copy_from_dmg() {
  local copied=0

  for app_name in "${APP_NAMES[@]}"; do
    while IFS= read -r -d '' source_app; do
      local target_app="$INSTALL_DIR/$app_name"

      printf 'Installing %s to %s\n' "$app_name" "$INSTALL_DIR"
      rm -rf "$target_app"
      ditto "$source_app" "$target_app"
      copied=1
    done < <(find /Volumes -maxdepth 2 -name "$app_name" -type d -print0 2>/dev/null)
  done

  if [ "$copied" -eq 1 ]; then
    return 0
  fi

  return 1
}

remove_quarantine() {
  local found=0

  for app_name in "${APP_NAMES[@]}"; do
    for app_path in "$INSTALL_DIR/$app_name" "/Applications/$app_name" "$HOME/Applications/$app_name"; do
      if [ -d "$app_path" ]; then
        printf 'Allowing macOS to open %s\n' "$app_path"
        xattr -dr com.apple.quarantine "$app_path" 2>/dev/null || true
        found=1
      fi
    done
  done

  if [ "$found" -eq 1 ]; then
    return 0
  fi

  return 1
}

open_chunkkeeper() {
  for app_path in "$INSTALL_DIR/ChunkKeeper.app" "/Applications/ChunkKeeper.app" "$HOME/Applications/ChunkKeeper.app"; do
    if [ -d "$app_path" ]; then
      printf 'Opening %s\n' "$app_path"
      open "$app_path"
      return 0
    fi
  done

  for app_path in "$INSTALL_DIR/ChunkKeeper Web.app" "/Applications/ChunkKeeper Web.app" "$HOME/Applications/ChunkKeeper Web.app"; do
    if [ -d "$app_path" ]; then
      printf 'Opening %s\n' "$app_path"
      open "$app_path"
      return 0
    fi
  done

  return 1
}

copy_from_dmg || true

if ! remove_quarantine; then
  cat <<'MESSAGE'
ChunkKeeper was not found.

Open the ChunkKeeper DMG first, then run this file again. The app can also be copied to Applications manually before running this helper.
MESSAGE
  read -r -p "Press Return to close this window." _
  exit 1
fi

open_chunkkeeper || true

cat <<'MESSAGE'
Done. If macOS shows a normal first-open confirmation, choose Open.
MESSAGE
read -r -p "Press Return to close this window." _
