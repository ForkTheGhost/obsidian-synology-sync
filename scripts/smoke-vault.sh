#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR="${1:-/tmp/obsidian-synology-sync-smoke-vault}"
PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/synology-sync"

npm test -- --runInBand
npm run build

mkdir -p "$PLUGIN_DIR"
cp manifest.json main.js "$PLUGIN_DIR/"
[ -f styles.css ] && cp styles.css "$PLUGIN_DIR/" || true

cat > "$VAULT_DIR/README-smoke.md" <<'NOTE'
# Synology Sync smoke vault

Open this disposable vault in Obsidian, enable the Synology Sync plugin, configure a test NAS path, and run Sync now. Do not use a primary vault for release smoke testing.
NOTE

printf 'Smoke vault ready: %s\nPlugin copied to: %s\n' "$VAULT_DIR" "$PLUGIN_DIR"
