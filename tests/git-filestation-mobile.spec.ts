import { TFile, TFolder } from "obsidian";
import { MobileGitFileStationSyncEngine } from "../src/git-filestation-mobile";

describe("MobileGitFileStationSyncEngine", () => {
  async function seededBareRemote(files: Record<string, string>): Promise<{
    git: typeof import("isomorphic-git");
    remote: Map<string, Uint8Array>;
  }> {
    const textEncoder = new TextEncoder();
    const git = await import("isomorphic-git");
    const seedVault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const seedFs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const seed = new MobileGitFileStationSyncEngine(seedVault as never, seedFs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "seed",
      authorName: "Seed",
      authorEmail: "seed@example.com",
    }) as unknown as {
      memfs: {
        client: unknown;
        promises: {
          mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
          writeFile: (path: string, data: Uint8Array | string) => Promise<void>;
          readdir: (path: string) => Promise<string[]>;
          lstat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
          readFile: (path: string) => Promise<Uint8Array>;
        };
      };
    };

    await seed.memfs.promises.mkdir("/vault", { recursive: true });
    await git.init({ fs: seed.memfs.client as never, dir: "/vault", defaultBranch: "main" });
    for (const [path, content] of Object.entries(files)) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent) await seed.memfs.promises.mkdir(`/vault/${parent}`, { recursive: true });
      await seed.memfs.promises.writeFile(`/vault/${path}`, textEncoder.encode(content));
      await git.add({ fs: seed.memfs.client as never, dir: "/vault", filepath: path });
    }
    await git.commit({ fs: seed.memfs.client as never, dir: "/vault", message: "seed remote", author: { name: "Seed", email: "seed@example.com" } });

    const remote = new Map<string, Uint8Array>();
    const collect = async (dir: string) => {
      for (const name of await seed.memfs.promises.readdir(dir)) {
        const abs = `${dir}/${name}`;
        const stat = await seed.memfs.promises.lstat(abs);
        if (stat.isDirectory()) await collect(abs);
        else if (stat.isFile()) {
          const bytes = await seed.memfs.promises.readFile(abs);
          remote.set(`/homes/user/Obsidian/Test.git/${abs.slice("/vault/.git/".length)}`, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        }
      }
    };
    await collect("/vault/.git");
    return { git, remote };
  }

  function remoteBackedFileStation(remote: Map<string, Uint8Array>, uploaded: string[]) {
    const textEncoder = new TextEncoder();
    return {
      listFolder: jest.fn(async (path: string) => Array.from(remote.keys())
        .filter((p) => p.startsWith(`${path.replace(/\/$/, "")}/`))
        .map((p) => p.slice(path.replace(/\/$/, "").length + 1).split("/")[0])
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .map((name) => {
          const child = `${path.replace(/\/$/, "")}/${name}`;
          return { path: child, name, isdir: Array.from(remote.keys()).some((p) => p.startsWith(`${child}/`)) };
        })),
      download: jest.fn(async (path: string) => {
        const bytes = remote.get(path) || textEncoder.encode("");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }),
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      upload: jest.fn(async (destFolder: string, fileName: string, bytes: ArrayBuffer) => {
        uploaded.push(`${destFolder}/${fileName}`);
        remote.set(`${destFolder}/${fileName}`, new Uint8Array(bytes));
      }),
    };
  }

  function vaultWithFiles(files: Record<string, string>) {
    const textEncoder = new TextEncoder();
    const fileMap = new Map<string, TFile>();
    const folders = new Set<string>();
    const createdPaths: string[] = [];
    for (const path of Object.keys(files)) {
      const file = new TFile();
      file.path = path;
      fileMap.set(path, file);
      const parts = path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => Array.from(fileMap.values())),
      readBinary: jest.fn(async (file: TFile) => textEncoder.encode(files[file.path]).buffer),
      getAbstractFileByPath: jest.fn((path: string) => {
        if (fileMap.has(path)) return fileMap.get(path)!;
        if (!folders.has(path)) return null;
        const folder = new TFolder();
        folder.path = path;
        return folder;
      }),
      createFolder: jest.fn(async (path: string) => { folders.add(path); }),
      createBinary: jest.fn(async (path: string) => { createdPaths.push(path); }),
      modifyBinary: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    return { vault, createdPaths };
  }


  it("fetches only reachable remote Git objects instead of mirroring unrelated loose objects", async () => {
    const { remote } = await seededBareRemote({ "RemoteOnly.md": "remote baseline\n" });
    for (let i = 0; i < 20; i++) {
      const suffix = i.toString(16).padStart(38, "0");
      remote.set(`/homes/user/Obsidian/Test.git/objects/ff/${suffix}`, new Uint8Array([1, 2, 3]));
    }
    const { vault } = vaultWithFiles({});
    const uploaded: string[] = [];
    const fs = remoteBackedFileStation(remote, uploaded);
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    expect(result.downloaded).toContain("RemoteOnly.md");
    expect(fs.listFolder).not.toHaveBeenCalled();
    const downloaded = fs.download.mock.calls.map(([path]) => path);
    expect(downloaded).toContain("/homes/user/Obsidian/Test.git/HEAD");
    expect(downloaded).toContain("/homes/user/Obsidian/Test.git/refs/heads/main");
    expect(downloaded.some((path) => path.includes("/objects/ff/"))).toBe(false);
  });

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
      createFolderStrict: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
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
  it("blocks packed remote objects until mobile packfile reads are implemented", async () => {
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
    };
    const oid = "a".repeat(40);
    const textEncoder = new TextEncoder();
    const fs = {
      listFolder: jest.fn(async (path: string) => {
        if (path.endsWith("objects/pack")) return [
          { path: `${path}/pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pack`, name: "pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pack", isdir: false },
          { path: `${path}/pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.idx`, name: "pack-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.idx", isdir: false },
        ];
        return [];
      }),
      listAllFiles: jest.fn(async () => []),
      download: jest.fn(async (path: string) => {
        if (path.endsWith("/HEAD")) return textEncoder.encode("ref: refs/heads/main\n").buffer;
        if (path.endsWith("/refs/heads/main")) return textEncoder.encode(`${oid}\n`).buffer;
        throw new Error("loose object missing");
      }),
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

    await expect(engine.sync()).rejects.toThrow(/packfiles under objects\/pack/);
  });

  it("returns Buffer for binary reads when isomorphic-git passes an options object", async () => {
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => []),
      getAbstractFileByPath: jest.fn(() => null),
    };
    let leaseMetadata = "";
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
    expect(entries.some((name) => /^note \(conflict ios-device [0-9a-f]{12}\)\.md$/.test(name))).toBe(true);
    expect(result.conflicts).toEqual(["Folder/note.md"]);
  });

  it("does not create another preserved conflict copy when unchanged content is already preserved", async () => {
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
    await exposed.memfs.promises.writeFile("/vault/Folder/note.md", new TextEncoder().encode("same local draft"));

    const first = { conflicts: [] as string[] };
    await exposed.materializePreMergeLocalCopies(new Set(["Folder/note.md"]), new Map(), first);
    const second = { conflicts: [] as string[] };
    await exposed.materializePreMergeLocalCopies(new Set(["Folder/note.md"]), new Map(), second);

    const entries = await exposed.memfs.promises.readdir("/vault/Folder");
    expect(entries.filter((name) => /^note \(conflict ios-device [0-9a-f]{12}\)\.md$/.test(name))).toHaveLength(1);
    expect(first.conflicts).toEqual(["Folder/note.md"]);
    expect(second.conflicts).toEqual([]);
  });

  it("treats legacy timestamped conflict copies with matching bytes as already preserved", async () => {
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
    const bytes = new TextEncoder().encode("legacy preserved draft");
    await exposed.memfs.promises.mkdir("/vault/Folder", { recursive: true });
    await exposed.memfs.promises.writeFile("/vault/Folder/note.md", bytes);
    await exposed.memfs.promises.writeFile("/vault/Folder/note (conflict ios-device 2026-05-22T12-00-00-000Z).md", bytes);

    const result = { conflicts: [] as string[] };
    await exposed.materializePreMergeLocalCopies(new Set(["Folder/note.md"]), new Map(), result);

    const entries = await exposed.memfs.promises.readdir("/vault/Folder");
    expect(entries.filter((name) => /^note \(conflict ios-device .+\)\.md$/.test(name))).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
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

  it("does not create conflict copies when pre-sync local bytes already match materialized remote bytes", async () => {
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const fs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });
    const exposed = engine as unknown as {
      memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array) => Promise<void>; readdir: (path: string) => Promise<string[]> } };
      snapshotInitialLocalFileBytes: (paths: string[]) => Promise<Map<string, Uint8Array>>;
      materializeInitialLocalCopies: (initialFiles: Map<string, Uint8Array>, result: { conflicts: string[] }) => Promise<void>;
    };
    await exposed.memfs.promises.mkdir("/vault/Folder", { recursive: true });
    await exposed.memfs.promises.writeFile("/vault/Folder/note.md", new TextEncoder().encode("same remote bytes"));
    const initial = await exposed.snapshotInitialLocalFileBytes(["Folder/note.md"]);

    // Simulate checkout/materialization writing the same remote bytes back to the normal path.
    await exposed.memfs.promises.writeFile("/vault/Folder/note.md", new TextEncoder().encode("same remote bytes"));

    const result = { conflicts: [] as string[] };
    await exposed.materializeInitialLocalCopies(initial, result);

    const entries = await exposed.memfs.promises.readdir("/vault/Folder");
    expect(entries.some((name) => /conflict ios-device/.test(name))).toBe(false);
    expect(result.conflicts).toEqual([]);
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

  it("refuses to publish while leased when the NAS branch ref changed mid-sync", async () => {
    const oldOid = "a".repeat(40);
    const newOid = "b".repeat(40);
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      download: jest.fn(async (path: string) => path.endsWith("lease.json") ? new TextEncoder().encode(leaseMetadata).buffer : new TextEncoder().encode(`${newOid}\n`).buffer),
      upload: jest.fn(async (_dest: string, name: string, content: ArrayBuffer) => { if (name === "lease.json") leaseMetadata = new TextDecoder().decode(new Uint8Array(content)); }),
    };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });
    const exposed = engine as unknown as {
      remoteBranchOidAtDownload: string | undefined;
      memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array | string) => Promise<void> } };
      publishWithLease: () => Promise<void>;
    };
    await exposed.memfs.promises.mkdir("/vault/.git/refs/heads", { recursive: true });
    await exposed.memfs.promises.writeFile("/vault/.git/refs/heads/main", `${oldOid}\n`);
    exposed.remoteBranchOidAtDownload = oldOid;

    await expect(exposed.publishWithLease()).rejects.toThrow(/Remote ref changed on File Station/);
    expect(fs.delete).toHaveBeenCalledWith("/homes/user/Obsidian/Test.git/.synology-sync/leases/main.lock");
    expect(fs.upload.mock.calls.some(([destFolder, fileName]) => `${destFolder}/${fileName}`.endsWith("/refs/heads/main"))).toBe(false);
  });

  it("publishes Git objects before branch refs when mirroring to File Station", async () => {
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const uploaded: string[] = [];
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
      createFolder: jest.fn(async () => undefined),
      upload: jest.fn(async (destFolder: string, fileName: string) => {
        uploaded.push(`${destFolder}/${fileName}`);
      }),
    };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });
    const exposed = engine as unknown as {
      memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array | string) => Promise<void> } };
      uploadBareRepoMirror: () => Promise<void>;
    };
    await exposed.memfs.promises.mkdir("/vault/.git/objects/aa", { recursive: true });
    await exposed.memfs.promises.mkdir("/vault/.git/refs/heads", { recursive: true });
    await exposed.memfs.promises.writeFile("/vault/.git/HEAD", "ref: refs/heads/main\n");
    await exposed.memfs.promises.writeFile("/vault/.git/refs/heads/main", `${"a".repeat(40)}\n`);
    await exposed.memfs.promises.writeFile(`/vault/.git/objects/aa/${"b".repeat(38)}`, new Uint8Array([1, 2, 3]));

    await exposed.uploadBareRepoMirror();

    const objectIndex = uploaded.findIndex((path) => path.includes("/objects/aa/"));
    const refIndex = uploaded.findIndex((path) => path.endsWith("/refs/heads/main"));
    expect(objectIndex).toBeGreaterThanOrEqual(0);
    expect(refIndex).toBeGreaterThanOrEqual(0);
    expect(objectIndex).toBeLessThan(refIndex);
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

  it("anchors downloaded remote history before publishing local-only files in a git-metadata-less vault", async () => {
    const textEncoder = new TextEncoder();
    const git = await import("isomorphic-git");
    const seedVault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const seedFs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const seed = new MobileGitFileStationSyncEngine(seedVault as never, seedFs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "seed", authorName: "Seed", authorEmail: "seed@example.com",
    }) as unknown as { memfs: { client: unknown; promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array | string) => Promise<void>; readFile: (path: string) => Promise<Uint8Array>; } }; uploadBareRepoMirror: () => Promise<void> };
    await seed.memfs.promises.mkdir("/vault", { recursive: true });
    await git.init({ fs: seed.memfs.client as never, dir: "/vault", defaultBranch: "main" });
    await seed.memfs.promises.writeFile("/vault/RemoteOnly.md", textEncoder.encode("keep me\n"));
    await git.add({ fs: seed.memfs.client as never, dir: "/vault", filepath: "RemoteOnly.md" });
    await git.commit({ fs: seed.memfs.client as never, dir: "/vault", message: "seed remote", author: { name: "Seed", email: "seed@example.com" } });

    const remote = new Map<string, Uint8Array>();
    const seedExposed = seed as unknown as { memfs: { promises: { readdir: (path: string) => Promise<string[]>; lstat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>; readFile: (path: string) => Promise<Uint8Array> } } };
    const collect = async (dir: string) => {
      for (const name of await seedExposed.memfs.promises.readdir(dir)) {
        const abs = `${dir}/${name}`;
        const stat = await seedExposed.memfs.promises.lstat(abs);
        if (stat.isDirectory()) await collect(abs);
        else if (stat.isFile()) {
          const bytes = await seedExposed.memfs.promises.readFile(abs);
          remote.set(`/homes/user/Obsidian/Test.git/${abs.slice("/vault/.git/".length)}`, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        }
      }
    };
    await collect("/vault/.git");

    const localFile = new TFile();
    localFile.path = "Daily/2026-05-26 Tuesday.md";
    const folders = new Set(["Daily"]);
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => [localFile]),
      readBinary: jest.fn(async () => textEncoder.encode("# Test\n").buffer),
      getAbstractFileByPath: jest.fn((path: string) => folders.has(path) ? new TFolder() : path === localFile.path ? localFile : null),
      createFolder: jest.fn(async (path: string) => { folders.add(path); }),
      createBinary: jest.fn(async () => undefined),
      modifyBinary: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    const uploaded: string[] = [];
    const fs = {
      listFolder: jest.fn(async (path: string) => Array.from(remote.keys())
        .filter((p) => p.startsWith(`${path.replace(/\/$/, "")}/`))
        .map((p) => p.slice(path.replace(/\/$/, "").length + 1).split("/")[0])
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .map((name) => {
          const child = `${path.replace(/\/$/, "")}/${name}`;
          return { path: child, name, isdir: Array.from(remote.keys()).some((p) => p.startsWith(`${child}/`)) };
        })),
      download: jest.fn(async (path: string) => {
        const bytes = remote.get(path) || textEncoder.encode("");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }),
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      upload: jest.fn(async (destFolder: string, fileName: string, bytes: ArrayBuffer) => {
        uploaded.push(`${destFolder}/${fileName}`);
        remote.set(`${destFolder}/${fileName}`, new Uint8Array(bytes));
      }),
    };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "windows-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });

    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    expect(result.uploaded).toContain("Daily/2026-05-26 Tuesday.md");
    expect(result.uploaded).not.toContain("RemoteOnly.md");
    expect(result.downloaded).toContain("RemoteOnly.md");
    expect(uploaded.some((path) => path.endsWith("/refs/heads/main"))).toBe(true);
    expect(uploaded.some((path) => path.includes("/objects/"))).toBe(true);
    const syncedFiles = await git.listFiles({ fs: (engine as unknown as { memfs: { client: unknown } }).memfs.client as never, gitdir: "/vault/.git", ref: "refs/heads/main" });
    expect(syncedFiles).toContain("RemoteOnly.md");
  });

  it("preserves same-path first-sync differences as conflicts instead of overwriting remote history", async () => {
    const textEncoder = new TextEncoder();
    const git = await import("isomorphic-git");
    const seedVault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const seedFs = { listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }), createFolder: jest.fn(async () => undefined), upload: jest.fn(async () => undefined) };
    const seed = new MobileGitFileStationSyncEngine(seedVault as never, seedFs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "seed", authorName: "Seed", authorEmail: "seed@example.com",
    }) as unknown as { memfs: { client: unknown; promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array | string) => Promise<void>; readFile: (path: string) => Promise<Uint8Array>; } }; };
    await seed.memfs.promises.mkdir("/vault", { recursive: true });
    await git.init({ fs: seed.memfs.client as never, dir: "/vault", defaultBranch: "main" });
    await seed.memfs.promises.writeFile("/vault/Daily/2026-05-26 Tuesday.md", textEncoder.encode("# Remote\n"));
    await git.add({ fs: seed.memfs.client as never, dir: "/vault", filepath: "Daily/2026-05-26 Tuesday.md" });
    await git.commit({ fs: seed.memfs.client as never, dir: "/vault", message: "seed remote", author: { name: "Seed", email: "seed@example.com" } });

    const remote = new Map<string, Uint8Array>();
    const seedExposed = seed as unknown as { memfs: { promises: { readdir: (path: string) => Promise<string[]>; lstat: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>; readFile: (path: string) => Promise<Uint8Array> } } };
    const collect = async (dir: string) => {
      for (const name of await seedExposed.memfs.promises.readdir(dir)) {
        const abs = `${dir}/${name}`;
        const stat = await seedExposed.memfs.promises.lstat(abs);
        if (stat.isDirectory()) await collect(abs);
        else if (stat.isFile()) {
          const bytes = await seedExposed.memfs.promises.readFile(abs);
          remote.set(`/homes/user/Obsidian/Test.git/${abs.slice("/vault/.git/".length)}`, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        }
      }
    };
    await collect("/vault/.git");

    const localFile = new TFile();
    localFile.path = "Daily/2026-05-26 Tuesday.md";
    const folders = new Set(["Daily"]);
    const vault = {
      adapter: {},
      getFiles: jest.fn(() => [localFile]),
      readBinary: jest.fn(async () => textEncoder.encode("# Test\n").buffer),
      getAbstractFileByPath: jest.fn((path: string) => folders.has(path) ? new TFolder() : path === localFile.path ? localFile : null),
      createFolder: jest.fn(async (path: string) => { folders.add(path); }),
      createBinary: jest.fn(async () => undefined),
      modifyBinary: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    const uploaded: string[] = [];
    const fs = {
      listFolder: jest.fn(async (path: string) => Array.from(remote.keys())
        .filter((p) => p.startsWith(`${path.replace(/\/$/, "")}/`))
        .map((p) => p.slice(path.replace(/\/$/, "").length + 1).split("/")[0])
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .map((name) => {
          const child = `${path.replace(/\/$/, "")}/${name}`;
          return { path: child, name, isdir: Array.from(remote.keys()).some((p) => p.startsWith(`${child}/`)) };
        })),
      download: jest.fn(async (path: string) => {
        const bytes = remote.get(path) || textEncoder.encode("");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }),
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      upload: jest.fn(async (destFolder: string, fileName: string, bytes: ArrayBuffer) => {
        uploaded.push(`${destFolder}/${fileName}`);
        remote.set(`${destFolder}/${fileName}`, new Uint8Array(bytes));
      }),
    };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "windows-device", authorName: "Obsidian Synology Sync", authorEmail: "synology-sync@local",
    });

    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    expect(result.uploaded).not.toContain("Daily/2026-05-26 Tuesday.md");
    expect(result.conflicts).toContain("Daily/2026-05-26 Tuesday.md");
    expect(uploaded.some((path) => path.endsWith("/refs/heads/main"))).toBe(true);
    const syncedFiles = await git.listFiles({ fs: (engine as unknown as { memfs: { client: unknown } }).memfs.client as never, gitdir: "/vault/.git", ref: "refs/heads/main" });
    expect(syncedFiles).toContain("Daily/2026-05-26 Tuesday.md");
    expect(syncedFiles.some((path) => path.startsWith("Daily/2026-05-26 Tuesday (conflict windows-device "))).toBe(true);
    const createdPaths = vault.createBinary.mock.calls.map(([path]) => path);
    expect(createdPaths.some((path) => path.startsWith("Daily/2026-05-26 Tuesday (conflict windows-device "))).toBe(true);
  });

  it("publishes root and newly nested local-only first-sync files without conflict copies", async () => {
    const { git, remote } = await seededBareRemote({ "RemoteOnly.md": "remote baseline\n" });
    const { vault, createdPaths } = vaultWithFiles({
      "RootLocal.md": "root local draft\n",
      "Test Fixtures/New/Nested.md": "nested local draft\n",
    });
    const uploaded: string[] = [];
    const fs = remoteBackedFileStation(remote, uploaded);
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "windows-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.uploaded).toEqual(expect.arrayContaining(["RootLocal.md", "Test Fixtures/New/Nested.md"]));
    expect(result.downloaded).toContain("RemoteOnly.md");
    expect(createdPaths.filter((path) => path.includes("(conflict windows-device "))).toEqual([]);
    expect(uploaded.some((path) => path.endsWith("/refs/heads/main"))).toBe(true);
    const syncedFiles = await git.listFiles({ fs: (engine as unknown as { memfs: { client: unknown } }).memfs.client as never, gitdir: "/vault/.git", ref: "refs/heads/main" });
    expect(syncedFiles).toEqual(expect.arrayContaining(["RemoteOnly.md", "RootLocal.md", "Test Fixtures/New/Nested.md"]));
    expect(syncedFiles.filter((path) => path.includes("(conflict windows-device "))).toEqual([]);
  });

  it("creates conflict copies only for root and nested same-path first-sync divergences", async () => {
    const { git, remote } = await seededBareRemote({
      "BRAT-log.md": "remote brat log\n",
      "Test Fixtures/New/Nested.md": "remote nested note\n",
      "RemoteOnly.md": "remote baseline\n",
    });
    const { vault, createdPaths } = vaultWithFiles({
      "BRAT-log.md": "local brat log\n",
      "Test Fixtures/New/Nested.md": "local nested note\n",
      "LocalOnly.md": "local-only note\n",
    });
    const uploaded: string[] = [];
    const fs = remoteBackedFileStation(remote, uploaded);
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "windows-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    expect(result.uploaded).toContain("LocalOnly.md");
    expect(result.uploaded).not.toContain("BRAT-log.md");
    expect(result.uploaded).not.toContain("Test Fixtures/New/Nested.md");
    expect(result.conflicts).toEqual(expect.arrayContaining(["BRAT-log.md", "Test Fixtures/New/Nested.md"]));
    expect(result.conflicts).not.toContain("LocalOnly.md");

    const syncedFiles = await git.listFiles({ fs: (engine as unknown as { memfs: { client: unknown } }).memfs.client as never, gitdir: "/vault/.git", ref: "refs/heads/main" });
    expect(syncedFiles).toContain("BRAT-log.md");
    expect(syncedFiles).toContain("Test Fixtures/New/Nested.md");
    expect(syncedFiles).toContain("LocalOnly.md");
    expect(syncedFiles.some((path) => /^BRAT-log \(conflict windows-device [0-9a-f]{12}\)\.md$/.test(path))).toBe(true);
    expect(syncedFiles.some((path) => /^Test Fixtures\/New\/Nested \(conflict windows-device [0-9a-f]{12}\)\.md$/.test(path))).toBe(true);
    expect(syncedFiles.some((path) => /^LocalOnly \(conflict windows-device [0-9a-f]{12}\)\.md$/.test(path))).toBe(false);
    expect(createdPaths.filter((path) => path.includes("(conflict windows-device "))).toHaveLength(2);
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

  it("reuses validated plugin Git object cache instead of re-downloading content-addressed objects", async () => {
    const { remote } = await seededBareRemote({ "RemoteOnly.md": "remote baseline\n" });
    const cache = new Map<string, Uint8Array>();
    const folders = new Set<string>();
    const writtenCachePaths: string[] = [];
    const uploaded: string[] = [];
    const fs = remoteBackedFileStation(remote, uploaded);
    const adapter = {
      exists: jest.fn(async (path: string) => cache.has(path) || folders.has(path)),
      mkdir: jest.fn(async (path: string) => { folders.add(path); }),
      readBinary: jest.fn(async (path: string) => {
        const bytes = cache.get(path);
        if (!bytes) throw new Error("missing cache");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }),
      writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
        writtenCachePaths.push(path);
        cache.set(path, new Uint8Array(data));
      }),
    };

    const firstVault = { ...vaultWithFiles({}).vault, adapter };
    const first = new MobileGitFileStationSyncEngine(firstVault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    await first.sync();

    expect(writtenCachePaths.some((path) => path.startsWith(".obsidian/plugins/synology-sync/git-cache/v1/objects/"))).toBe(true);
    const firstDownloads = fs.download.mock.calls.map(([path]) => path);
    expect(firstDownloads.some((path) => path.includes("/objects/"))).toBe(true);

    fs.download.mockClear();
    const secondVault = { ...vaultWithFiles({}).vault, adapter };
    const second = new MobileGitFileStationSyncEngine(secondVault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git",
      branch: "main",
      syncIdentityId: "ios-device",
      authorName: "Obsidian Synology Sync",
      authorEmail: "synology-sync@local",
    });

    await second.sync();

    const secondDownloads = fs.download.mock.calls.map(([path]) => path);
    expect(secondDownloads).toContain("/homes/user/Obsidian/Test.git/HEAD");
    expect(secondDownloads).toContain("/homes/user/Obsidian/Test.git/refs/heads/main");
    expect(secondDownloads.some((path) => path.includes("/objects/"))).toBe(false);
  });


  it("publishes branch refs through temp rename and verifies the landed ref", async () => {
    const oid = "c".repeat(40);
    let remoteRef = "";
    let leaseMetadata2 = "";
    const uploaded: string[] = [];
    const fs = {
      listAllFiles: jest.fn(async () => { throw new Error("remote missing"); }),
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      download: jest.fn(async (path: string) => {
        if (path.endsWith("lease.json")) return new TextEncoder().encode(leaseMetadata2).buffer;
        return new TextEncoder().encode(remoteRef).buffer;
      }),
      upload: jest.fn(async (dest: string, name: string, content: ArrayBuffer) => {
        uploaded.push(`${dest}/${name}`);
        if (name === "lease.json") { leaseMetadata2 = new TextDecoder().decode(new Uint8Array(content)); return; }
        if (name === "main") remoteRef = new TextDecoder().decode(new Uint8Array(content));
      }),
      rename: jest.fn(async (_path: string, newName: string) => {
        expect(newName).toBe("main");
        throw new Error("destination exists");
      }),
    };
    const vault = { adapter: {}, getFiles: jest.fn(() => []), getAbstractFileByPath: jest.fn(() => null) };
    const engine = new MobileGitFileStationSyncEngine(vault as never, fs as never, {
      remotePath: "/homes/user/Obsidian/Test.git", branch: "main", syncIdentityId: "ios-device", authorName: "A", authorEmail: "a@example.com",
    }) as unknown as { memfs: { promises: { mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>; writeFile: (path: string, data: Uint8Array | string) => Promise<void> } }; remoteBranchOidAtDownload: string | undefined; publishWithLease: () => Promise<void> };
    await engine.memfs.promises.mkdir("/vault/.git/refs/heads", { recursive: true });
    await engine.memfs.promises.mkdir("/vault", { recursive: true });
    await engine.memfs.promises.writeFile("/vault/.git/HEAD", "ref: refs/heads/main\n");
    await engine.memfs.promises.writeFile("/vault/.git/refs/heads/main", `${oid}\n`);
    engine.remoteBranchOidAtDownload = undefined;

    await engine.publishWithLease();

    expect(uploaded.some((p) => /refs\/heads\/\.main\.synology-sync-.*\.tmp$/.test(p))).toBe(true);
    expect(uploaded.some((p) => p.endsWith("/refs/heads/main"))).toBe(true);
    expect(fs.rename).toHaveBeenCalled();
    expect(fs.delete).toHaveBeenCalledWith(expect.stringMatching(/\/refs\/heads\/\.main\.synology-sync-.*\.tmp$/));
  });

});
