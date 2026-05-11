import { TFile, Vault } from "obsidian";
import { debugLog } from "./debug";
import { SyncResult } from "./sync";

declare const require: ((id: string) => unknown) | undefined;

export interface GitSyncOptions {
  remotePath: string;
  branch: string;
  syncIdentityId: string;
  authorName: string;
  authorEmail: string;
}

export interface GitSetupState {
  localRepoExists: boolean;
  localHasCommits: boolean;
  localHasUserFiles: boolean;
  remoteExists: boolean;
  remoteIsBareRepo: boolean;
  remoteIsEmptyDirectory: boolean;
  remoteHasCommits: boolean;
}

export type GitSetupAction =
  | "checkout-remote"
  | "initialize-empty"
  | "publish-local"
  | "merge-existing"
  | "sync-existing"
  | "invalid-remote";

export interface GitSetupClassification {
  action: GitSetupAction;
  reason: string;
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

const DEFAULT_GIT_EXCLUDES = [
  ".obsidian/plugins/synology-sync/",
  ".obsidian/workspace-*",
  ".trash/",
  ".sync-tombstones/",
  "node_modules/",
];

export function classifyGitSetup(state: GitSetupState): GitSetupClassification {
  if (state.remoteExists && !state.remoteIsBareRepo && !state.remoteIsEmptyDirectory) {
    return {
      action: "invalid-remote",
      reason: "Destination exists but is not a bare Git repository.",
    };
  }

  if (state.localHasCommits && state.remoteHasCommits) {
    return {
      action: "sync-existing",
      reason: "Local and destination both have Git history.",
    };
  }

  if (state.localHasCommits && !state.remoteHasCommits) {
    return {
      action: "publish-local",
      reason: "Local history exists and destination has no commits.",
    };
  }

  if (!state.localHasCommits && state.remoteHasCommits) {
    if (state.localHasUserFiles) {
      return {
        action: "merge-existing",
        reason: "Local files and destination history both exist; checkpoint local before merging.",
      };
    }
    return {
      action: "checkout-remote",
      reason: "Local vault is effectively empty and destination has history.",
    };
  }

  if (state.localHasUserFiles) {
    return {
      action: "publish-local",
      reason: "Local vault has files and destination has no commits.",
    };
  }

  return {
    action: "initialize-empty",
    reason: "Local vault and destination are both effectively empty.",
  };
}

export class NativeGitSyncEngine {
  private vault: Vault;
  private opts: GitSyncOptions;
  private cwd: string;

  constructor(vault: Vault, opts: GitSyncOptions) {
    this.vault = vault;
    this.opts = {
      ...opts,
      branch: opts.branch.trim() || "main",
      authorName: opts.authorName.trim() || "Obsidian Synology Sync",
      authorEmail: opts.authorEmail.trim() || "synology-sync@local",
    };
    this.cwd = getVaultBasePath(vault);
  }

  async sync(): Promise<SyncResult> {
    const result = emptyResult();

    await this.ensureGitAvailable();
    await this.ensureLocalRepo();
    await this.configureLocalRepo();

    const state = await this.inspectSetupState();
    const classification = classifyGitSetup(state);
    debugLog(`[git-sync] setup=${classification.action}: ${classification.reason}`);

    if (classification.action === "invalid-remote") {
      throw new Error(
        "Git sync destination exists but is not a bare Git repository. Create it with `git init --bare <path>` or choose an empty destination.",
      );
    }

    if (!state.remoteExists || state.remoteIsEmptyDirectory) {
      await this.ensureRemoteBareRepo();
    }

    await this.ensureRemoteConfigured();

    const localChanged = await this.changedFiles();
    const checkoutNeedsLocalCheckpoint =
      classification.action === "checkout-remote" && localChanged.length > 0;

    if (classification.action === "checkout-remote" && !checkoutNeedsLocalCheckpoint) {
      await this.checkoutRemote(result);
      return result;
    }

    const needsBootstrapCommit =
      classification.action === "initialize-empty" && !(await this.localHasCommits());

    if (localChanged.length > 0 || needsBootstrapCommit) {
      await this.commitLocalChanges(
        checkoutNeedsLocalCheckpoint
          ? "Bootstrap local vault before Git sync"
          : classification.action === "initialize-empty"
          ? "Initialize Obsidian vault sync"
          : `Sync from ${this.opts.syncIdentityId}`,
        needsBootstrapCommit,
      );
      result.uploaded.push(...localChanged);
    }

    const remoteHasCommits = await this.remoteHasCommits();
    if (remoteHasCommits) {
      const remoteChanged = await this.remoteChangedFiles();
      await this.mergeRemote(classification.action === "merge-existing" || checkoutNeedsLocalCheckpoint);
      result.downloaded.push(...remoteChanged);

      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        result.conflicts.push(...conflicts);
        result.errors.push({
          path: "<git-merge>",
          error: "Merge conflicts need to be resolved before Git sync can push.",
        });
        return result;
      }
    }

