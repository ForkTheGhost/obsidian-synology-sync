import { buildGitExcludes, classifyGitConflict, classifyGitSetup, GitSetupState, findInvalidLocalFilesystemPaths, invalidLocalFilesystemPathError, nestedGitRepoError, sanitizeVaultPath } from "../src/git-sync";
import { isGitIgnoredPath, matchesGitIgnorePattern } from "../src/git-excludes";

const baseState: GitSetupState = {
  localRepoExists: false,
  localHasCommits: false,
  localHasUserFiles: false,
  remoteExists: false,
  remoteIsBareRepo: false,
  remoteIsEmptyDirectory: false,
  remoteHasCommits: false,
  hasConfiguredBareRemote: false,
};

describe("classifyGitSetup", () => {
  it("checks out the remote when local is effectively empty and destination has history", () => {
    const result = classifyGitSetup({
      ...baseState,
      remoteExists: true,
      remoteIsBareRepo: true,
      remoteHasCommits: true,
    });

    expect(result.action).toBe("checkout-remote");
  });

  it("initializes empty history when both sides are empty", () => {
    const result = classifyGitSetup(baseState);

    expect(result.action).toBe("initialize-empty");
  });

  it("publishes local files when the destination has no commits", () => {
    const result = classifyGitSetup({
      ...baseState,
      localHasUserFiles: true,
      remoteExists: true,
      remoteIsBareRepo: true,
    });

    expect(result.action).toBe("publish-local");
  });

  it("merges existing local files with an established destination", () => {
    const result = classifyGitSetup({
      ...baseState,
      localHasUserFiles: true,
      remoteExists: true,
      remoteIsBareRepo: true,
      remoteHasCommits: true,
    });

    expect(result.action).toBe("merge-existing");
  });

  it("syncs when both local and destination already have history", () => {
    const result = classifyGitSetup({
      ...baseState,
      localRepoExists: true,
      localHasCommits: true,
      remoteExists: true,
      remoteIsBareRepo: true,
      remoteHasCommits: true,
    });

    expect(result.action).toBe("sync-existing");
  });

  it("allows an existing empty directory to be initialized as the bare remote", () => {
    const result = classifyGitSetup({
      ...baseState,
      remoteExists: true,
      remoteIsEmptyDirectory: true,
    });

    expect(result.action).toBe("initialize-empty");
  });

  it("rejects an existing non-empty destination that is not a bare repo", () => {
    const result = classifyGitSetup({
      ...baseState,
      remoteExists: true,
      remoteIsBareRepo: false,
      remoteIsEmptyDirectory: false,
    });

    expect(result.action).toBe("invalid-remote");
  });
});


