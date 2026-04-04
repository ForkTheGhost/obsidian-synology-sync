# Synology Sync for Obsidian

> **Status: BETA** - Looking for testers. See quick install below.

Sync your Obsidian vault directly to a Synology NAS folder using the File Station API. No WebDAV Server package required - uses the same API that DSM's File Station uses internally.

## Beta Testing - Quick Install

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community Plugins (Settings > Community plugins > Browse > search "BRAT")
2. In BRAT settings, click **Add Beta Plugin**
3. Enter: `ForkTheGhost/obsidian-synology-sync`
4. Enable **Synology Sync** in Settings > Community plugins
5. Configure in Settings > Synology Sync:
   - Enter your **QuickConnect ID** (or switch to direct IP/hostname)
   - Enter your DSM **username** and **password**
   - Set the **remote folder path** (e.g. `/homes/username/Obsidian/MyVault`)
6. Click **Sync now** or use the ribbon icon

Works on desktop (Windows, Mac, Linux) and mobile (iOS, Android).

## Features

- **QuickConnect support** - enter your QuickConnect ID and the plugin resolves it to the best available connection (LAN, WAN, or tunnel)
- **Direct connection** - or just enter your NAS IP/hostname and port
- **Bi-directional sync** - upload local changes, download remote changes, or both
- **Conflict resolution** - newer wins, local wins, remote wins, or skip
- **Auto-sync** - configurable interval (or manual-only)
- **Sync on startup** - optionally sync when Obsidian opens
- **Exclude patterns** - regex patterns to skip files/folders
- **No extra packages** - uses Synology's built-in File Station API (port 5000/5001), not WebDAV (which requires installing the WebDAV Server package)

## Why Not Remotely Save?

[Remotely Save](https://github.com/remotely-save/remotely-save) is excellent but uses WebDAV, which requires installing and configuring the Synology WebDAV Server package (port 5005/5006). This plugin uses the File Station API that's always available on any Synology NAS - same port as the DSM web UI.

It also natively supports QuickConnect ID resolution, so you don't need to figure out your NAS's IP address or set up DDNS.

## Setup

1. Install the plugin in Obsidian
2. Open Settings > Synology Sync
3. Choose connection type:
   - **QuickConnect**: enter your QuickConnect ID (e.g. `mynas`)
   - **Direct**: enter IP/hostname and port
4. Enter your DSM username and password
5. Set the remote folder path (e.g. `/homes/username/Obsidian/MyVault`)
6. Click "Sync now" or configure auto-sync

## Commands

| Command | Description |
|---------|-------------|
| Sync with Synology NAS | Bi-directional sync using configured conflict strategy |
| Push all local changes to NAS | Force upload all local files (local wins) |
| Pull all changes from NAS | Force download all remote files (remote wins) |

## Building

```bash
npm install
npm run build        # production build
npm run dev          # development build with sourcemaps
```

Copy `main.js`, `manifest.json`, and `styles.css` (if any) to your vault's `.obsidian/plugins/synology-sync/` folder.

## How It Works

1. **QuickConnect resolution** - POSTs to `global.quickconnect.to/Serv.php` to resolve the ID to a reachable address, then ping-pong tests candidates in priority order (LAN > FQDN > WAN > tunnel)
2. **File Station login** - authenticates via `SYNO.API.Auth` to get a session ID
3. **File listing** - recursively lists both local vault files (via Obsidian Vault API) and remote files (via `SYNO.FileStation.List`)
4. **Diff** - compares mtime and size to identify changes
5. **Sync** - uploads/downloads changed files via `SYNO.FileStation.Upload` and `SYNO.FileStation.Download`
6. **Logout** - closes the File Station session

## Limitations

- File Station API rate limits are generous but not documented; avoid syncing thousands of files simultaneously
- 2FA on the DSM account will require an app password or disabling 2FA for the sync account
- The plugin stores credentials in Obsidian's plugin data (`.obsidian/plugins/synology-sync/data.json`) - this file is not encrypted
- Large binary files may be slow over WAN connections