    await this.pushWithRetry();
    return result;
  }

  private async ensureGitAvailable(): Promise<void> {
    try {
      await git(["--version"], undefined);
    } catch (e) {
      throw new Error(
        `Git filesystem sync requires native Git on this device. ${(e as Error).message}`,
      );
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

  private async inspectSetupState(): Promise<GitSetupState> {
    const remoteExists = pathExists(this.opts.remotePath);
    const remoteIsBareRepo = remoteExists ? await this.remoteIsBareRepo() : false;
    const remoteIsEmptyDirectory = remoteExists && !remoteIsBareRepo ? isEmptyDirectory(this.opts.remotePath) : false;
    return {
      localRepoExists: await this.localRepoExists(),
      localHasCommits: await this.localHasCommits(),
      localHasUserFiles: this.localHasUserFiles(),
      remoteExists,
      remoteIsBareRepo,
      remoteIsEmptyDirectory,
      remoteHasCommits: remoteIsBareRepo ? await this.remoteHasCommits() : false,
    };
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
      if (isSetupOnlyPath(file.path)) return false;
      if (DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(file.path, pattern))) return false;
      return true;
    });
  }

  private async remoteIsBareRepo(): Promise<boolean> {
    try {
      const r = await git(["--git-dir", this.opts.remotePath, "rev-parse", "--is-bare-repository"], undefined);
      return r.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async remoteHasCommits(): Promise<boolean> {
    try {
      const r = await git(["ls-remote", "--heads", this.opts.remotePath, this.opts.branch], this.cwd);
      return r.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async ensureRemoteBareRepo(): Promise<void> {
    ensureParentDirectory(this.opts.remotePath);
    await git(["init", "--bare", "-b", this.opts.branch, this.opts.remotePath], undefined);
  }

  private async ensureRemoteConfigured(): Promise<void> {
    const remotes = await git(["remote"], this.cwd);
    if (!remotes.stdout.split(/\r?\n/).includes("origin")) {
      await git(["remote", "add", "origin", this.opts.remotePath], this.cwd);
      return;
    }
    await git(["remote", "set-url", "origin", this.opts.remotePath], this.cwd);
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

  private async mergeRemote(allowUnrelatedHistories: boolean): Promise<void> {
    const args = ["merge", "--no-edit"];
    if (allowUnrelatedHistories) args.push("--allow-unrelated-histories");
    args.push(`origin/${this.opts.branch}`);

    try {
      await git(args, this.cwd);
    } catch (e) {
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        debugLog(`[git-sync] merge stopped with conflicts: ${conflicts.join(", ")}`);
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
      debugLog(`[git-sync] push rejected or failed, fetching and retrying once: ${(e as Error).message}`);
      await git(["fetch", "origin", this.opts.branch], this.cwd);
      await this.mergeRemote(false);
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        throw new Error("Push retry found merge conflicts; resolve them and sync again.");
      }
      await git(["push", "-u", "origin", `HEAD:${this.opts.branch}`], this.cwd);
    }
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
    throw new Error("Git filesystem sync requires an Obsidian desktop vault with a local filesystem path.");
  }
  return adapter.getBasePath();
}

function isSetupOnlyPath(path: string): boolean {
  return path.startsWith(".obsidian/");
}

function matchesSimpleExclude(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
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

function pathExists(path: string): boolean {
  const fs = getNodeModule("fs") as { existsSync: (p: string) => boolean };
  return fs.existsSync(path);
}

function ensureParentDirectory(targetPath: string): void {
  const path = getNodeModule("path") as { dirname: (p: string) => string };
  const fs = getNodeModule("fs") as {
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  };
  const parent = path.dirname(targetPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function isEmptyDirectory(targetPath: string): boolean {
  const fs = getNodeModule("fs") as {
    existsSync: (p: string) => boolean;
    statSync: (p: string) => { isDirectory: () => boolean };
    readdirSync: (p: string) => string[];
  };
  return fs.existsSync(targetPath) &&
    fs.statSync(targetPath).isDirectory() &&
    fs.readdirSync(targetPath).length === 0;
}

function getNodeModule(id: string): unknown {
  try {
    if (typeof require === "function") return require(id);
    const req = Function("return require")() as (name: string) => unknown;
    return req(id);
  } catch {
    throw new Error("Native Git sync is only available in desktop Obsidian with Node.js access.");
  }
}
