import { TFolder } from "obsidian";
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

  it("returns Buffer for binary reads when isomorphic-git passes an options object", async () => {
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
    };
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
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
    const memfs = (engine as unknown as { memfs: { promises: { writeFile: (path: string, data: Uint8Array) => Promise<void>; readFile: (path: string, options?: { encoding?: string | null }) => Promise<unknown> } } }).memfs;
    await memfs.promises.writeFile("/tmp/binary.bin", new Uint8Array([0, 255, 65]));
    const data = await memfs.promises.readFile("/tmp/binary.bin", { encoding: null });
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(Array.from(data as Buffer)).toEqual([0, 255, 65]);
  });

  it("creates parent folders before creating checked-out nested files", async () => {
    const folders = new Set<string>();
    const createdFiles: string[] = [];
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn((path: string) => {
        if (!folders.has(path)) return null;
        const folder = new TFolder();
        folder.path = path;
        return folder;
      }),
      createFolder: jest.fn(async (path: string) => { folders.add(path); }),
      createBinary: jest.fn(async (path: string) => { createdFiles.push(path); }),
    };
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
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
    const memfs = (engine as unknown as { memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array) => Promise<void> } }; applyCheckoutChanges: (before: Map<string, string>, result: { downloaded: string[]; uploaded: string[]; deleted: string[] }) => Promise<void> }).memfs;
    await memfs.promises.mkdir("/vault/Folder/Sub", { recursive: true });
    await memfs.promises.writeFile("/vault/Folder/Sub/note.md", new Uint8Array([104, 105]));

    await (engine as unknown as { applyCheckoutChanges: (before: Map<string, string>, result: { downloaded: string[]; uploaded: string[]; deleted: string[] }) => Promise<void> }).applyCheckoutChanges(new Map(), { downloaded: [], uploaded: [], deleted: [] });

    expect(vault.createFolder).toHaveBeenNthCalledWith(1, "Folder");
    expect(vault.createFolder).toHaveBeenNthCalledWith(2, "Folder/Sub");
    expect(createdFiles).toEqual(["Folder/Sub/note.md"]);
  });

  it("materializes a conflict copy for pre-merge local changes", async () => {
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
      createFolder: jest.fn(async () => undefined),
      createBinary: jest.fn(async () => undefined),
    };
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
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
    const exposed = engine as unknown as {
      memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array) => Promise<void>; readdir: (path: string) => Promise<string[]> } };
      materializePreMergeLocalCopies: (changed: Set<string>, before: Map<string, string>, result: { conflicts: string[] }) => Promise<void>;
    };
    await exposed.memfs.promises.mkdir("/vault/Folder", { recursive: true });
    await exposed.memfs.promises.writeFile("/vault/Folder/note.md", new Uint8Array([104, 105]));

    const result = { conflicts: [] as string[] };
    await exposed.materializePreMergeLocalCopies(new Set(["Folder/note.md"]), new Map(), result);

    const entries = await exposed.memfs.promises.readdir("/vault/Folder");
    expect(entries.some((name) => /^note \(conflict ios-device .+\)\.md$/.test(name))).toBe(true);
    expect(result.conflicts).toEqual(["Folder/note.md"]);
  });

  it("directly materializes remote files during pure first pull", async () => {
    const folders = new Set<string>();
    const createdFiles: Record<string, Uint8Array> = {};
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn((path: string) => {
        if (!folders.has(path)) return null;
        const folder = new TFolder();
        folder.path = path;
        return folder;
      }),
      createFolder: jest.fn(async (path: string) => { folders.add(path); }),
      createBinary: jest.fn(async (path: string, data: ArrayBuffer) => { createdFiles[path] = new Uint8Array(data); }),
      modifyBinary: jest.fn(async () => undefined),
    };
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
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
    const exposed = engine as unknown as {
      memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; } };
      materializeRemoteFiles: (remoteFiles: string[], result: { downloaded: string[]; uploaded: string[]; deleted: string[]; conflicts?: string[]; errors?: unknown[] }) => Promise<void>;
    };
    await exposed.memfs.promises.mkdir("/vault/.git", { recursive: true });
    const git = await import("isomorphic-git");
    await git.init({ fs: (exposed.memfs as unknown as { client: unknown }).client as never, dir: "/vault", defaultBranch: "main" });
    await (exposed.memfs as unknown as { promises: { writeFile: (path: string, data: Uint8Array) => Promise<void> } }).promises.writeFile("/vault/Folder/note.md", new Uint8Array([104, 105]));
    await git.add({ fs: (exposed.memfs as unknown as { client: unknown }).client as never, dir: "/vault", filepath: "Folder/note.md" });
    await git.commit({ fs: (exposed.memfs as unknown as { client: unknown }).client as never, dir: "/vault", message: "seed", author: { name: "a", email: "a@example.com" } });
    await (exposed.memfs as unknown as { promises: { unlink: (path: string) => Promise<void> } }).promises.unlink("/vault/Folder/note.md");

    const result = { downloaded: [] as string[], uploaded: [] as string[], deleted: [] as string[] };
    await exposed.materializeRemoteFiles(["Folder/note.md"], result);

    expect(vault.createFolder).toHaveBeenCalledWith("Folder");
    expect(Array.from(createdFiles["Folder/note.md"])).toEqual([104, 105]);
    expect(result.downloaded).toEqual(["Folder/note.md"]);
  });

  it("treats dotfile-only mobile vault state as empty for first pull", async () => {
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const fs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });
    expect((engine as unknown as { hiddenSystemVaultFilesAtStart: (paths: string[]) => string[] }).hiddenSystemVaultFilesAtStart([".trash", ".DS_Store"])).toEqual([".DS_Store"]);
    expect((engine as unknown as { hiddenSystemVaultFilesAtStart: (paths: string[]) => string[] }).hiddenSystemVaultFilesAtStart([".obsidian/app.json", "note.md"])).toEqual([]);
  });

  it("preserves original local bytes when non-empty first-pull path collides with remote", async () => {
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const fs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });
    const exposed = engine as unknown as {
      memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array) => Promise<void>; readdir: (path: string) => Promise<string[]>; readFile: (path: string, options?: { encoding?: string | null }) => Promise<Uint8Array | Buffer> } };
      snapshotInitialLocalFileBytes: (paths: string[]) => Promise<Map<string, Uint8Array>>;
      materializeInitialLocalCopies: (initialFiles: Map<string, Uint8Array>, result: { conflicts: string[] }) => Promise<void>;
    };
    await exposed.memfs.promises.mkdir("/vault", { recursive: true });
    await exposed.memfs.promises.writeFile("/vault/note.md", new TextEncoder().encode("local draft"));
    const initial = await exposed.snapshotInitialLocalFileBytes(["note.md"]);

    // Simulate checkout/materialization replacing the starter file with the remote version.
    await exposed.memfs.promises.writeFile("/vault/note.md", new TextEncoder().encode("remote version"));

    const result = { conflicts: [] as string[] };
    await exposed.materializeInitialLocalCopies(initial, result);

    const entries = await exposed.memfs.promises.readdir("/vault");
    const copy = entries.find((name) => /^note \(conflict ios-device .+\)\.md$/.test(name));
    expect(copy).toBeTruthy();
    const copyBytes = await exposed.memfs.promises.readFile(`/vault/${copy}`, { encoding: null });
    expect(new TextDecoder().decode(copyBytes as Uint8Array)).toBe("local draft");
    const normalBytes = await exposed.memfs.promises.readFile("/vault/note.md", { encoding: null });
    expect(new TextDecoder().decode(normalBytes as Uint8Array)).toBe("remote version");
    expect(result.conflicts).toEqual(["note.md"]);
  });

  it("does not re-preserve downloaded remote files as conflicts once local history exists", async () => {
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const fs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });
    const exposed = engine as unknown as {
      memfs: { client: unknown; promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array | string) => Promise<void> } };
      localHasCommits: () => Promise<boolean>;
      snapshotInitialLocalFileBytes: (paths: string[]) => Promise<Map<string, Uint8Array>>;
    };
    await exposed.memfs.promises.mkdir("/vault", { recursive: true });
    const git = await import("isomorphic-git");
    await git.init({ fs: exposed.memfs.client as never, dir: "/vault", defaultBranch: "main" });
    await exposed.memfs.promises.writeFile("/vault/note.md", new TextEncoder().encode("remote materialized"));
    await git.add({ fs: exposed.memfs.client as never, dir: "/vault", filepath: "note.md" });
    await git.commit({ fs: exposed.memfs.client as never, dir: "/vault", message: "seed", author: { name: "a", email: "a@example.com" } });

    const hadLocalCommitsBeforeRemoteImport = await exposed.localHasCommits();
    const initialLocalFiles = hadLocalCommitsBeforeRemoteImport ? new Map<string, Uint8Array>() : await exposed.snapshotInitialLocalFileBytes(["note.md"]);

    expect(hadLocalCommitsBeforeRemoteImport).toBe(true);
    expect(initialLocalFiles.size).toBe(0);
  });

  it("treats already-existing vault folders as successful during materialization", async () => {
    const folders = new Set<string>();
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn((path: string) => {
        if (!folders.has(path)) return null;
        const folder = new TFolder();
        folder.path = path;
        return folder;
      }),
      createFolder: jest.fn(async (path: string) => { folders.add(path); throw new Error("Folder already exists."); }),
    };
    const fs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });
    await expect((engine as unknown as { ensureVaultFolder: (path: string) => Promise<void> }).ensureVaultFolder("Folder/Sub")).resolves.toBeUndefined();
    expect(vault.createFolder).toHaveBeenCalledWith("Folder");
    expect(vault.createFolder).toHaveBeenCalledWith("Folder/Sub");
  });

  it("overwrites already-existing vault files through adapter when Obsidian index is stale", async () => {
    const written = new Map<string, Uint8Array>();
    const vault = {
      adapter: { writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => { written.set(path, new Uint8Array(data)); }) },
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
      createFolder: jest.fn(async () => undefined),
      createBinary: jest.fn(async () => { throw new Error("File already exists."); }),
      modifyBinary: jest.fn(async () => undefined),
    };
    const fs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });
    await (engine as unknown as { writeVaultBinary: (path: string, bytes: Uint8Array) => Promise<void> }).writeVaultBinary(".obsidian/app.json", new Uint8Array([123, 125]));
    expect(vault.createBinary).toHaveBeenCalledWith(".obsidian/app.json", expect.any(ArrayBuffer));
    expect(vault.adapter.writeBinary).toHaveBeenCalledWith(".obsidian/app.json", expect.any(ArrayBuffer));
    expect(Array.from(written.get(".obsidian/app.json") || [])).toEqual([123, 125]);
  });

});
