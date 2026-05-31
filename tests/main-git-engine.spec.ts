import SynologySync from "../src/main";
import { MobileGitFileStationSyncEngine } from "../src/git-filestation-mobile";

jest.mock("../src/git-filestation-mobile", () => {
  return {
    MobileGitFileStationSyncEngine: jest.fn().mockImplementation(() => ({
      sync: jest.fn().mockResolvedValue({ uploaded: [], downloaded: [], deleted: [], conflicts: [], errors: [] }),
    })),
  };
});

describe("Git-over-File-Station engine selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the pure-JS File Station Git engine even when desktop getBasePath is available", async () => {
    const plugin = new SynologySync() as SynologySync & { getFileStation: jest.Mock };
    plugin.app = {
      vault: {
        adapter: { getBasePath: () => "/vault" },
      },
    } as never;
    plugin.settings = {
      ...plugin.settings,
      gitFileStationRepoPath: "/homes/user/Vault.git",
      gitBranch: "main",
      syncIdentityId: "test-device",
      gitAuthorName: "Tester",
      gitAuthorEmail: "tester@example.com",
    };
    plugin.getFileStation = jest.fn().mockResolvedValue({ logout: jest.fn().mockResolvedValue(undefined) });
    plugin.showResult = jest.fn();
    plugin.saveSettings = jest.fn().mockResolvedValue(undefined);

    await (plugin as unknown as { runGitFileStationSync: () => Promise<void> }).runGitFileStationSync();

    expect(MobileGitFileStationSyncEngine).toHaveBeenCalledTimes(1);
    expect(MobileGitFileStationSyncEngine).toHaveBeenCalledWith(
      plugin.app.vault,
      expect.anything(),
      expect.objectContaining({ remotePath: "/homes/user/Vault.git", branch: "main" }),
    );
  });

  it("clears the configured Git-over-File-Station lease and logs out", async () => {
    const plugin = new SynologySync() as SynologySync & { getFileStation: jest.Mock };
    const fs = {
      delete: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    plugin.settings = {
      ...plugin.settings,
      gitFileStationRepoPath: "/homes/user/Vault.git",
      gitBranch: "feature/test branch",
    };
    plugin.getFileStation = jest.fn().mockResolvedValue(fs);

    await expect(plugin.clearGitSyncLock()).resolves.toBe("/homes/user/Vault.git/.synology-sync/leases/feature-test-branch.lock");

    expect(fs.delete).toHaveBeenCalledWith("/homes/user/Vault.git/.synology-sync/leases/feature-test-branch.lock");
    expect(fs.logout).toHaveBeenCalledTimes(1);
  });
});
