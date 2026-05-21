import { TFile, Vault } from "obsidian";
import { FileStation } from "./filestation";
import { debugLog } from "./debug";
import { SyncResult } from "./sync";
import { buildGitExcludes, classifyGitConflict, findInvalidLocalFilesystemPaths, invalidLocalFilesystemPathError, nestedGitRepoError } from "./git-sync";

import * as git from "isomorphic-git";

export interface MobileGitFileStationSyncOptions {
  remotePath: string;
  branch: string;
  syncIdentityId: string;
  authorName: string;
  authorEmail: string;
}

type FsData = Uint8Array;

type NodeLikeStat = {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
};

type FsNode =
  | { type: "dir"; children: Map<string, FsNode>; mtimeMs: number; ctimeMs: number; mode: number }
  | { type: "file"; data: FsData; mtimeMs: number; ctimeMs: number; mode: number };

const DEFAULT_GIT_EXCLUDES = buildGitExcludes();
const WORKDIR = "/vault";
const GITDIR = "/vault/.git";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Browser/mobile Git-over-File-Station engine.
 *
 * It intentionally avoids Obsidian desktop-only getBasePath(), Node fs, and
 * native git. The vault and NAS bare repo are mirrored into an in-memory FS,
 * isomorphic-git performs the Git operations, and only changed checkout files
 * are written back through Obsidian's Vault adapter.
 */
export class MobileGitFileStationSyncEngine {
  private vault: Vault;
  private fs: FileStation;
  private opts: MobileGitFileStationSyncOptions;
  private memfs = new MemoryFs();
  private cache: Record<string, unknown> = {};

  constructor(vault: Vault, fs: FileStation, opts: MobileGitFileStationSyncOptions) {
    this.vault = vault;
    this.fs = fs;
    this.opts = {
      ...opts,
      remotePath: normalizeRemotePath(opts.remotePath),
      branch: opts.branch.trim() || "main",
      authorName: opts.authorName.trim() || "Obsidian Synology Sync",
      authorEmail: opts.authorEmail.trim() || "synology-sync@local",
    };
  }

  async sync(): Promise<SyncResult> {
    const result = emptyResult();
    debugLog("[git-filestation-mobile] starting pure JS Git sync over File Station");

    await this.loadVaultIntoMemory();
    await this.ensureLocalRepo();
    await this.configureLocalRepo();
    await this.downloadRemoteBareRepoIfPresent();
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

    const beforeSnapshot = await this.snapshotWorkdirFiles();
    const localChanged = await this.changedFiles();

    if (!localHadCommits && remoteHadCommits && !this.localHasUserFiles()) {
      await this.checkoutRemote();
      await this.applyCheckoutChanges(beforeSnapshot, result);
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
        await this.applyCheckoutChanges(beforeSnapshot, result);
        return result;
      }
    }

