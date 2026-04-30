# Contributing to VertigoRay/obsidian-synology-sync

## Issues

All features and bug reports must be tracked as GitHub Issues before any work begins. Issues are the authoritative record of intent; PRs without a corresponding issue will not be merged.

Issues must identify:
- What behavior the fix/feature should produce (testable acceptance criteria)
- Whether `ARCHITECTURE.md` needs updating; any change to CI workflows, repository structure, build/release structure, or documented runtime architecture that is not already described in `ARCHITECTURE.md` must include an architecture update in the same PR

## Code, Docs, or Plugin Changes

1. Open a GitHub Issue describing the change and its expected behavior.
2. Create a branch: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`, or `chore/<short-name>`.
3. Make the smallest focused change that satisfies the issue acceptance criteria.
4. Run the relevant local checks:
   - `npm exec jest -- --runInBand`
   - `npm run build`
5. Open a PR referencing the issue.

Documentation-only changes do not require a build if they do not affect generated plugin artifacts.

## Changing Infra

Changes to `.github/workflows/`, build tooling, release packaging, repository structure, or other project infrastructure must include an `ARCHITECTURE.md` update in the same PR when that structure is not already documented. PRs labeled `bug` are exempt from architecture-update enforcement unless they intentionally change architecture.

## Pull Requests

All changes require a PR against `main`. Direct commits to `main` are not permitted.

**PR requirements:**
- Reference the issue in the PR description (`Closes #N` or `Ref #N`)
- Include a `CHANGELOG.md` entry under `## [Unreleased]`
- CI must pass before merge

## CHANGELOG Format

```markdown
### <type>: <short description> (`<commit-sha>`) — closes #N

One or two sentences describing what changed and why.
```

Types: `feat`, `fix`, `docs`, `chore`, `decision`.

`decision` entries document architectural or policy choices with no direct code change; preserve them long-term.
