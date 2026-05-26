import SynologySync from "../src/main";
import { debugLog } from "../src/debug";
import { LATEST_SYNC_LOG_NOTE_PATH } from "../src/settings";

jest.mock("../src/git-filestation-mobile", () => {
  return {
    MobileGitFileStationSyncEngine: jest.fn().mockImplementation(() => ({
      sync: jest.fn().mockImplementation(async () => {
        debugLog("AUTH password=hunter2 sid=abc123 deviceToken=token123");
        return { uploaded: ["note.md"], downloaded: [], deleted: [], conflicts: [], errors: [] };
      }),
    })),
  };
});

function buildPlugin(persistSyncLogToVaultNote: boolean) {
  const adapter = {
    exists: jest.fn().mockResolvedValue(true),
    mkdir: jest.fn().mockResolvedValue(undefined),
    write: jest.fn().mockResolvedValue(undefined),
  };
  const plugin = new SynologySync() as SynologySync & {
    getFileStation: jest.Mock;
    showResult: jest.Mock;
    saveSettings: jest.Mock;
  };
  plugin.app = { vault: { adapter } } as never;
  plugin.manifest = { version: "test-version" } as never;
  plugin.settings = {
    ...plugin.settings,
    syncBackend: "git-filestation",
    gitFileStationRepoPath: "/homes/user/Vault.git",
    gitBranch: "main",
    syncIdentityId: "test-device",
    gitAuthorName: "Tester",
    gitAuthorEmail: "tester@example.com",
    persistSyncLogToVaultNote,
  };
  plugin.getFileStation = jest.fn().mockResolvedValue({ logout: jest.fn().mockResolvedValue(undefined) });
  plugin.showResult = jest.fn();
  plugin.saveSettings = jest.fn().mockResolvedValue(undefined);
  return { plugin, adapter };
}

describe("persisted latest sync log", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not write a vault note when the setting is disabled", async () => {
    const { plugin, adapter } = buildPlugin(false);

    await (plugin as unknown as { runGitFileStationSync: () => Promise<void> }).runGitFileStationSync();

    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("writes the redacted latest sync transcript when enabled", async () => {
    const { plugin, adapter } = buildPlugin(true);

    await (plugin as unknown as { runGitFileStationSync: () => Promise<void> }).runGitFileStationSync();

    expect(adapter.write).toHaveBeenCalledTimes(1);
    const [path, body] = adapter.write.mock.calls[0] as [string, string];
    expect(path).toBe(LATEST_SYNC_LOG_NOTE_PATH);
    expect(body).toContain("GIT-OVER-FILE-STATION SYNC FINISHED: SUCCESS");
    expect(body).toContain("Plugin version: test-version");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("abc123");
    expect(body).not.toContain("token123");
    expect(body).toContain("password=***");
  });

  it("does not fail sync completion when the optional note write fails", async () => {
    const { plugin, adapter } = buildPlugin(true);
    adapter.write.mockRejectedValueOnce(new Error("disk unavailable"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect((plugin as unknown as { runGitFileStationSync: () => Promise<void> }).runGitFileStationSync()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("Synology Sync could not persist latest sync log:", expect.any(Error));
    warn.mockRestore();
  });
});
