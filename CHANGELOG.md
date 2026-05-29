# Changelog

## [Unreleased]

## 2026.0528.3

### Fixed

- Replace the mobile Git-over-File-Station whole-bare-repo mirror with targeted `HEAD`, branch ref/`packed-refs`, reachable object reads, and validated packfile/index reads, while caching validated Git objects under `.obsidian/plugins/synology-sync/git-cache/v1`.
- Hold the Git-over-File-Station lease across authoritative remote ref/object reads, remote materialization, and publish; verify `expectedOldRef` in lease metadata; and add a plugin cache marker so mobile object cache reuse is branch/repo scoped and rebuildable.
- Add a cross-platform filename sanitizer for Git-tracked vault paths, defaulting to replacing `:<>"\/\|?*` with `-`, so Windows can materialize notes created on platforms that allow restricted filename characters.
- Keep `.obsidian/` local by default under the Notes only policy, matching `ARCHITECTURE.md`, and exclude generated `Synology Sync Logs/latest-run*.md` diagnostics from Git sync.
- Prune redundant conflict artifacts under the File Station lease when generated latest-run conflict copies or identical Markdown conflict copies already exist in the NAS Git tree.
- Add visible File Station publish progress and verify branch-ref overwrite fallback when DSM rename reports the destination ref already exists.

## 2026.0528.2

### Fixed

- Stop mobile Git-over-File-Station sync before downloading very large bare Git repositories that would otherwise mirror thousands of object files into iPhone memory before checkout. The preflight error explains the file count, safety limit, and remediation.
- Move the optional latest-run log to visible `Synology Sync Logs/latest-run.md` and write it at sync start as well as finish so reload/crash evidence is not hidden under `.obsidian` or delayed until final cleanup.

## 2026.0528.1

### Added

- Add source-labeled QuickConnect route diagnostics for server-info fields, LAN hints, candidate ordering, probe outcomes, selected endpoint source/kind, and File Station endpoint kind.
- Add File Station mobile Git download diagnostics for remote repo listing counts, thresholded per-file progress, bytes, elapsed time, and failure location.
- Add adversarial QuickConnect tests for request-tunnel relay metadata, stale relay cache vs rediscovered LAN/direct routes, portal fallback ordering, and hanging LAN candidate fallback.

### Changed

- Treat cached successful QuickConnect candidates as a hint instead of a try-first policy, preserving direct/LAN priority when fresh candidates are rediscovered.
- Replace the narrow QuickConnect debug toggle with a general Debug log setting for data-driven transport decisions.

## 2026.0527.2

### Added

- Cache recently successful QuickConnect endpoints and try known-working candidates before rediscovery/probe ordering, with stale entries expiring automatically.
- Add a Troubleshooting setting for sanitized QuickConnect resolution diagnostics, including relay/server-info field presence and candidate-cache decisions.


## 2026.0527.1

### Fixed

- Restore off-LAN QuickConnect relay API discovery by requesting Synology tunnel metadata when initial server-info omits `relay_port` fields, so iPhone sync can try `synr-*:<relay_port>` routes without opening inbound DSM port `5001`.
- Add regression coverage for the off-LAN QuickConnect shape where direct `:5001` candidates fail but a request-tunnel relay API candidate is present and succeeds.

## 2026.0526.2

### Added

- Add an optional persistent latest-run sync log at `.obsidian/plugins/synology-sync/latest-run.md` for debug handoff, with a final redaction pass before writing.

### Fixed

- Preserve remote history on metadata-less first sync: local-only additions are published, but same-path local/remote differences are kept as conflict-preserved copies instead of overwriting the NAS branch.
- Materialize first-sync conflict-preserved copies back into the local vault immediately so users can see and recover their local edits after the first pull.

## 2026.0526.1

### Changed

- Route Git-bare-backed Sync through the pure-JS/isomorphic-git File Station engine on both desktop and mobile, matching the architecture contract.
- Restore QuickConnect auth fallback breadth by keeping all ordered candidates after ping probing, so off-LAN relay-api candidates can still authenticate after portal/direct timeouts.
- Update settings labels to `Single User (Simple File Sync)` and `Multi User/Device (Git-bare-backed Sync)`.

### Added