describe("Obsidian config sync policy", () => {
  it("defaults to notes-only by excluding volatile/device-local Obsidian config", () => {
    const excludes = buildGitExcludes("notes-only");
    expect(excludes).toContain(".obsidian/");
    expect(excludes).toContain("Synology Sync Logs/latest-run*.md");
    expect(excludes).toContain("Synology Sync Logs/history/");
  });

  it("allows selected settings opt-ins without blindly syncing plugin data", () => {
    const excludes = buildGitExcludes("selected-settings", { pluginLists: true, hotkeys: true });
    expect(excludes).not.toContain(".obsidian/community-plugins.json");
    expect(excludes).not.toContain(".obsidian/hotkeys.json");
    expect(excludes).toContain(".obsidian/plugins/");
    expect(excludes).toContain(".obsidian/plugins/*/data.json");
  });

  it("uses gitignore-style matching for plugin data exclusions", () => {
    const excludes = buildGitExcludes("notes-only");
    expect(isGitIgnoredPath(".obsidian/plugins/calendar/data.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/plugins/foo/data.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/plugins/foo/main.js", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/plugins/foo/manifest.json", excludes)).toBe(true);
  });

  it("keeps notes-first Obsidian state exclusions aligned with gitignore semantics", () => {
    const excludes = buildGitExcludes("notes-only");
    expect(isGitIgnoredPath(".obsidian/app.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/appearance.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/graph.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/workspace-mobile.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/community-plugins.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/core-plugins.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/hotkeys.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/snippets/custom.css", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/templates.json", excludes)).toBe(true);
    expect(isGitIgnoredPath(".obsidian/plugins/calendar/main.js", excludes)).toBe(true);
    expect(isGitIgnoredPath("Synology Sync Logs/latest-run.md", excludes)).toBe(true);
    expect(isGitIgnoredPath("Synology Sync Logs/latest-run (conflict device abc123).md", excludes)).toBe(true);
    expect(isGitIgnoredPath("Synology Sync Logs/history/sync-2026-06-02T13-26-13-479Z.md", excludes)).toBe(true);
    expect(isGitIgnoredPath(".trash/deleted.md", excludes)).toBe(true);
    expect(isGitIgnoredPath(".sync-tombstones/device.json", excludes)).toBe(true);
    expect(isGitIgnoredPath("Daily/today.md", excludes)).toBe(false);
  });

  it("supports common gitignore wildcard shapes used by the plugin", () => {
    expect(matchesGitIgnorePattern("nested/node_modules/pkg/index.js", "node_modules/")).toBe(true);
    expect(matchesGitIgnorePattern(".obsidian/workspace-mobile.json", ".obsidian/workspace*")).toBe(true);
    expect(matchesGitIgnorePattern(".obsidian/plugins/calendar/data.json", ".obsidian/plugins/*/data.json")).toBe(true);
    expect(matchesGitIgnorePattern(".obsidian/plugins/calendar/nested/data.json", ".obsidian/plugins/*/data.json")).toBe(false);
  });

  it("labels note conflicts and settings conflicts separately", () => {
    expect(classifyGitConflict("Daily/today.md").kind).toBe("note");
    const settingsConflict = classifyGitConflict(".obsidian/app.json");
    expect(settingsConflict.kind).toBe("settings");
    expect(settingsConflict.message).toContain("Your notes are safe");
  });
});


describe("nested Git repository diagnostics", () => {
  it("surfaces a safe remediation message before git status can recurse into a corrupt submodule", () => {
    const error = nestedGitRepoError([".archive/vaultBSWH"]);
    expect(error.path).toBe("<nested-git-repositories>");
    expect(error.error).toContain(".archive/vaultBSWH");
    expect(error.error).toContain("before staging");
    expect(error.error).toContain("exclude these folders");
  });
});


describe("invalid local filesystem paths", () => {
  it("detects remote note paths that Windows/Git cannot check out", () => {
    const invalid = findInvalidLocalFilesystemPaths([
      "SecOps/Products & Solutions/Palo Alto/Cortex XDR/KB0104369 - Cortex XDR - Understanding the Agent: What It Is and How It Works.md",
      "ok/note.md",
    ]);
    expect(invalid).toEqual([
      "SecOps/Products & Solutions/Palo Alto/Cortex XDR/KB0104369 - Cortex XDR - Understanding the Agent: What It Is and How It Works.md",
    ]);
  });

  it("returns an actionable error instead of allowing merge to crash", () => {
    const error = invalidLocalFilesystemPathError(["A/B: C.md"]);
    expect(error.path).toBe("<invalid-local-paths>");
    expect(error.error).toContain("B: C.md");
    expect(error.error).toContain("Rename these notes");
  });

  it("sanitizes restricted filename characters inside path segments", () => {
    expect(sanitizeVaultPath("A/B: C?.md", ":<>\"/\\|?*", "-")).toBe("A/B- C-.md");
  });

  it("sanitizes reserved Windows names and trailing dot or space", () => {
    expect(sanitizeVaultPath("A/CON.md/B. /NUL", ":<>\"/\\|?*", "-")).toBe("A/CON-.md/B--/NUL-");
  });
});
