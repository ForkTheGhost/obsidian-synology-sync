import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { execFileSync } from "child_process";
import { TFile, Vault } from "obsidian";
import { NativeGitSyncEngine } from "../src/git-sync";

jest.setTimeout(30_000);

function hasNativeGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

class FakeVault extends Vault {
  private basePath: string;

  constructor(basePath: string) {
    super();
    this.basePath = basePath;
    this.adapter = { getBasePath: () => basePath } as unknown as Vault["adapter"];
  }

  getFiles(): TFile[] {
    const files: TFile[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === ".git") continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        const file = new TFile();
        file.path = relative(this.basePath, full).replace(/\\/g, "/");
        file.stat = { mtime: stat.mtimeMs, size: stat.size };
        files.push(file);
      }
    };
    walk(this.basePath);
    return files;
  }
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "obsidian-synology-git-"));
}

function writeFile(root: string, relativePath: string, contents: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function readText(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function syncVault(localPath: string, remotePath: string): Promise<void> {
  const engine = new NativeGitSyncEngine(new FakeVault(localPath), {
    remotePath,
    branch: "main",
    syncIdentityId: "test-device",
    authorName: "Test Sync",
    authorEmail: "test@example.invalid",
  });
  const result = await engine.sync();
  expect(result.errors).toEqual([]);
}

async function syncExistingLocalRepo(localPath: string): Promise<ReturnType<NativeGitSyncEngine["sync"]>> {
  const engine = new NativeGitSyncEngine(new FakeVault(localPath), {
    remotePath: "",
    branch: "main",
    syncIdentityId: "test-device",
    authorName: "Test Sync",
    authorEmail: "test@example.invalid",
  });
  return engine.sync();
}

const describeIfGit = hasNativeGit() ? describe : describe.skip;

describeIfGit("NativeGitSyncEngine", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("publishes an existing local vault to a new bare remote", async () => {
    const local = join(root, "local");
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    mkdirSync(local);
    writeFile(local, "note.md", "# Local\n");

    await syncVault(local, remote);

    execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
    expect(readText(clone, "note.md")).toBe("# Local\n");
  });

  it("checks out an established bare remote into an empty local vault", async () => {
    const seed = join(root, "seed");
    const local = join(root, "local");
    const remote = join(root, "remote.git");
    mkdirSync(seed);
    mkdirSync(local);
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "Seeder"]);
    git(seed, ["config", "user.email", "seed@example.invalid"]);
    writeFile(seed, "remote.md", "# Remote\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);
    git(root, ["init", "--bare", "-b", "main", remote]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);

    await syncVault(local, remote);

    expect(readText(local, "remote.md")).toBe("# Remote\n");
  });

  it("checkpoints local files before merging an established remote", async () => {
    const seed = join(root, "seed");
    const local = join(root, "local");
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    mkdirSync(seed);
    mkdirSync(local);

    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "Seeder"]);
    git(seed, ["config", "user.email", "seed@example.invalid"]);
    writeFile(seed, "remote.md", "# Remote\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);
    git(root, ["init", "--bare", "-b", "main", remote]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);

    writeFile(local, "local.md", "# Local\n");
    await syncVault(local, remote);

    expect(readText(local, "local.md")).toBe("# Local\n");
    expect(readText(local, "remote.md")).toBe("# Remote\n");

    execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
    expect(readText(clone, "local.md")).toBe("# Local\n");
    expect(readText(clone, "remote.md")).toBe("# Remote\n");
  });

  it("creates local checkpoints for an existing .git vault without requiring a File Station target", async () => {
    const local = join(root, "local");
    mkdirSync(local);
    git(local, ["init", "-b", "main"]);
    git(local, ["config", "user.name", "Existing User"]);
    git(local, ["config", "user.email", "existing@example.invalid"]);
    writeFile(local, "note.md", "# Local checkpoint only\n");

    const result = await syncExistingLocalRepo(local);

    expect(result.uploaded).toContain("note.md");
    expect(result.errors[0].path).toBe("<git-publish>");
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: local, stdio: "ignore" });
  });

  it("blocks nested Git repositories before staging", async () => {
    const local = join(root, "local");
    const remote = join(root, "remote.git");
    mkdirSync(local);
    writeFile(local, "note.md", "# Local\n");
    mkdirSync(join(local, "archive", "old-vault"), { recursive: true });
    git(join(local, "archive", "old-vault"), ["init", "-b", "main"]);

    const engine = new NativeGitSyncEngine(new FakeVault(local), {
      remotePath: remote,
      branch: "main",
      syncIdentityId: "test-device",
      authorName: "Test Sync",
      authorEmail: "test@example.invalid",
    });
    const result = await engine.sync();

    expect(result.errors[0].path).toBe("<nested-git-repositories>");
    expect(result.errors[0].error).toContain("archive/old-vault");
  });

  it("respects excludes before warning about nested Git repositories", async () => {
    const local = join(root, "local");
    const remote = join(root, "remote.git");
    const clone = join(root, "clone");
    mkdirSync(local);
    writeFile(local, "note.md", "# Local\n");
    mkdirSync(join(local, "archive", "old-vault"), { recursive: true });
    git(join(local, "archive", "old-vault"), ["init", "-b", "main"]);

    const engine = new NativeGitSyncEngine(new FakeVault(local), {
      remotePath: remote,
      branch: "main",
      syncIdentityId: "test-device",
      authorName: "Test Sync",
      authorEmail: "test@example.invalid",
      excludePatterns: ["archive/"],
    });
    const result = await engine.sync();

    expect(result.errors).toEqual([]);
    execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
    expect(readText(clone, "note.md")).toBe("# Local\n");
  });
});