- Add an ESLint flat config based on the Obsidian sample plugin pattern, wire `npm run lint` into the local check gate, and document the test/lint/build contributor workflow.
- Document conservative manual cleanup guidance for existing preserved conflict-copy files.

## 2026.0523.1

### Fixed

- Harden Git-over-File-Station publishing with advisory leases, expected-old-ref/ref preflight checks, object-before-ref mirroring, and content-stable preserved conflict copies.
- Add the Git-backed File Station safety stack: strict create-folder lock primitive, tightened File Station error discrimination, `.obsidian` config policy, and disposable smoke-vault/review-gate workflow.

### Fixed

- Git-over-File-Station preserved conflict copies are now content-stable, so repeated unchanged syncs do not create a new timestamped copy each run while new local content still gets a distinct preserved copy.
- Git-over-File-Station publish now re-reads the NAS branch ref while holding the File Station lease and explicitly uploads Git objects before branch refs.

## 2026.0514.2

### Fixed

- Log top-level sync failures into the plugin debug log so failure notices are diagnosable.
- Create nested Git-over-File-Station remote repo folders one segment at a time.

## 2026.0514.1

### Added

- Add Git-over-File-Station sync mode that treats a Synology-hosted bare Git repo as the canonical store while keeping normal Git compatibility for agents/desktops.
- Add a generic Synology Task Scheduler demo script for materializing an optional human-readable mirror from the bare repo.

## 2026.0513.2

### fix: Move Git-backed sync lower in settings

- Move the Git-backed sync behavior toggle out of the top of the Synology Sync settings pane and into the Sync Behavior section, after the primary Synology connection/authentication/target setup.
- Keep Git repo, branch, and author fields hidden until Git-backed sync is enabled.

## 2026.0513.1

### docs/ui: Git behavior stays under Synology settings

- Git-backed sync is now surfaced as an optional toggle within the existing Synology/File Station settings flow instead of a separate backend selector.
- File Station/QuickConnect connection fields remain visible as the primary connection model, while Git repo/branch/author fields are revealed only when Git-backed sync is enabled.
- Git author defaults now align with `Ray Piller <ray@vertigion.com>` where an identity is needed.

## 2026.0512.1

### feat: Experimental Git filesystem backend

- Add an experimental desktop-only sync backend that uses native Git against a bare filesystem remote, including UNC or mounted Synology paths.
- Git setup now classifies first-run states so empty local vaults can pull existing history, local-only vaults can publish initial history, and local edits are checkpointed before merging an established destination.
- Settings now expose backend selection, Git bare repo path, branch, and automatic commit author fields while keeping File Station as the default backend.

### docs: Git-backed sync planning guidance

- README now starts with a concise QuickStart and documents the experimental Git-backed sync shape from issue #31, including UNC filesystem remotes, `git init --bare`, `.git` naming conventions, first-run onboarding cases, and why shared UNC working trees should be treated as advanced/unsafe.

## 2026.0507.1

### fix: Correctness hardening — delete validation, tombstone write ordering, download integrity

- `delete()` now validates the DSM response via `parseJson` and throws on non-success codes; HTTP 408 is treated as idempotent (file already gone on the NAS). Failed deletes no longer write tombstone entries, preventing downstream ghost-deletes on peer devices.
- `pendingShardWrites` is now set inside the `if (remote)` guard — tombstone entries are only written for confirmed remote deletes, not speculative ones.
- `_cleared.json` cross-device purge marker is now written **before** the own-shard upload in `updateOwnShard`. Peers see the purge intent before the shard is updated, closing a race where a partial failure left peers with a stale tombstone and no cleared marker.
- `download()` now validates HTTP status and content-type before writing to the vault. JSON or HTML responses (DSM error bodies on a 200 OK) are rejected with a body preview; the vault file is not written.

### perf: Parallel shard downloads, remote-dir cache, concurrent file execution

- `readAllShards` parallelized via `Promise.allSettled` — all tombstone shards fetched concurrently instead of sequentially.
- `knownRemoteDirs` cache seeded from the remote BFS at the start of each sync cycle; `ensureRemoteDir()` skips `createFolder` for already-known directories. Eliminates redundant RTTs on large vaults (previously up to one `createFolder` per path segment per upload).
- Upload, download, and delete actions now execute in concurrent worker pools (concurrency 5 each) after the sequential decision pass, instead of one file at a time.

