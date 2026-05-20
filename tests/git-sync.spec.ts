import { buildGitExcludes, classifyGitConflict, classifyGitSetup, GitSetupState, nestedGitRepoError } from "../src/git-sync";

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
    expect(excludes).toContain(".obsidian/app.json");
    expect(excludes).toContain(".obsidian/plugins/*/data.json");
  });

  it("allows selected settings opt-ins without blindly syncing plugin data", () => {
    const excludes = buildGitExcludes("selected-settings", { pluginLists: true, hotkeys: true });
    expect(excludes).not.toContain(".obsidian/community-plugins.json");
    expect(excludes).not.toContain(".obsidian/hotkeys.json");
    expect(excludes).toContain(".obsidian/plugins/*/data.json");
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
