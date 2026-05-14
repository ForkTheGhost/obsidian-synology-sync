#!/bin/sh
# Demo: materialize a human-readable working copy from a Synology-hosted bare repo.
#
# Use this from Synology Task Scheduler if you want File Station/browser access
# to normal Markdown files. Treat MIRROR_DIR as derived/read-only: this script
# discards uncommitted mirror changes so the bare repo stays the source of truth.
#
# Configure these for your environment before running. Do not commit personal
# paths or credentials into this repo.

set -eu

REPO="/volume1/path/to/MyVault.git"
MIRROR_DIR="/volume1/path/to/MyVault-mirror"
BRANCH="main"

if [ ! -d "$MIRROR_DIR/.git" ]; then
  rm -rf "$MIRROR_DIR"
  git clone "$REPO" "$MIRROR_DIR"
fi

cd "$MIRROR_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
git clean -fd
