import { classifyGitSetup, GitSetupState } from "../src/git-sync";

const baseState: GitSetupState = {
  localRepoExists: false,
  localHasCommits: false,
  localHasUserFiles: false,
  remoteExists: false,
  remoteIsBareRepo: false,
  remoteIsEmptyDirectory: false,
  remoteHasCommits: false,
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
