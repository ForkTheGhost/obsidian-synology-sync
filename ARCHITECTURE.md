# Architecture

This plugin supports two intentionally different sync architectures. Settings, validation, logs, and support guidance should preserve this distinction instead of treating all modes as variants of one remote folder sync.

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
- A desktop Obsidian runtime with local filesystem access to the vault

Not required:

- Remote folder path

Behavior:

- The NAS path is a bare Git repository, not a readable notes folder.
- Human-readable notes live in each local checkout/vault.
- The bare repository is the shared upstream for multi-user sync.
- The picker/validation must only accept a bare Git repo shape: `HEAD`, `objects/`, and `refs/`.
- This mode needs local filesystem access because Git operates on the local checkout.
- On iOS/mobile runtimes without `getBasePath()`, this mode must not be attempted; the UI/logs should make that clear.

### Git-backed sync over mounted filesystem

Mounted filesystem Git sync uses native Git directly against either an existing local repo or a mounted bare repo path.

Required configuration, one of:

- Existing local vault Git repo mode, or
- Mounted bare repository path, for example `\\NAS\Share\MyVault.git` or `/Volumes/Share/MyVault.git`

Not required:

- Remote folder path
- File Station remote folder target

Behavior:

- This is desktop-only.
- If using an existing local repo with an origin, sync uses that origin.
- If no origin is configured, the plugin can create local checkpoints only and must report that changes were not published.

## Settings UI contract

The settings UI should make the choice explicit with a Sync mode selector:

- Simple file sync (single user) shows Remote folder path.
- Git-backed sync over File Station / QuickConnect shows NAS bare Git repo path.
- Git-backed sync over mounted filesystem shows mounted bare repo or existing local repo settings.

Remote folder path belongs only to Simple file sync. Git-backed modes must not require or imply it.

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
