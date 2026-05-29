#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
Usage: scripts/install-synology-sync-bare-hook.sh /path/to/Vault.git

Installs the Synology Sync native/admin Git push guard as hooks/pre-receive in
a bare repository. Run only when no Obsidian sync is active.
EOF
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

repo=$1
hook_src="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/hooks/synology-sync-pre-receive"
hook_dir="$repo/hooks"
hook_dst="$hook_dir/pre-receive"

if [ ! -d "$repo" ]; then
  printf 'Bare repo path does not exist: %s\n' "$repo" >&2
  exit 1
fi

if [ ! -d "$hook_dir" ]; then
  printf 'Git hooks directory does not exist: %s\n' "$hook_dir" >&2
  exit 1
fi

if [ ! -f "$repo/HEAD" ] || [ ! -d "$repo/objects" ] || [ ! -d "$repo/refs" ]; then
  printf 'Path does not look like a bare Git repository: %s\n' "$repo" >&2
  exit 1
fi

if [ -e "$hook_dst" ]; then
  backup="$hook_dst.synology-sync-backup.$(date +%Y%m%d%H%M%S)"
  cp "$hook_dst" "$backup"
  printf 'Backed up existing pre-receive hook to %s\n' "$backup"
fi

cp "$hook_src" "$hook_dst"
chmod +x "$hook_dst"
printf 'Installed Synology Sync pre-receive guard at %s\n' "$hook_dst"
