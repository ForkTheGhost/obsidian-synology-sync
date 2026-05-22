# Synology Sync for Obsidian

> **Status: BETA** - Looking for testers.

Sync your Obsidian vault with a Synology NAS using the File Station API. No WebDAV Server package required.

## Which sync option should I choose?

This plugin supports File Station connections through QuickConnect or a direct Synology address. After connecting, choose one of two sync styles.

### Option 1: Simple File Sync over File Station

Choose this if you want the easiest setup.

Use this when:

- You are one person syncing one vault.
- You usually use one device at a time.
- You want the NAS folder to contain normal Markdown files you can browse in File Station.
- You want the most straightforward mobile-friendly mode.
- You will rely on Synology's native backup tools for historical backups.

What it does:

```text
Your Obsidian vault  <->  normal NAS folder of notes
```

You configure a **Remote folder path**, for example:

```text
/homes/username/Obsidian/MyVault
```

This is the default mental model: “copy my changed notes between Obsidian and a Synology folder.” It is best for single-user workflows where only one device is actively syncing at a time.

### Option 2: Git-Backed Sync over File Station

Choose this if you want every device to keep its own vault, while the NAS keeps the shared history that ties them together.

Use this when:

- You want each device to keep its own local vault.
- You want the NAS to keep Git history for that vault.
- You understand this mode is still beta while multi-device conflict/lock safety is being hardened.
- You understand that the NAS folder is not the readable notes folder.

What it does:

```text
Each device has a normal Obsidian vault
             <->
Synology stores a bare Git repo, such as MyVault.git
```

You configure a **NAS bare Git repository path**, for example:

```text
/homes/username/Obsidian/MyVault.git
```

Important: `MyVault.git` is repository storage. Do **not** open it as an Obsidian vault. Open the local vault/checkout on each device.

## Quick start: Simple File Sync over File Station

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's Community Plugins.
2. In BRAT settings, click **Add Beta Plugin**.
3. Enter: `ForkTheGhost/obsidian-synology-sync`.
4. Enable **Synology Sync** in Settings > Community plugins.
5. Open Settings > Synology Sync.
6. Choose **Simple File Sync over File Station**.
7. Enter your **QuickConnect ID** or direct NAS hostname/IP.
8. Enter your DSM username and password.
9. Set the **Remote folder path**, for example `/homes/username/Obsidian/MyVault`.
10. Click **Sync now** or use the ribbon icon.

Works on desktop and mobile.

## Commands

| Command | Description |
|---------|-------------|
| Sync with Synology NAS | Sync using the selected sync mode |
| Push all local changes to NAS | File-sync shortcut: local wins |
| Pull all changes from NAS | File-sync shortcut: remote wins |

In Git-backed modes, **Sync with Synology NAS** runs the Git commit/fetch/merge/push cycle. The force push/pull commands are simple File Station shortcuts.

## What the settings mean

### QuickConnect or direct connection

The plugin can connect through your Synology QuickConnect ID or a direct NAS hostname/IP.

QuickConnect is easiest when you do not want to manage local IP addresses, DDNS, or VPN details.

### Remote folder path

Use this only for **Simple File Sync over File Station**.

It points to a normal NAS folder full of readable Markdown files.

### NAS bare Git repository path

Use this only for **Git-Backed Sync over File Station**.

It points to a bare Git repository. A bare Git repository usually ends in `.git` and contains Git internals like `HEAD`, `objects/`, and `refs/`.

## Why not Remotely Save?

[Remotely Save](https://github.com/remotely-save/remotely-save) is excellent but uses WebDAV, which requires installing and configuring Synology's WebDAV Server package. This plugin uses Synology's built-in File Station API, the same API DSM File Station uses.

It also supports QuickConnect ID resolution, so you do not need to know your NAS IP address or set up DDNS.

## Limitations and safety notes

- This plugin is beta software. Keep backups.
- File Station API rate limits are generous but not documented; avoid syncing huge vaults all at once.
- 2FA on the DSM account may require an app password or a sync-specific account.
- Credentials are stored in Obsidian plugin data (`.obsidian/plugins/synology-sync/data.json`) and are not encrypted by this plugin.
- Large binary files may be slow over WAN connections.
- Git-backed sync uses a bare repo as the source of truth; do not edit the bare repo as if it were a notes folder.
- A NAS-side readable mirror of a Git-backed vault is optional convenience, not the source of truth.

## For developers

Build, test, contribution, and pull request rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

Architecture and sync-mode design rules live in [ARCHITECTURE.md](ARCHITECTURE.md).
