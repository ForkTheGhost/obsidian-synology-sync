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

The test proves:

1. Initial Obsidian vault files land in the bare Git repo.
2. An edit made through Obsidian's live vault API advances the bare repo ref and
   stores matching content bytes.
3. A direct commit to the bare repo materializes back into Obsidian.
4. A restored-state no-op sync uses the fast no-op path and leaves the remote ref
   unchanged.

Latest local proof run, 2026-06-01:

| Step | Result |
| --- | --- |
| Initial sync, 750 seed files plus 1 Obsidian-created file | 18.361s, ref `95b8dab8542b3f99c172e683339da2c1ad63624a`, tree count 751 |
| Obsidian edit to bare repo | 22.255s, ref advanced to `9f56f0d80796aecc58843a162ee92162222e5278`, SHA-256 `6ecbb67b17caa10962cb678de928bffebbee630fa7a2f25852c7690c8f88e1cd` |
| Direct bare commit to Obsidian | 2.499s, ref `c4e42e1231ccfb9192c38cd80bd3e98c2a9d643f`, SHA-256 `fbdba35ca11c37ca70406f959a3ffc84a15df353422f2562320775e479e1b722` |
| Restored-state no-op | 81ms, fast no-op hit, ref unchanged at `c4e42e1231ccfb9192c38cd80bd3e98c2a9d643f` |

The run writes `evidence.json` and per-step `latest-run-*.md` log snapshots under
its disposable temp root. The script prints that path on success.
