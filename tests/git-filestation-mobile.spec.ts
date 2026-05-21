import { MobileGitFileStationSyncEngine } from "../src/git-filestation-mobile";

describe("MobileGitFileStationSyncEngine", () => {
  it("initializes the in-memory git filesystem and bootstraps an empty bare repo", async () => {
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
    };

    const uploads: Array<{ destFolder: string; fileName: string; bytes: ArrayBuffer }> = [];
    const fs = {
      listAllFiles: jest.fn(async () => {
        throw new Error("remote missing");
      }),
      createFolder: jest.fn(async () => undefined),
      upload: jest.fn(async (destFolder: string, fileName: string, bytes: ArrayBuffer) => {
        uploads.push({ destFolder, fileName, bytes });
      }),
    };

    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    expect(result.uploaded).toEqual([]);
    expect(fs.createFolder).toHaveBeenCalled();
    expect(uploads.some((u) => u.fileName === "HEAD")).toBe(true);
    expect(uploads.some((u) => u.destFolder.endsWith("refs/heads") && u.fileName === "main")).toBe(true);
  });
});
