# Preserved conflict-copy cleanup

Git-bare-backed Sync may preserve local bytes as files named like
`name (conflict <syncIdentityId> <timestamp>).ext` when the plugin needs to keep
both local and NAS versions. Current sync code should not create repeated copies
when the bytes already match, but older releases may have left already-synced
conflict-copy files in the vault.

Use this conservative cleanup process:

1. Sync successfully first and confirm the debug log reports no active errors.
2. In the local Obsidian vault, search for ` conflict ` in filenames.
3. For each group, compare the conflict copy with the probable original file and
   sibling conflict copies.
4. Delete only exact byte-identical duplicates, or copies whose content you have
   manually reviewed and no longer need.
5. Let the plugin sync those normal local deletions through Git-bare-backed Sync.

Do not delete conflict copies directly from the NAS bare repository or with broad
File Station orphan cleanup. Unique conflict-copy contents may be the only copy of
notes written on another device, so leave them for explicit human review.
