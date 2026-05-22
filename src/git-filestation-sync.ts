import { TFile, Vault } from "obsidian";
import { FileStation } from "./filestation";
import { debugLog } from "./debug";
import { SyncResult } from "./sync";
import { buildGitExcludes, classifyGitConflict, findInvalidLocalFilesystemPaths, invalidLocalFilesystemPathError, nestedGitRepoError } from "./git-sync";
import { isGitIgnoredPath } from "./git-excludes";

declare const require: ((id: string) => unknown) | undefined;

export interface GitFileStationSyncOptions {
  remotePath: string;
  branch: string;
  syncIdentityId: string;
  authorName: string;
  authorEmail: string;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

class GitCommandError extends Error {
  stdout: string;
  stderr: string;
  code: unknown;

  constructor(message: string, stdout: string, stderr: string, code: unknown) {
    super(message);
    this.name = "GitCommandError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

const DEFAULT_GIT_EXCLUDES = buildGitExcludes();

/**
 * Syncs a local Obsidian vault using real Git commits and a bare repository
 * mirrored through Synology File Station. The NAS-side bare repo remains a
 * normal Git repository for native Git clients; File Station is only used as
 * the transport for Obsidian clients that cannot mount the NAS path directly.
 */
export class GitFileStationSyncEngine {
  private vault: Vault;
  private fs: FileStation;
  private opts: GitFileStationSyncOptions;
  private cwd: string;
  private cacheDir: string;
  private remoteCachePath: string;

  constructor(vault: Vault, fs: FileStation, opts: GitFileStationSyncOptions) {
    this.vault = vault;
    this.fs = fs;
    this.opts = {
      ...opts,
      remotePath: normalizeRemotePath(opts.remotePath),
      branch: opts.branch.trim() || "main",
      authorName: opts.authorName.trim() || "Obsidian Synology Sync",
      authorEmail: opts.authorEmail.trim() || "synology-sync@local",
    };
    this.cwd = getVaultBasePath(vault);
    const path = getNodeModule("path") as { join: (...parts: string[]) => string };
    this.cacheDir = path.join(this.cwd, ".obsidian", "plugins", "synology-sync", "git-filestation-cache");
    this.remoteCachePath = path.join(this.cacheDir, "remote.git");
  }

  async sync(): Promise<SyncResult> {
    const result = emptyResult();

    await this.ensureGitAvailable();
    await this.ensureLocalRepo();
    await this.configureLocalRepo();
    await this.ensureCacheDirectory();
    await this.downloadRemoteBareRepoIfPresent();
    await this.ensureRemoteCacheBareRepo();
    await this.ensureRemoteConfigured();

    const remoteHadCommits = await this.remoteHasCommits();
    const localHadCommits = await this.localHasCommits();

    const invalidRemotePaths = await this.invalidRemotePathsForLocalCheckout();
    if (invalidRemotePaths.length > 0) {
      result.errors.push(invalidLocalFilesystemPathError(invalidRemotePaths));
      return result;
    }

    const nestedRepos = this.findNestedGitRepositories();
    if (nestedRepos.length > 0) {
      result.errors.push(nestedGitRepoError(nestedRepos));
      return result;
    }

    const localChanged = await this.changedFiles();

    if (!localHadCommits && remoteHadCommits && !this.localHasUserFiles()) {
      await this.checkoutRemote(result);
      await this.uploadBareRepoMirror();
      return result;
    }

    const needsBootstrapCommit = !localHadCommits && !remoteHadCommits;
    if (localChanged.length > 0 || needsBootstrapCommit) {
      await this.commitLocalChanges(
        needsBootstrapCommit ? "Initialize Obsidian vault sync" : `Sync from ${this.opts.syncIdentityId}`,
        needsBootstrapCommit,
      );
      result.uploaded.push(...localChanged);
    }

    if (remoteHadCommits) {
      const remoteChanged = await this.remoteChangedFiles();
      await this.mergeRemote(!localHadCommits && this.localHasUserFiles());
      result.downloaded.push(...remoteChanged);

      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        result.conflicts.push(...conflicts);
        result.errors.push({
          path: "<git-merge>",
          error: conflicts.some((p) => p.startsWith(".obsidian/"))
          ? classifyGitConflict(conflicts.find((p) => p.startsWith(".obsidian/")) || conflicts[0]).message
          : "Merge conflicts need to be resolved before Git sync can push.",
        });
        return result;
      }
    }

    await this.pushWithRetry();
    await this.uploadBareRepoMirror();
    return result;
  }

  private async ensureGitAvailable(): Promise<void> {
    try {
      await git(["--version"], undefined);
    } catch (e) {
      throw new Error(`Git-over-File-Station sync requires native Git on this device. ${(e as Error).message}`);
    }
  }

  private async ensureLocalRepo(): Promise<void> {
    if (await this.localRepoExists()) return;
    await git(["init", "-b", this.opts.branch], this.cwd);
  }

  private async configureLocalRepo(): Promise<void> {
    await git(["config", "user.name", this.opts.authorName], this.cwd);
    await git(["config", "user.email", this.opts.authorEmail], this.cwd);
    await this.writeInfoExclude();
  }

  private async ensureCacheDirectory(): Promise<void> {
    const fs = getNodeModule("fs") as { mkdirSync: (p: string, opts?: { recursive?: boolean }) => void };
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private async downloadRemoteBareRepoIfPresent(): Promise<void> {
    const fsNode = getNodeModule("fs") as {
      existsSync: (p: string) => boolean;
      rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) => void;
      mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
      writeFileSync: (p: string, data: Uint8Array) => void;
    };
    const path = getNodeModule("path") as { dirname: (p: string) => string; join: (...parts: string[]) => string };

    let files;
    try {
      files = await this.fs.listAllFiles(this.opts.remotePath);
    } catch (e) {
      debugLog(`[git-filestation] remote bare repo not found or unreadable; will initialize: ${(e as Error).message}`);
      return;
    }

    fsNode.rmSync(this.remoteCachePath, { recursive: true, force: true });
    for (const file of files) {
      if (file.isdir) continue;
      const rel = relativeRemotePath(this.opts.remotePath, file.path);
      if (!rel || shouldSkipRemoteGitFile(rel)) continue;
      const localPath = path.join(this.remoteCachePath, ...rel.split("/"));
      fsNode.mkdirSync(path.dirname(localPath), { recursive: true });
      const bytes = new Uint8Array(await this.fs.download(file.path));
      fsNode.writeFileSync(localPath, bytes);
    }
  }

  private async ensureRemoteCacheBareRepo(): Promise<void> {
    if (await this.cacheIsBareRepo()) return;
    await git(["init", "--bare", "-b", this.opts.branch, this.remoteCachePath], undefined);
  }

  private async cacheIsBareRepo(): Promise<boolean> {
    try {
      const r = await git(["--git-dir", this.remoteCachePath, "rev-parse", "--is-bare-repository"], undefined);
      return r.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async ensureRemoteConfigured(): Promise<void> {
    const remotes = await git(["remote"], this.cwd);
    if (!remotes.stdout.split(/\r?\n/).includes("origin")) {
      await git(["remote", "add", "origin", this.remoteCachePath], this.cwd);
      return;
    }
    await git(["remote", "set-url", "origin", this.remoteCachePath], this.cwd);
  }

  private async localRepoExists(): Promise<boolean> {
    try {
      const r = await git(["rev-parse", "--is-inside-work-tree"], this.cwd);
      return r.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async localHasCommits(): Promise<boolean> {
    try {
      await git(["rev-parse", "--verify", "HEAD"], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  private localHasUserFiles(): boolean {
    return this.vault.getFiles().some((file) => {
      if (!(file instanceof TFile)) return false;
      if (file.path.startsWith(".obsidian/")) return false;
      if (isGitIgnoredPath(file.path, DEFAULT_GIT_EXCLUDES)) return false;
      return true;
    });
  }

  private async remoteHasCommits(): Promise<boolean> {
    try {
      const r = await git(["ls-remote", "--heads", this.remoteCachePath, this.opts.branch], this.cwd);
      return r.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async checkoutRemote(result: SyncResult): Promise<void> {
    await git(["fetch", "origin", this.opts.branch], this.cwd);
    const changed = await this.remoteTreeFiles();
    await git(["checkout", "-B", this.opts.branch, `origin/${this.opts.branch}`], this.cwd);
    result.downloaded.push(...changed);
  }

  private async changedFiles(): Promise<string[]> {
    const r = await git(["status", "--porcelain", "-z", "--untracked-files=all"], this.cwd);
    return parsePorcelainZ(r.stdout);
  }

  private async commitLocalChanges(message: string, allowEmpty: boolean): Promise<void> {
    await git(["add", "-A", "--", "."], this.cwd);
    const args = ["commit", "-m", message];
    if (allowEmpty) args.push("--allow-empty");
    await git(args, this.cwd);
  }

  private async remoteChangedFiles(): Promise<string[]> {
    await git(["fetch", "origin", this.opts.branch], this.cwd);
    try {
      const r = await git(["diff", "--name-only", `HEAD..origin/${this.opts.branch}`], this.cwd);
      return uniqueLines(r.stdout);
    } catch {
      return [];
    }
  }

  private async remoteTreeFiles(): Promise<string[]> {
    const r = await git(["ls-tree", "-r", "--name-only", `origin/${this.opts.branch}`], this.cwd);
    return uniqueLines(r.stdout);
  }

  private async invalidRemotePathsForLocalCheckout(): Promise<string[]> {
    try {
      return findInvalidLocalFilesystemPaths(await this.remoteTreeFiles());
    } catch {
      return [];
    }
  }

  private async mergeRemote(allowUnrelatedHistories: boolean): Promise<void> {
    const args = ["merge", "--no-edit"];
    if (allowUnrelatedHistories) args.push("--allow-unrelated-histories");
    args.push(`origin/${this.opts.branch}`);

    try {
      await git(args, this.cwd);
    } catch (e) {
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        debugLog(`[git-filestation] merge stopped with conflicts: ${conflicts.join(", ")}`);
        return;
      }
      throw e;
    }
  }

  private async unmergedFiles(): Promise<string[]> {
    const r = await git(["diff", "--name-only", "--diff-filter=U"], this.cwd);
    return uniqueLines(r.stdout);
  }

  private async pushWithRetry(): Promise<void> {
    try {
      await git(["push", "-u", "origin", `HEAD:${this.opts.branch}`], this.cwd);
      return;
    } catch (e) {
      debugLog(`[git-filestation] push rejected or failed, fetching and retrying once: ${(e as Error).message}`);
      await git(["fetch", "origin", this.opts.branch], this.cwd);
      await this.mergeRemote(false);
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        throw new Error("Push retry found merge conflicts; resolve them and sync again.");
      }
      await git(["push", "-u", "origin", `HEAD:${this.opts.branch}`], this.cwd);
    }
  }

  private async uploadBareRepoMirror(): Promise<void> {
    await this.ensureRemoteDirectoryTree();
    const files = listLocalFiles(this.remoteCachePath);
    for (const file of files) {
      const rel = file.relativePath;
      if (shouldSkipRemoteGitFile(rel)) continue;
      await this.fs.upload(joinRemotePath(this.opts.remotePath, dirnameRemotePath(rel)), basenameRemotePath(rel), toArrayBuffer(file.bytes), true);
    }
  }

  private async ensureRemoteDirectoryTree(): Promise<void> {
    const parts = normalizeRemotePath(this.opts.remotePath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      const parent = current ? `/${current}` : "/";
      try {
        await this.fs.createFolder(parent, part);
      } catch (e) {
        debugLog(`[git-filestation] createFolder ${parent}/${part} failed: ${(e as Error).message}`);
        throw e;
      }
      current = current ? `${current}/${part}` : part;
    }
  }

  private findNestedGitRepositories(): string[] {
    const path = getNodeModule("path") as { join: (...parts: string[]) => string; relative: (from: string, to: string) => string };
    const fs = getNodeModule("fs") as { readdirSync: (p: string, opts?: { withFileTypes?: boolean }) => Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> };
    const found: string[] = [];
    const allExcludes = DEFAULT_GIT_EXCLUDES;

    const walk = (dir: string): void => {
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === ".git" && dir === this.cwd) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.cwd, full).replace(/\\/g, "/");
        if (!rel || isGitIgnoredPath(rel, allExcludes)) continue;
        if (entry.name === ".git" && (entry.isDirectory() || entry.isFile())) {
          found.push(path.relative(this.cwd, dir).replace(/\\/g, "/") || ".");
          continue;
        }
        if (entry.isDirectory()) walk(full);
      }
    };

    walk(this.cwd);
    return Array.from(new Set(found)).sort();
  }

  private async writeInfoExclude(): Promise<void> {
    const path = getNodeModule("path") as {
      join: (...parts: string[]) => string;
      dirname: (p: string) => string;
    };
    const fs = getNodeModule("fs") as {
      existsSync: (p: string) => boolean;
      mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
      readFileSync: (p: string, encoding: string) => string;
      appendFileSync: (p: string, data: string, encoding: string) => void;
    };

    const excludePath = path.join(this.cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const prior = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const missing = DEFAULT_GIT_EXCLUDES.filter((line) => !prior.split(/\r?\n/).includes(line));
    if (missing.length > 0) {
      fs.appendFileSync(excludePath, `${prior.endsWith("\n") || prior.length === 0 ? "" : "\n"}${missing.join("\n")}\n`, "utf8");
    }
  }
}

function emptyResult(): SyncResult {
  return {
    uploaded: [],
    downloaded: [],
    deleted: [],
    deletedRemote: [],
    deletedLocal: [],
    recreated: [],
    preservedLocal: [],
    conflicts: [],
    errors: [],
  };
}

function getVaultBasePath(vault: Vault): string {
  const adapter = vault.adapter as unknown as { getBasePath?: () => string };
  if (typeof adapter.getBasePath !== "function") {
    throw new Error("Git-over-File-Station sync currently requires an Obsidian desktop vault with a local filesystem path.");
  }
  return adapter.getBasePath();
}


function parsePorcelainZ(output: string): string[] {
  const parts = output.split("\0").filter(Boolean);
  const paths: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;

    if (status.includes("R") || status.includes("C")) {
      paths.push(path);
      i++;
      if (parts[i]) paths.push(parts[i]);
    } else {
      paths.push(path);
    }
  }

  return Array.from(new Set(paths)).sort();
}

function uniqueLines(output: string): string[] {
  return Array.from(new Set(output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))).sort();
}

async function git(args: string[], cwd: string | undefined): Promise<GitCommandResult> {
  const childProcess = getNodeModule("child_process") as {
    execFile: (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
      cb: (error: unknown, stdout: string | Buffer, stderr: string | Buffer) => void,
    ) => void;
  };

  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
          reject(new GitCommandError(`git ${args.join(" ")} failed: ${err || String(error)}`, out, err, code));
          return;
        }
        resolve({ stdout: out, stderr: err });
      },
    );
  });
}

