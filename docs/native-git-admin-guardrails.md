# Native Git admin guardrails

The supported sync path is the Obsidian plugin over File Station/QuickConnect.
Native Git access to the NAS bare repository is admin/developer tooling only.

Install the optional bare-repo hook only while no Obsidian sync is active:

```bash
scripts/install-synology-sync-bare-hook.sh /path/to/VertigoWerk.git
```

For the VertigoRay vault, the current NAS bare repo path is:

```bash
scripts/install-synology-sync-bare-hook.sh /home/Obsidian/git/VertigoRay.git
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

The Obsidian plugin checks whether `hooks/pre-receive` exists and matches the
Synology Sync guard fingerprint before Git-backed File Station sync takes the
NAS lease. If the hook is missing or unrecognized, the plugin logs a warning and
continues with its built-in File Station lease and expected-ref checks. The
plugin does not install the hook automatically because File Station upload cannot
reliably mark the file executable on DSM. A hook that exists but is not
executable gives false confidence because native Git will not run it.
