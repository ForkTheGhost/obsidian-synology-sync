import SynologySync from "../src/main";
import { MobileGitFileStationSyncEngine } from "../src/git-filestation-mobile";
import { FileStationGitLeaseHeldError } from "../src/git-filestation-lease";

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
    const obsidianMock = jest.requireActual("obsidian") as { clearNoticeMessages?: () => void };
    obsidianMock.clearNoticeMessages?.();
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

  it("shows a short tap-for-details notice for held Git sync locks", async () => {
    const obsidianMock = jest.requireActual("obsidian") as { noticeMessages: Array<{ message: unknown; timeout?: number }> };
    const longError = new FileStationGitLeaseHeldError(
      "Git-backed File Station lease is already held for main by e4117e21-f331-4248-8b07-59619812edd0 since 2026-05-31T04:50:21.982Z until 2026-05-31T05:20:21.982Z. Try again after the other device finishes, or clear stale lease /home/Obsidian/git/VertigoWerk.git/.synology-sync/leases/main.lock only after verifying no sync is running.",
      1100,
    );
    (MobileGitFileStationSyncEngine as jest.Mock).mockImplementationOnce(() => ({
      sync: jest.fn().mockRejectedValue(longError),
    }));
    const plugin = new SynologySync() as SynologySync & { getFileStation: jest.Mock };
    plugin.app = { vault: { adapter: {} } } as never;
    plugin.settings = {
      ...plugin.settings,
      gitFileStationRepoPath: "/homes/user/Vault.git",
      gitBranch: "main",
      syncIdentityId: "test-device",
      gitAuthorName: "Tester",
      gitAuthorEmail: "tester@example.com",
    };
    plugin.getFileStation = jest.fn().mockResolvedValue({ logout: jest.fn().mockResolvedValue(undefined) });
    plugin.saveSettings = jest.fn().mockResolvedValue(undefined);

    await (plugin as unknown as { runGitFileStationSync: () => Promise<void> }).runGitFileStationSync();

    const failureNotice = obsidianMock.noticeMessages[obsidianMock.noticeMessages.length - 1];
    expect(failureNotice.message).toBe("Sync blocked: another device holds the Git lock. Click for details.");
    expect(failureNotice.timeout).toBe(15000);
    expect(String(failureNotice.message)).not.toContain("e4117e21");
    expect(String(failureNotice.message)).not.toContain("/home/Obsidian/git/VertigoWerk.git");
  });
});