    await this.pushWithRetry();
    await this.applyCheckoutChanges(beforeSnapshot, result);
    await this.uploadBareRepoMirror();
    return result;
  }

  private async ensureLocalRepo(): Promise<void> {
    if (await this.pathExists(GITDIR)) return;
    await git.init({ fs: this.memfs.client, dir: WORKDIR, defaultBranch: this.opts.branch });
  }

  private async configureLocalRepo(): Promise<void> {
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: "user.name", value: this.opts.authorName });
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: "user.email", value: this.opts.authorEmail });
    await this.writeInfoExclude();
  }

  private async ensureRemoteConfigured(): Promise<void> {
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: "remote.origin.url", value: GITDIR });
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: `branch.${this.opts.branch}.remote`, value: "origin" });
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: `branch.${this.opts.branch}.merge`, value: `refs/heads/${this.opts.branch}` });
  }

  private async downloadRemoteBareRepoIfPresent(): Promise<void> {
    let files;
    try {
      files = await this.fs.listAllFiles(this.opts.remotePath);
    } catch (e) {
      debugLog(`[git-filestation-mobile] remote bare repo not found or unreadable; will initialize: ${(e as Error).message}`);
      return;
    }

    for (const file of files) {
      if (file.isdir) continue;
      const rel = relativeRemotePath(this.opts.remotePath, file.path);
      if (!rel || shouldSkipRemoteGitFile(rel)) continue;
      await this.writeMemFile(`${GITDIR}/${rel}`, new Uint8Array(await this.fs.download(file.path)));
    }
  }

  private async remoteHasCommits(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}` });
      return true;
    } catch {
      return false;
    }
  }

  private async localHasCommits(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  private localHasUserFiles(): boolean {
    return this.vault.getFiles().some((file) => {
      if (!(file instanceof TFile)) return false;
      if (file.path.startsWith(".obsidian/")) return false;
      if (DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(file.path, pattern))) return false;
      return true;
    });
  }

  private async checkoutRemote(): Promise<void> {
    await git.branch({ fs: this.memfs.client, dir: WORKDIR, ref: this.opts.branch, checkout: true, force: true });
    await git.checkout({ fs: this.memfs.client, dir: WORKDIR, ref: this.opts.branch, force: true });
  }

  private async changedFiles(): Promise<string[]> {
    const matrix = await git.statusMatrix({ fs: this.memfs.client, dir: WORKDIR, ignored: false, cache: this.cache });
    return matrix
      .filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
      .map(([filepath]) => filepath)
      .filter((path) => !this.isExcluded(path))
      .sort();
  }

  private async commitLocalChanges(message: string, allowEmpty: boolean): Promise<void> {
    const files = await this.listWorkdirFiles();
    for (const file of files) {
      if (!this.isExcluded(file)) await git.add({ fs: this.memfs.client, dir: WORKDIR, filepath: file, cache: this.cache });
    }

    const tracked = await git.listFiles({ fs: this.memfs.client, dir: WORKDIR, cache: this.cache });
    for (const file of tracked) {
      if (!(await this.pathExists(`${WORKDIR}/${file}`))) await git.remove({ fs: this.memfs.client, dir: WORKDIR, filepath: file, cache: this.cache });
    }

    const changed = await this.changedFiles();
    if (changed.length === 0 && !allowEmpty) return;

    await git.commit({
      fs: this.memfs.client,
      dir: WORKDIR,
      message,
      author: { name: this.opts.authorName, email: this.opts.authorEmail },
      committer: { name: this.opts.authorName, email: this.opts.authorEmail },
      cache: this.cache,
    });
  }

  private async remoteChangedFiles(): Promise<string[]> {
    try {
      const remoteFiles = await git.listFiles({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}`, cache: this.cache });
      const localFiles = await git.listFiles({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD", cache: this.cache }).catch(() => [] as string[]);
      return Array.from(new Set([...remoteFiles, ...localFiles])).filter((p) => !this.isExcluded(p)).sort();
    } catch {
      return [];
    }
  }

  private async remoteTreeFiles(): Promise<string[]> {
    try {
      return (await git.listFiles({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}`, cache: this.cache })).sort();
    } catch {
      return [];
    }
  }

  private async invalidRemotePathsForLocalCheckout(): Promise<string[]> {
    return findInvalidLocalFilesystemPaths(await this.remoteTreeFiles());
  }

  private async mergeRemote(allowUnrelatedHistories: boolean): Promise<void> {
    try {
      await git.merge({
        fs: this.memfs.client,
        dir: WORKDIR,
        ours: this.opts.branch,
        theirs: `refs/heads/${this.opts.branch}`,
        fastForward: true,
        abortOnConflict: false,
        allowUnrelatedHistories,
        author: { name: this.opts.authorName, email: this.opts.authorEmail },
        committer: { name: this.opts.authorName, email: this.opts.authorEmail },
        cache: this.cache,
      });
    } catch (e) {
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        debugLog(`[git-filestation-mobile] merge stopped with conflicts: ${conflicts.join(", ")}`);
        return;
      }
      throw e;
    }
  }

  private async unmergedFiles(): Promise<string[]> {
    const matrix = await git.statusMatrix({ fs: this.memfs.client, dir: WORKDIR, ignored: false, cache: this.cache });
    return matrix
      .filter(([, head, workdir, stage]) => head !== 1 && workdir === 2 && stage === 0)
      .map(([filepath]) => filepath)
      .sort();
  }

  private async pushWithRetry(): Promise<void> {
    try {
      await this.copyLocalBranchToRemote();
    } catch (e) {
      debugLog(`[git-filestation-mobile] push failed, retrying merge once: ${(e as Error).message}`);
      await this.mergeRemote(false);
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) throw new Error("Push retry found merge conflicts; resolve them and sync again.");
      await this.copyLocalBranchToRemote();
    }
  }

  private async copyLocalBranchToRemote(): Promise<void> {
    const oid = await git.resolveRef({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD" });
    await this.writeMemText(`${GITDIR}/refs/heads/${this.opts.branch}`, `${oid}\n`);
  }

  private async uploadBareRepoMirror(): Promise<void> {
    await this.ensureRemoteDirectoryTree();
    const files = await this.listMemFiles(GITDIR);
    for (const abs of files) {
      const rel = abs.slice(GITDIR.length + 1);
      if (shouldSkipRemoteGitFile(rel)) continue;
      const bytes = await this.memfs.promises.readFile(abs);
      await this.fs.upload(joinRemotePath(this.opts.remotePath, dirnameRemotePath(rel)), basenameRemotePath(rel), bytesToArrayBuffer(bytes), true);
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
        debugLog(`[git-filestation-mobile] createFolder ${parent}/${part} failed: ${(e as Error).message}`);
      }
      current = current ? `${current}/${part}` : part;
    }
  }

  private findNestedGitRepositories(): string[] {
    const found = this.vault.getFiles()
      .map((file) => file.path)
      .filter((path) => /(^|\/)\.git(\/|$)/.test(path))
      .map((path) => path.replace(/\/.git(\/.*)?$/, ""))
      .filter((path) => path && !DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(path, pattern)));
    return Array.from(new Set(found)).sort();
  }

  private async loadVaultIntoMemory(): Promise<void> {
    await this.memfs.promises.mkdir(WORKDIR, { recursive: true });
    for (const file of this.vault.getFiles()) {
      if (!(file instanceof TFile)) continue;
      if (this.isExcluded(file.path)) continue;
      await this.writeMemFile(`${WORKDIR}/${file.path}`, new Uint8Array(await this.vault.readBinary(file)));
    }
  }

  private async snapshotWorkdirFiles(): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    for (const file of await this.listWorkdirFiles()) {
      if (!this.isExcluded(file)) snapshot.set(file, await this.fileHash(`${WORKDIR}/${file}`));
    }
    return snapshot;
  }

  private async applyCheckoutChanges(before: Map<string, string>, result: SyncResult): Promise<void> {
    const after = await this.snapshotWorkdirFiles();
    const all = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
    for (const path of all) {
      if (this.isExcluded(path)) continue;
      const beforeHash = before.get(path);
      const afterHash = after.get(path);
      if (beforeHash === afterHash) continue;
      const file = this.vault.getAbstractFileByPath(path);
      if (afterHash === undefined) {
        if (file instanceof TFile) {
          await this.vault.delete(file);
          result.deleted.push(path);
        }
        continue;
      }
      const bytes = await this.memfs.promises.readFile(`${WORKDIR}/${path}`);
      if (file instanceof TFile) await this.vault.modifyBinary(file, bytesToArrayBuffer(bytes));
      else await this.vault.createBinary(path, bytesToArrayBuffer(bytes));
      if (!result.downloaded.includes(path) && !result.uploaded.includes(path)) result.downloaded.push(path);
    }
  }

  private async writeInfoExclude(): Promise<void> {
    const path = `${GITDIR}/info/exclude`;
    const prior = await this.readMemText(path).catch(() => "");
    const lines = prior.split(/\r?\n/);
    const missing = DEFAULT_GIT_EXCLUDES.filter((line) => !lines.includes(line));
    if (missing.length > 0) {
      await this.writeMemText(path, `${prior}${prior.endsWith("\n") || prior.length === 0 ? "" : "\n"}${missing.join("\n")}\n`);
    }
  }

  private isExcluded(path: string): boolean {
    return path.startsWith(".git/") || DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(path, pattern));
  }

  private async listWorkdirFiles(): Promise<string[]> {
    const files = await this.listMemFiles(WORKDIR);
    return files
      .map((path) => path.slice(WORKDIR.length + 1))
      .filter((path) => path && !path.startsWith(".git/"))
      .sort();
  }

  private async listMemFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: string[];
      try { entries = await this.memfs.promises.readdir(dir); } catch { return; }
      for (const name of entries) {
        const abs = `${dir}/${name}`;
        const stat = await this.memfs.promises.lstat(abs);
        if (stat.isDirectory()) await walk(abs);
        else if (stat.isFile()) out.push(abs);
      }
    };
    await walk(root);
    return out.sort();
  }

  private async pathExists(path: string): Promise<boolean> {
    try { await this.memfs.promises.lstat(path); return true; } catch { return false; }
  }

  private async writeMemText(path: string, text: string): Promise<void> {
    await this.writeMemFile(path, textEncoder.encode(text));
  }

  private async readMemText(path: string): Promise<string> {
    return textDecoder.decode(await this.memfs.promises.readFile(path));
  }

  private async writeMemFile(path: string, data: Uint8Array): Promise<void> {
    await this.memfs.promises.mkdir(dirname(path), { recursive: true });
    await this.memfs.promises.writeFile(path, data);
  }

  private async fileHash(path: string): Promise<string> {
    const data = await this.memfs.promises.readFile(path);
    let hash = 2166136261;
    for (const byte of data) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `${data.byteLength}:${hash >>> 0}`;
  }
}

class MemoryFs {
  private root: FsNode = { type: "dir", children: new Map(), mtimeMs: Date.now(), ctimeMs: Date.now(), mode: 0o040777 };

  promises = {
    readFile: async (path: string, encoding?: string): Promise<Uint8Array | string> => {
      const node = this.getNode(path);
      if (node.type !== "file") throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
      return encoding ? textDecoder.decode(node.data) : new Uint8Array(node.data);
    },
    writeFile: async (path: string, data: Uint8Array | string): Promise<void> => {
      const parent = this.getParent(path, true);
      const name = basename(path);
      const bytes = typeof data === "string" ? textEncoder.encode(data) : new Uint8Array(data);
      parent.children.set(name, { type: "file", data: bytes, mtimeMs: Date.now(), ctimeMs: Date.now(), mode: 0o100644 });
    },
    unlink: async (path: string): Promise<void> => {
      const parent = this.getParent(path, false);
      if (!parent.children.delete(basename(path))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    readdir: async (path: string): Promise<string[]> => {
      const node = this.getNode(path);
      if (node.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      return Array.from(node.children.keys()).sort();
    },
    mkdir: async (path: string, opts?: { recursive?: boolean } | number): Promise<void> => {
      const recursive = typeof opts === "object" && !!opts.recursive;
      try {
        this.ensureDir(path, recursive);
      } catch (error) {
        if (recursive || !isMissingParentDir(error)) throw error;
        // isomorphic-git initializes nested paths one level at a time, but on
        // mobile this in-memory FS is the only parent creator. Match the
        // forgiving behavior of browser filesystem shims for missing parents.
        this.ensureDir(path, true);
      }
    },
    rmdir: async (path: string): Promise<void> => {
      const node = this.getNode(path);
      if (node.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      if (node.children.size > 0) throw Object.assign(new Error(`ENOTEMPTY: ${path}`), { code: "ENOTEMPTY" });
      const parent = this.getParent(path, false);
      parent.children.delete(basename(path));
    },
    stat: async (path: string): Promise<NodeLikeStat> => this.toStat(this.getNode(path)),
    lstat: async (path: string): Promise<NodeLikeStat> => this.toStat(this.getNode(path)),
    readlink: async (): Promise<string> => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); },
    symlink: async (): Promise<void> => { throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" }); },
    chmod: async (path: string, mode: number): Promise<void> => { this.getNode(path).mode = mode; },
  };

  client = { promises: this.promises };

  private getNode(path: string): FsNode {
    const parts = splitPath(path);
    let node = this.root;
    for (const part of parts) {
      if (node.type !== "dir" || !node.children.has(part)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      node = node.children.get(part) as FsNode;
    }
    return node;
  }

  private getParent(path: string, create: boolean): Extract<FsNode, { type: "dir" }> {
    return this.ensureDir(dirname(path), create);
  }

  private ensureDir(path: string, recursive: boolean): Extract<FsNode, { type: "dir" }> {
    const parts = splitPath(path);
    let node = this.root;
    for (const part of parts) {
      if (node.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      let child = node.children.get(part);
      if (!child) {
        if (!recursive) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        child = { type: "dir", children: new Map(), mtimeMs: Date.now(), ctimeMs: Date.now(), mode: 0o040777 };
        node.children.set(part, child);
      }
      if (child.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      node = child;
    }
    return node;
  }

  private toStat(node: FsNode): NodeLikeStat {
    return {
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
      isSymbolicLink: () => false,
      size: node.type === "file" ? node.data.byteLength : 0,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      mode: node.mode,
    };
  }
}

function emptyResult(): SyncResult {
  return { uploaded: [], downloaded: [], deleted: [], deletedRemote: [], deletedLocal: [], recreated: [], preservedLocal: [], conflicts: [], errors: [] };
}

function isMissingParentDir(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function normalizeRemotePath(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

function relativeRemotePath(base: string, path: string): string {
  const normalizedBase = normalizeRemotePath(base);
  if (path === normalizedBase) return "";
  return path.startsWith(`${normalizedBase}/`) ? path.slice(normalizedBase.length + 1) : path;
}

function matchesSimpleExclude(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

function shouldSkipRemoteGitFile(path: string): boolean {
  return path === "config" || path === "description" || path.endsWith(".lock") || path.startsWith("hooks/");
}

function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] || "";
}

function dirname(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return `/${parts.join("/")}`;
}

function splitPath(path: string): string[] {
  if (path === ".") return [];
  return path.split("/").filter((part) => part.length > 0 && part !== ".");
}

function basenameRemotePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
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

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
