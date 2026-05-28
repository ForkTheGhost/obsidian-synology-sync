import { FileStationPathExistsError } from "../src/filestation";
import { FileStationGitLeaseHeldError, withFileStationGitLease } from "../src/git-filestation-lease";

describe("FileStationGitLease", () => {
  it("creates lease root, acquires strict lock, writes metadata, and releases", async () => {
    const calls: string[] = [];
    const uploads: Array<{ dest: string; name: string; text: string }> = [];
    const fs = {
      createFolder: jest.fn(async (parent: string, name: string) => { calls.push(`mkdir:${parent}/${name}`); }),
      createFolderStrict: jest.fn(async (parent: string, name: string) => { calls.push(`strict:${parent}/${name}`); }),
      upload: jest.fn(async (dest: string, name: string, content: ArrayBuffer) => {
        uploads.push({ dest, name, text: new TextDecoder().decode(new Uint8Array(content)) });
      }),
      delete: jest.fn(async (path: string) => { calls.push(`delete:${path}`); }),
    };

    await withFileStationGitLease(fs as never, {
      remotePath: "/repo.git",
      branch: "main",
      owner: "device-a",
      expectedOldRef: "abc123",
      now: () => 1000,
      ttlMs: 60000,
    }, async (lease) => {
      expect(lease.owner).toBe("device-a");
      expect(lease.branch).toBe("main");
      expect(lease.expectedOldRef).toBe("abc123");
    });

    expect(fs.createFolder).toHaveBeenNthCalledWith(1, "/repo.git", ".synology-sync");
    expect(fs.createFolder).toHaveBeenNthCalledWith(2, "/repo.git/.synology-sync", "leases");
    expect(fs.createFolderStrict).toHaveBeenCalledWith("/repo.git/.synology-sync/leases", "main.lock");
    expect(uploads[0].dest).toBe("/repo.git/.synology-sync/leases/main.lock");
    expect(uploads[0].name).toBe("lease.json");
    expect(JSON.parse(uploads[0].text)).toMatchObject({ owner: "device-a", branch: "main", expectedOldRef: "abc123" });
    expect(fs.delete).toHaveBeenCalledWith("/repo.git/.synology-sync/leases/main.lock");
  });

  it("surfaces already-held strict-create failures as lease-held errors", async () => {
    const fs = {
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => { throw new FileStationPathExistsError("exists", 414); }),
      upload: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };

    await expect(withFileStationGitLease(fs as never, {
      remotePath: "/repo.git",
      branch: "main",
      owner: "device-a",
    }, async () => undefined)).rejects.toBeInstanceOf(FileStationGitLeaseHeldError);
    expect(fs.upload).not.toHaveBeenCalled();
    expect(fs.delete).not.toHaveBeenCalled();
  });

  it("recovers an expired lease only after reading and verifying metadata", async () => {
    let strictCalls = 0;
    const prior = { owner: "old-device", branch: "main", createdAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString(), token: "old" };
    let currentMetadata = JSON.stringify(prior);
    const fs = {
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => {
        strictCalls++;
        if (strictCalls === 1) throw new FileStationPathExistsError("exists", 414);
      }),
      download: jest.fn(async () => new TextEncoder().encode(currentMetadata).buffer),
      upload: jest.fn(async (_dest: string, _name: string, content: ArrayBuffer) => {
        currentMetadata = new TextDecoder().decode(new Uint8Array(content));
      }),
      delete: jest.fn(async () => undefined),
    };

    await withFileStationGitLease(fs as never, {
      remotePath: "/repo.git",
      branch: "main",
      owner: "new-device",
      now: () => 2000,
      ttlMs: 60000,
    }, async (lease) => {
      expect(lease.owner).toBe("new-device");
    });

    expect(fs.download).toHaveBeenCalledWith("/repo.git/.synology-sync/leases/main.lock/lease.json");
    expect(fs.delete).toHaveBeenCalledWith("/repo.git/.synology-sync/leases/main.lock");
    expect(fs.createFolderStrict).toHaveBeenCalledTimes(2);
    expect(JSON.parse(currentMetadata).owner).toBe("new-device");
  });

  it("does not recover an unexpired lease", async () => {
    const prior = { owner: "old-device", branch: "main", createdAt: new Date(0).toISOString(), expiresAt: new Date(999999).toISOString(), token: "old" };
    const fs = {
      createFolder: jest.fn(async () => undefined),
      createFolderStrict: jest.fn(async () => { throw new FileStationPathExistsError("exists", 414); }),
      download: jest.fn(async () => new TextEncoder().encode(JSON.stringify(prior)).buffer),
      upload: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };

    await expect(withFileStationGitLease(fs as never, {
      remotePath: "/repo.git", branch: "main", owner: "new-device", now: () => 2000,
    }, async () => undefined)).rejects.toBeInstanceOf(FileStationGitLeaseHeldError);
    expect(fs.delete).not.toHaveBeenCalled();
  });

});