function getNodeModule(id: string): unknown {
  if (typeof require !== "function") throw new Error("Git-over-File-Station sync requires Obsidian desktop Node APIs");
  return require(id);
}

function listLocalFiles(root: string): Array<{ relativePath: string; bytes: Uint8Array }> {
  const fs = getNodeModule("fs") as {
    readdirSync: (p: string, opts?: { withFileTypes?: boolean }) => Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    readFileSync: (p: string) => Buffer;
  };
  const path = getNodeModule("path") as { join: (...parts: string[]) => string };
  const out: Array<{ relativePath: string; bytes: Uint8Array }> = [];

  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push({ relativePath: rel, bytes: new Uint8Array(fs.readFileSync(abs)) });
    }
  };

  walk(root, "");
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function shouldSkipRemoteGitFile(path: string): boolean {
  return path === "config" || path === "description" || path.endsWith(".lock") || path.startsWith("hooks/");
}

function normalizeRemotePath(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

function relativeRemotePath(base: string, path: string): string {
  const normalizedBase = normalizeRemotePath(base);
  if (path === normalizedBase) return "";
  return path.startsWith(`${normalizedBase}/`) ? path.slice(normalizedBase.length + 1) : path;
}

function parentRemotePath(path: string): string {
  const parts = normalizeRemotePath(path).split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`;
}

function basenameRemotePath(path: string): string {
  const parts = normalizeRemotePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function dirnameRemotePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinRemotePath(base: string, relDir: string): string {
  const normalized = normalizeRemotePath(base);
  return relDir ? `${normalized}/${relDir}` : normalized;
}
