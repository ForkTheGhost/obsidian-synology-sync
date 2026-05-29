# Native Git admin guardrails

The supported sync path is the Obsidian plugin over File Station/QuickConnect.
Native Git access to the NAS bare repository is admin/developer tooling only.

Install the optional bare-repo hook only while no Obsidian sync is active:

```bash
scripts/install-synology-sync-bare-hook.sh /path/to/VertigoWerk.git
```

The hook installs as `hooks/pre-receive` in the bare repo and blocks native Git
pushes to a branch when `.synology-sync/leases/<branch>.lock` exists. This keeps
desktop/admin Git pushes from racing a File Station sync lease.

The hook is intentionally conservative:

- It blocks while a branch lease directory exists, even if the lease appears old.
  Verify no sync is running before removing a stale lease.
- It rejects branch deletion unless `SYN_SYNC_ALLOW_BRANCH_DELETE=1` is set.
- It rejects non-fast-forward branch updates unless `SYN_SYNC_ALLOW_NON_FF=1` is
  set for coordinated maintenance.

Git hooks do not run for File Station API uploads, so this hook cannot replace
the plugin's lease and expected-old-ref checks. It is a guardrail for native
Git pushes only.