### perf: Startup sync timing

- Startup sync now fires via `app.workspace.onLayoutReady` instead of a hardcoded `setTimeout(5000)`, starting as soon as the vault is ready rather than waiting a fixed delay.

### feat: File size limit

- New `maxFileSizeMb` setting (default 100 MB; set to 0 for unlimited) skips oversized files before `readBinary` to prevent OOM on mobile devices.

### fix: Infrastructure error gate on lastSync

- `lastSync` is no longer advanced when the sync cycle encountered infrastructure errors (shard read/write failures, prev-sync write failures). The next cycle will re-evaluate affected files rather than treating them as cleanly synced.

120 tests passing.

## 2026.0506.1

### fix: HTML response hardening — prevent silent file corruption from DSM login errors

- `parseLoginResponse()` now reads the response body as text before attempting JSON parse. An HTML body (DSM redirect or error page on a 200 OK) is detected, the stale `deviceToken` is cleared, and an actionable error is thrown instead of a cryptic JSON parse failure propagating to the user.
- Auto-retry on DSM 403 device-token rejection: if the first login attempt returns 403, the client retries once without `device_id`, matching DSM's expected re-auth flow.
- `parseJson(resp, label)` helper applied at all remaining `resp.json` call sites (listShares, listFolder, upload, createFolder) so HTML error bodies surface as actionable messages rather than silent parse failures throughout the sync flow.

113 tests passing.

## 2026.0505.1

### fix: Tombstone correctness — prevent silent data loss from stale or hostile delete-log shards

- Drop the `tombstoneJitterMs` default from 30000ms to 5000ms. The 30-second window was wider than realistic cross-device clock skew and opened a 30-second band where a live remote file could be classified as a stale tombstone and deleted. A one-time settings migration rewrites the legacy 30000 value to 5000 on next load; users who set a custom value are left untouched.
- Harden the mtime gate in `decision-table.ts` against malformed `deleted_at` values (NaN/Infinity, zero or negative, or implausibly far in the future). When a tombstone is unparseable, the gate now refuses to act on it and routes Rows 4/8/10 down the "live data wins" branch (keep-local / recreate-after-delete) rather than deleting.
- Add cross-device purge propagation via a shared `_cleared.json` marker under `.sync-tombstones/`. When a device keeps a file via Row 6 (`keep-local-purge-tombstone`), it now records a `cleared_at` timestamp that suppresses peer devices' stale shard tombstones for that path. A subsequent genuine delete (`deleted_at > cleared_at`) still wins.

### fix: Mid-sync write protection — don't overwrite or silently mark-clean files the user edited during a sync

- Stamp `syncStartTs` at the top of each `sync()` run and track every stat the sync itself wrote in `syncedLocalStats`. The prev-sync snapshot now refuses to record a file as cleanly synced when its mtime postdates `syncStartTs` and does not match a stat written by this cycle — its prior history is carried forward instead, so the next cycle re-evaluates the file rather than burying the user's edit.
- Re-read live local mtime in `downloadFile` immediately before writing. If the user edited the file between the initial scan and the download, the conflict strategy now decides: `local-wins` always skips, `newer-wins` skips iff the live local mtime exceeds the remote, and `remote-wins` always overwrites. Skipped paths land in `result.conflicts`. A residual TOCTOU window between the live-mtime read and `vault.modifyBinary` remains and is documented in code; closing it would require an Obsidian API change.

### perf: Bounded-concurrency BFS for remote listing

`FileStation.listAllFiles` now fans out folder listings five at a time via `Promise.allSettled` instead of walking the tree one folder per round-trip. A single failed `listFolder` (permission hiccup, transient API error) is logged and the rest of the scan continues.

## 2026.430.5

### fix: Bound QuickConnect server-info lookup — closes #25

Adds explicit logging and a timeout around the initial QuickConnect `Serv.php` lookup so resolution cannot hang after only logging the QuickConnect ID.

## 2026.430.4

### fix: Use entry.cgi with timeout for QuickConnect relay auth — closes #23

