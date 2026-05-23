# Disposable smoke-vault workflow

Use this workflow before release or while validating Git-backed File Station changes.

```bash
./scripts/smoke-vault.sh /tmp/obsidian-synology-sync-smoke-vault
```

The script runs the Jest suite, builds `main.js`, creates a disposable Obsidian vault, and copies `manifest.json`/`main.js` into `.obsidian/plugins/synology-sync/`.

Open the disposable vault in Obsidian, enable the plugin, and test only against a disposable NAS folder or bare repo. Do **not** point smoke tests at a primary vault or production NAS repo.

Recommended manual checks:

1. Simple File Sync over File Station can upload/download a note.
2. Git-Backed Sync over File Station can bootstrap an empty vault and an existing remote.
3. Re-running an unchanged Git-backed sync does not create conflict copies.
4. A second concurrent Git-backed writer is blocked by the lease or by expected-old-ref safety.
5. `.obsidian` config policy defaults to Notes only, and selected-settings opt-ins include only the selected categories.
