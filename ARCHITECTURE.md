# Architecture

This plugin supports File Station connections via QuickConnect or a direct Synology address, with two intentionally different sync architectures layered on top: simple file sync or Git-backed sync over File Station. Settings, validation, logs, and support guidance should preserve this distinction instead of treating all modes as variants of one remote folder sync.

`README.md` is the user-facing explanation of this architecture. It should explain the sync-mode choice in simple terms, so a non-developer can decide which option to check and understand how that choice affects where their readable notes live. Build, test, and contribution instructions belong in `CONTRIBUTING.md`, not the README.

## Sync modes

### Simple file sync (single user)

Simple file sync uses Synology File Station as a file API for a human-readable NAS folder.

Required configuration:

- File Station or QuickConnect connection settings
- Remote folder path, for example `/homes/user/Obsidian/MyVault`

Behavior:

- The NAS folder contains normal Markdown/assets that can be browsed directly.
- Conflict handling is the plugin's file-level conflict strategy.
- This is the default and mobile-friendly mode.
- This mode is intended for single-user or simple workflows.

### Git-backed sync over File Station / QuickConnect

Git-backed File Station sync uses File Station/QuickConnect as the transport for a bare Git repository stored on the NAS.

Required configuration:

- File Station or QuickConnect connection settings
- NAS bare Git repository path, for example `/homes/user/Obsidian/MyVault.git`

Not required:

- Remote folder path

Behavior:

- The NAS path is a bare Git repository, not a readable notes folder.
- Human-readable notes live in each local checkout/vault.
- The bare repository is the shared upstream for multi-user sync.
- The picker/validation must only accept a bare Git repo shape: `HEAD`, `objects/`, and `refs/`.
- On desktop runtimes with local filesystem access, this mode may use native Git against the local checkout.
- On iOS/mobile runtimes without `getBasePath()`, this mode uses a pure-JS Git engine over Obsidian's vault APIs instead of desktop-only Node/native Git APIs.

Bootstrap requirements:

- The plugin must support both new/empty Obsidian vaults and existing Obsidian vaults with user notes already present.
- The plugin must support both empty/new NAS bare Git repositories and existing NAS bare Git repositories with history already present.
- Empty local vault + empty remote repo: create the initial Git history from the local vault once there is content to sync.
- Existing local vault + empty remote repo: checkpoint/commit the local vault and publish it as the initial remote history.
- Empty local vault + existing remote repo: materialize/check out the remote history into the local vault without requiring a separate desktop clone step.
- Existing local vault + existing remote repo: checkpoint local state first, then merge/reconcile remote history; never silently overwrite local notes during setup.
- A brand-new Obsidian vault may contain `.obsidian/` metadata and should still be treated as effectively empty when there are no user notes/assets.

Sync operation model:

- File Station is not Git protocol. The safe mental model is: bring enough of the NAS bare repository state onto the device, perform Git operations locally against the device vault/cache, then publish the resulting repository objects/ref update back to Synology through File Station.
- Every Git-backed File Station sync that may write remote state must use the lock/lease protocol. The lease is not optional background protection; it is part of the write path.
- A pre-lock fetch/listing may warm the local cache, but it is not authoritative. After acquiring the lease, the client must re-read the remote branch ref and either fetch any newly needed objects or abort/retry if the ref changed unexpectedly.
- Local Git operations may use a persistent cache when available, but cache reuse must not skip remote ref verification under the lease.
- Sync should be smart/incremental. Clients should avoid blindly downloading or uploading the entire repository on every run when safe change detection is available.
- "Bring enough of the NAS bare repository state onto the device" means the minimum Git objects and refs needed to compute and publish the current sync safely. It does not mean cloning all historical objects when those objects are not needed for the operation.
- The minimal transport set must be derived from Git object/ref reachability rules and documented Git behavior, not discovered by trial and error. Implementations should be backed by focused research into Git object graph requirements, shallow/partial fetch concepts, pack/object negotiation, ref update safety, and isomorphic-git constraints before optimizing the File Station transfer plan.
- Change detection may use File Station metadata such as size and modification time, Git object IDs, file hashes, cached manifests, or another reliable fingerprint strategy. Metadata shortcuts must be conservative: if the client cannot prove an object/file is unchanged, it should verify or transfer rather than risk missing data.
- Publishing order must be objects first, ref last. The final ref update must include an expected-old-ref check while the lease is held, and clients must re-read the NAS branch ref before publishing so stale mirrors fail closed.
- Releasing the lease is the final step after the ref update succeeds or after a safe abort/rollback path.
- Preserved conflict-copy names must be stable for the same local content so repeat syncs do not create unbounded duplicate copies. New local content should still get a distinct preserved copy.

### Non-goals

This plugin is not a general-purpose Git client and should not grow a separate first-class path for non-File-Station Git remotes. Existing Obsidian Git plugins already serve normal Git remotes well. The Git-backed mode here exists specifically to use Synology File Station / QuickConnect as the transport.

## Settings UI contract

The settings UI should make the choice explicit with a Sync mode selector:

- Simple file sync (single user) shows Remote folder path.
- Git-backed sync over File Station / QuickConnect shows NAS bare Git repo path.
The settings UI should not present non-File-Station Git remotes as a primary sync mode.

Remote folder path belongs only to Simple file sync. Git-backed File Station mode must not require or imply it.

## Runtime and platform diagnostics

Support logs should identify runtime/platform enough to distinguish desktop from iOS/mobile.

The debug log should include a `RUNTIME:` line with:

- navigator platform
- user agent
- Obsidian Platform flags when available: desktop/mobile/iOS/mobile app
- whether the vault adapter exposes `getBasePath()`
- a privacy-preserving `hostFingerprint`
- `hostFingerprintSource`