Switches relay login to the DSM web-client `entry.cgi` auth endpoint and bounds relay login requests with explicit timeout logging.

## 2026.430.3

### fix: Use QuickConnect relay auth for off-network access — closes #21

Uses the regional QuickConnect relay portal intentionally when direct candidates fail and switches relay login to a portal-compatible POST auth flow.

## 2026.430.2

### fix: Stop QuickConnect unreachable fallback — closes #19

Stops the resolver from attempting auth against candidates that already failed ping-pong and reports a clear no-reachable-endpoint error instead.

### fix: Use BRAT-compatible three-part CalVer — closes #17

Switches release metadata from four-part `YYYY.MM.DD.N` versions to three-part `YYYY.MDD.N` versions so BRAT detects updates reliably.

### fix: Avoid QuickConnect portal HTML auth fallback — closes #13

Prevents browser-only regional QuickConnect portal candidates from being used as unverified File Station API fallbacks and reports HTML/non-JSON auth responses clearly.

## 2026.04.30.1

### fix: QuickConnect regional portal fallback — closes #8

Adds the regional QuickConnect portal host returned by Synology relay metadata to the resolver candidate list, deduplicates candidates, and enforces the intended per-candidate ping timeout.

### docs: Add contributing requirements — closes #10

Adds contributor rules matching the issue-first, architecture-impact, changelog, and CI gates used by `ForkTheGhost/Skills`.

### chore: Release 2026.04.30.1 — closes #12

Updates plugin release metadata and publishes the April 30, 2026 release.

## 2026.04.24.2

### Fixed

- **Issue [#5](https://github.com/ForkTheGhost/obsidian-synology-sync/issues/5) — `prev-sync.json` fails to persist after first write.** `writePrevSync` used a tmp-then-rename pattern, but Obsidian's `DataAdapter.rename` rejects existing destinations with `"Destination file already exists!"`. Every autoSync cycle after the first silently failed the rename, the error was swallowed to the in-memory `debugLog`, and `prev-sync.json` stayed frozen at its first-cycle state — which neutered Row 7 (delete-remote) and prevented the shard-write path from ever firing for deletes made after the first cycle. The fix replaces tmp-then-rename with a single `adapter.write(PREV_SYNC_PATH, …)` call; Obsidian's `DataAdapter.write` is itself atomic (internal tmp+rename on mobile, direct overwrite on desktop). `PrevSyncAdapter` drops the now-unused `rename` and `remove` methods.

## 2026.04.24.1

### Fixed

- **Issue [#3](https://github.com/ForkTheGhost/obsidian-synology-sync/issues/3) — Ghost resurrection of deleted files.** Replaced the stateless filesystem diff in `SyncEngine.sync()` with a 16-row decision table keyed on `(local, remote, history, tombstone)`. Deletes are now tracked by two new state stores:
  - Per-device prev-sync history at `.obsidian/plugins/synology-sync/prev-sync.json` (local JSON, atomic write).
  - Per-device delete-log shards on the NAS at `<remotePath>/.sync-tombstones/<syncIdentityId>.json`. Each device writes only its own shard; all devices read the union at sync time. No write contention by construction.

  Row 7 (local-deleted, remote-exists, in-history) now deletes remote and records a tombstone — this is the single-device fix. Rows 8 and 10 gate on `remote.mtime > tombstone.deleted_at + jitter` to safely distinguish ghosts from legitimate recreate-after-delete — this is the multi-device fix. Row 6 preserves local and purges the stale tombstone by default; `honorTombstoneOnRecreate` (default `false`) opts into the opposite.

### Added

- `settings.syncIdentityId` — UUID generated on first plugin load; stable across sessions; distinct from the DSM 2FA `deviceId` cookie.
- `settings.tombstoneRetentionDays` (default `0` = keep forever).
- `settings.honorTombstoneOnRecreate` (default `false`).
- `settings.tombstoneJitterMs` (default `5000`) — clock-skew tolerance for the mtime gate.
- `settings.remoteAbsenceGraceCycles` (default `2`) — staleness gate for row 3.
- Jest test suite (70+ unit tests) covering all 16 decision-table rows, prev-sync round-trip, corrupt-JSON recovery, and shard union merge semantics.
