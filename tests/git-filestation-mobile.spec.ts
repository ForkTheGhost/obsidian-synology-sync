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
  it("fails before status fallback when a downloaded pack has a bad trailer checksum", async () => {
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
    };
    const pack = new Uint8Array(32);
    pack.set([0x50, 0x41, 0x43, 0x4b]);
    pack[7] = 2;
    const idx = new Uint8Array(8 + 256 * 4 + 40);
    idx.set([0xff, 0x74, 0x4f, 0x63]);
    idx[7] = 2;
    const fs = {
      listFolder: jest.fn(async (path: string) => {
        if (path.endsWith("Test.git")) return [{ path: `${path}/objects`, name: "objects", isdir: true }];
        if (path.endsWith("objects")) return [{ path: `${path}/pack`, name: "pack", isdir: true }];
        if (path.endsWith("objects/pack")) return [
          { path: `${path}/pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pack`, name: "pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pack", isdir: false },
          { path: `${path}/pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx`, name: "pack-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.idx", isdir: false },
        ];
        return [];
      }),
      listAllFiles: jest.fn(async () => []),
      download: jest.fn(async (path: string) => path.endsWith(".pack") ? pack.buffer : idx.buffer),
      createFolder: jest.fn(async () => undefined),
      upload: jest.fn(async () => undefined),
    };

    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    await expect(engine.sync()).rejects.toThrow(/pack trailer SHA mismatch/);
  });

});