Host/runtime correlation should avoid logging raw hostnames or filesystem paths. The fingerprint is only for telling whether two logs likely came from the same host/runtime.

## Auth and connectivity state model

File Station authentication and QuickConnect connectivity are modeled as typed states, not string parsing.

Important fields:

- `phase`
- `endpointKind`
- `responseKind`
- `persistedTokenAction` / `tokenAction`
- `message`
- `nextAction`

Important phases include:

- `resolve_candidates`
- `select_endpoint`
- `start_login`
- `classify_response`
- `retry_without_token`
- `prompt_otp`
- `persist_replacement_token`
- `repair_relay_session`
- `fail`

Important response kinds include:

- DSM JSON success/error
- timeout
- HTML/browser portal
- network error
- unexpected response

Design invariant:

- Relay HTML/browser pages are not proof of stale device-token expiry. They may indicate the wrong endpoint, missing relay/session cookies, or a portal page.
- Do not force endless re-auth loops unless DSM explicitly returns token rejection.
- Direct timeout should try relay.
- Relay HTML should not clear saved token; it should suggest repair relay flow or choosing another endpoint.
- DSM 403/token rejection with saved token can clear for retry and/or prompt OTP.
- OTP success with replacement token should persist the replacement token.
- Logs and notices should use the same state names for support/debug parity.

## Git safety checks

Git-backed modes must preflight unsafe local checkout conditions before staging or merging.

Required checks include:

- Nested Git repositories inside the vault, including `.git` folders/files.
- Excluded folders should not trigger nested-repo warnings.
- Remote history paths that cannot be checked out on the local filesystem, such as platform-invalid filenames.

Failures should be actionable errors, not raw Git crashes.

## Obsidian config policy

Git-backed sync should protect volatile Obsidian configuration by default. Default excludes/policies should avoid syncing transient workspace/plugin state unless the user explicitly chooses a broader policy.

The default policy is notes-oriented and should avoid surprising multi-device config churn.

## Roadmap / open design items

### Persistent mobile Git cache

The first mobile Git-over-File-Station implementation uses an in-memory filesystem because Obsidian mobile does not expose a normal desktop filesystem path to plugins. A follow-up should evaluate `@isomorphic-git/lightning-fs` / IndexedDB as a persistent mobile cache so repeated syncs do not need to reconstruct the Git working state from the vault and NAS bare repo every run.

Acceptance considerations:

- Works inside Obsidian iOS/mobile WebView storage constraints.
- Does not rely on desktop-only `getBasePath()`, Node `fs`, or native Git.
- Has a safe cache invalidation/rebuild path if IndexedDB data is missing or corrupt.
- Does not leak vault path/host-identifying data in logs.

### Git history retention / compaction

Long-running automatic sync can create many commits. The bare NAS repo can grow over time, especially with large binary attachments and frequent autosync commits. A follow-up should design an explicit, opt-in retention/compaction model instead of silently rewriting history.

Possible policy shape:

- Keep individual commits for the last 7 days.
- Squash older daily history into daily snapshots for a short window.
- Squash older daily snapshots into weekly snapshots for roughly 4 weeks.
- Squash older weekly snapshots into monthly snapshots for roughly 6 months.
- Preserve tags or checkpoint refs before destructive compaction.

Design constraints:

- History rewriting must coordinate across devices so stale clients do not push old history back.
- Compaction should never run while other clients may be mid-sync unless there is a lock/lease protocol.
- Users need clear warnings that compaction trades fine-grained history for repo size/performance.
- Explore lighter fetch/clone options first where possible, such as shallow/single-branch fetches, before introducing destructive squash/GC behavior.
- Include NAS-side garbage collection/prune guidance where supported, because squashing alone does not reclaim object storage until unreachable objects are pruned.


## File Station Git safety implementation notes

Git-Backed Sync over File Station treats the NAS path as a bare Git repository transported through File Station, not as Git protocol.

### Lease and ref safety

A writer acquires an advisory lease under `.synology-sync/leases/<branch>.lock` using strict File Station create semantics (`force_parent=false`). Lease metadata records owner, branch, expected old ref, creation time, expiry, and a token. The lease reduces concurrent writers but is not the sole correctness guarantee: the publish path must still use expected-old-ref semantics and publish objects before refs. Desktop/native Git uses `--force-with-lease` against the local bare cache; mobile rechecks the downloaded remote ref before writing its cached ref and aborts if it changed.

### Minimal transport and fingerprints

File Station metadata such as size/mtime is only a cheap negative check: it can prove a file changed, but it cannot prove Git object equivalence because repacking can rewrite pack files for the same reachable object set. Git object IDs and ref OIDs are authoritative. If unchanged state cannot be proven from object/ref identity, the implementation must verify or transfer rather than assume equivalence.

### Obsidian config policy

The default policy is Notes only: Markdown/assets sync by default and volatile/device-local `.obsidian` state stays local. Selected settings opt-ins allow reviewed categories such as plugin lists, hotkeys, snippets, and appearance/app/graph settings. Advanced full config is explicit opt-in and carries conflict/secrets/device-path risk.

### Validation

Release candidates should pass `npm run check` and the disposable smoke-vault workflow documented in `docs/SMOKE-VAULT.md`. `npm run check` is the local quality gate for Jest, ESLint, and the production build.

The ESLint gate uses a flat config based on `obsidianmd/obsidian-sample-plugin` and loads `eslint-plugin-obsidianmd`. Existing-code compatibility exclusions are kept in `eslint.config.mjs` so lint adoption stays focused on tooling correctness first; tighten those exclusions in follow-up PRs when the affected code is intentionally refactored.
