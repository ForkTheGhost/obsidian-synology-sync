# Synology Sync for Obsidian

> **Status: BETA** - Looking for testers. See QuickStart below.

Sync your Obsidian vault directly to a Synology NAS folder using the File Station API. No WebDAV Server package required - uses the same API that DSM's File Station uses internally.

## QuickStart

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

> Note: the current default backend syncs files through Synology File Station. An experimental Git filesystem backend is available for desktop vaults with native Git installed; follow-up File Station / QuickConnect Git transport work is tracked in [issue #31](https://github.com/VertigoRay/obsidian-synology-sync/issues/31).

## Features

- **QuickConnect support** - enter your QuickConnect ID and the plugin resolves it to the best available connection (LAN, WAN, or tunnel)
- **Direct connection** - or just enter your NAS IP/hostname and port
- **Bi-directional sync** - upload local changes, download remote changes, or both
- **Conflict resolution** - newer wins, local wins, remote wins, or skip
- **Auto-sync** - configurable interval (or manual-only)
- **Sync on startup** - optionally sync when Obsidian opens
- **Exclude patterns** - regex patterns to skip files/folders
- **Experimental Git filesystem backend** - desktop-only sync against a bare Git repo on a local, mounted, or UNC path
- **No extra packages** - uses Synology's built-in File Station API (port 5000/5001), not WebDAV (which requires installing the WebDAV Server package)

## Why Not Remotely Save?

[Remotely Save](https://github.com/remotely-save/remotely-save) is excellent but uses WebDAV, which requires installing and configuring the Synology WebDAV Server package (port 5005/5006). This plugin uses the File Station API that's always available on any Synology NAS - same port as the DSM web UI.

It also natively supports QuickConnect ID resolution, so you don't need to figure out your NAS's IP address or set up DDNS.

## Git-Backed Sync

Git-backed sync is experimental and currently supports a filesystem remote only. Use it when the NAS path is reachable as a local, mounted, or UNC path and the device has native Git installed. QuickConnect/File Station transport for Git remotes remains future work tracked in [issue #31](https://github.com/VertigoRay/obsidian-synology-sync/issues/31).

The recommended shape is a normal local Obsidian vault on every device, with the Synology NAS storing a **bare** Git repository as the shared upstream.

Recommended layout:

```text
Synology share:
  \\Synology\Obsidian\MyVault.git    # bare repo; do not open as an Obsidian vault

Each device:
  C:\Users\Ray\Vaults\MyVault        # normal Obsidian vault clone
```

Important Git/UNC notes:

- A central filesystem remote should be created with `git init --bare <path>`.
- The folder name does **not** have to end in `.git`, but the `.git` suffix is strongly recommended because it signals "repository storage, not editable notes."
- `--bare` is required either way. `git init \\Synology\Obsidian\MyVault.git` without `--bare` creates a normal working repo inside a confusingly named folder.
- Do not open the NAS bare repo as your Obsidian vault. Open the local clone on each device.
- Avoid multiple users or agents editing one shared UNC working tree directly. `git commit` records a snapshot; it is not a lock, and it can accidentally include someone else's uncommitted edits from the shared working tree.
- If you deliberately use a shared UNC working tree anyway, treat it as advanced/manual usage: commit before assuming changes are durable or publishable, and understand that commits still do not isolate your edits from other writers.

First-run guidance for a future Git-backed setup:

First-run behavior:

- A brand-new Obsidian vault is treated as "effectively empty" even if Obsidian has created `.obsidian/` metadata. If the destination already has history, the plugin checks out or merges the destination into the local vault without deleting user files first.
- If the local vault has files and the destination is empty, the plugin commits the local vault and pushes it as the initial history.
- If both local and destination have files/history, the plugin checkpoints the local vault first, then merges the destination. It does not silently overwrite local edits.
- If someone edited locally before enabling the plugin, those edits become a local bootstrap commit before any pull/merge happens.

Example initialization:

```powershell
git init --bare \\Synology\Obsidian\MyVault.git
git clone \\Synology\Obsidian\MyVault.git C:\Users\Ray\Vaults\MyVault
```

For agent workflows, prefer giving each agent its own clone and having it commit/push from there. If an agent writes directly through UNC/filesystem access, treat that as advanced usage: it needs an explicit commit/checkpoint workflow and clear ownership to avoid mixing changes.

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

In the experimental Git filesystem backend, **Sync with Synology NAS** runs the Git commit/fetch/merge/push cycle. The force push/pull commands are File Station backend shortcuts.

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

## Contributing

### Issues

All features and bug reports must be tracked as GitHub Issues before any work begins. Issues are the authoritative record of intent — PRs without a corresponding issue will not be merged.

### Pull Requests

All changes require a PR. Direct commits to the default branch are not permitted.

**PR requirements:**
- Reference the issue in the PR description (`Closes #N` or `Ref #N`)
- Include a `CHANGELOG.md` entry — one entry per issue, referencing the issue number for full context
- All code review comments must be acknowledged and addressed before merge — no unresolved items at merge time
