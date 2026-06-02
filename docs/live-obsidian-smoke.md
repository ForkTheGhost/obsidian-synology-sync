# Live Obsidian smoke

This smoke test launches the built plugin inside a disposable Obsidian Desktop
vault, enables the plugin, and drives sync through Obsidian's live `app.vault`
APIs. The remote side is a local bare Git repository exposed through a
File Station-shaped adapter, so the test proves plugin/runtime behavior without
depending on LAN or DSM API timing.

Run it from the repo root after building:

```bash
npm run build
npm run smoke:obsidian-live
```

Prerequisites:

- Close any already-running Obsidian instance.
- Install Obsidian Desktop at the default Windows path, or set `OBSIDIAN_EXE`.
- Optional: set `OBSIDIAN_LIVE_SMOKE_FILE_COUNT` to change the seeded vault size.
- Optional: set `OBSIDIAN_LIVE_SMOKE_ROOT` to reuse a disposable root. If the
  path already exists, the script deletes it only when it has the smoke marker
  file or is clearly under the generated temp smoke prefix.

The test proves:

1. Initial Obsidian vault files land in the bare Git repo.
2. An edit made through Obsidian's live vault API advances the bare repo ref and
   stores matching content bytes.
3. A direct commit to the bare repo materializes back into Obsidian.
4. A restored-state no-op sync uses the fast no-op path and leaves the remote ref
   unchanged.

Latest local proof run, 2026-06-02:

| Step | Result |
| --- | --- |
| Initial sync, 750 seed files plus 1 Obsidian-created file | 15.922s, ref `1309bcd15d57f75db7e43a97d310df51e6b670f4`, tree count 751 |
| Obsidian edit to bare repo | 20.416s, ref advanced to `8e89bf6b02e1c797903ac336f1e7aa99eaab2849` |
| Direct bare commit to Obsidian | 2.368s, ref `18edac53ee148dd396b0aafebc6c0a134d36be58` |
| Restored-state no-op | 86.8ms, fast no-op hit, ref unchanged at `18edac53ee148dd396b0aafebc6c0a134d36be58` |

The run writes `evidence.json` and per-step `latest-run-*.md` log snapshots under
its disposable temp root. The script prints that path on success.
