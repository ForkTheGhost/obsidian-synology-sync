import { FileStation, FileStationApiError, FileStationPathExistsError } from "./filestation";
import { debugLog } from "./debug";
import { Notice } from "obsidian";

export interface GitLeaseInfo {
  owner: string;
  branch: string;
  expectedOldRef?: string;
  createdAt: string;
  expiresAt: string;
  token: string;
}

export interface GitLeaseOptions {
  remotePath: string;
  branch: string;
  owner: string;
  expectedOldRef?: string;
  ttlMs?: number;
  now?: () => number;
}

export class FileStationGitLeaseHeldError extends FileStationApiError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = "FileStationGitLeaseHeldError";
  }
}

export class FileStationGitLeaseRecoveredError extends FileStationApiError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = "FileStationGitLeaseRecoveredError";
  }
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const LEASE_ROOT = ".synology-sync/leases";

export class FileStationGitLease {
  private fs: FileStation;
  private opts: Required<Omit<GitLeaseOptions, "expectedOldRef">> & Pick<GitLeaseOptions, "expectedOldRef">;
  private leaseName: string;
  private leaseDir: string;
  private metadataPath: string;
  private verificationMetadataPath: string;
  private token: string;
  private acquired = false;

  constructor(fs: FileStation, opts: GitLeaseOptions) {
    this.fs = fs;
    this.opts = {
      ...opts,
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
      now: opts.now ?? (() => Date.now()),
    };
    this.leaseName = `${safeLeaseComponent(this.opts.branch)}.lock`;
    this.leaseDir = joinRemotePath(this.opts.remotePath, `${LEASE_ROOT}/${this.leaseName}`);
    this.metadataPath = joinRemotePath(this.leaseDir, "lease.json");
    this.token = `${safeLeaseComponent(this.opts.owner)}-${this.opts.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.verificationMetadataPath = joinRemotePath(this.leaseDir, `lease-${safeLeaseComponent(this.token)}.json`);
  }

  get info(): GitLeaseInfo {
    const createdAtMs = this.opts.now();
    return {
      owner: this.opts.owner,
      branch: this.opts.branch,
      expectedOldRef: this.opts.expectedOldRef,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.opts.ttlMs).toISOString(),
      token: this.token,
    };
  }

  async acquire(): Promise<GitLeaseInfo> {
    await this.ensureLeaseRoot();
    let createdLeaseDir = false;
    try {
      await this.fs.createFolderStrict(joinRemotePath(this.opts.remotePath, LEASE_ROOT), this.leaseName);
      createdLeaseDir = true;
    } catch (e) {
      if (e instanceof FileStationPathExistsError) {
        if (await this.tryRecoverExpiredLease(e.code)) {
          await this.fs.createFolderStrict(joinRemotePath(this.opts.remotePath, LEASE_ROOT), this.leaseName);
          createdLeaseDir = true;
        } else {
          throw new FileStationGitLeaseHeldError(`Git-backed File Station lease is already held for ${this.opts.branch}. Try again after the other device finishes, or clear stale lease ${this.leaseDir} only after verifying no sync is running.`, e.code);
        }
      } else {
        throw e;
      }
    }

    const info = this.info;
    try {
      await this.writeMetadata(info);
      await this.verifyMetadata(info);
      this.acquired = true;
      debugLog(`[git-filestation-lease] acquired branch=${this.opts.branch} owner=${this.opts.owner} expires=${info.expiresAt}`);
      return info;
    } catch (e) {
      if (createdLeaseDir) {
        try { await this.fs.delete(this.leaseDir); } catch { /* best effort cleanup */ }
      }
      throw e;
    }
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    try {
      await this.fs.delete(this.leaseDir);
      debugLog(`[git-filestation-lease] released branch=${this.opts.branch} owner=${this.opts.owner}`);
      this.acquired = false;
    } catch (e) {
      debugLog(`[git-filestation-lease] release failed for ${this.leaseDir}: ${(e as Error).message}`);
      throw e;
    }
  }


  private async tryRecoverExpiredLease(code?: number): Promise<boolean> {
    let prior: GitLeaseInfo | undefined;
    try {
      prior = await this.readMetadata();
    } catch (e) {
      debugLog(`[git-filestation-lease] existing lease metadata unreadable for ${this.leaseDir}: ${(e as Error).message}`);
      return false;
    }
    const expiresAt = Date.parse(prior.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > this.opts.now()) return false;
    debugLog(`[git-filestation-lease] recovering expired lease branch=${this.opts.branch} priorOwner=${prior.owner} expired=${prior.expiresAt}`);
    try { new Notice(`Synology Sync recovered an expired Git sync lease for ${this.opts.branch}. Previous owner: ${prior.owner || "unknown"}.`); } catch { /* Notice unavailable in tests */ }
    await this.fs.delete(this.leaseDir);
    return true;
  }

  private async readMetadata(): Promise<GitLeaseInfo> {
    return await this.readMetadataAt(this.metadataPath);
  }

  private async readMetadataAt(path: string): Promise<GitLeaseInfo> {
    const fs = this.fs as unknown as { download?: (path: string) => Promise<ArrayBuffer> };
    if (typeof fs.download !== "function") throw new Error("File Station download is unavailable");
    const bytes = new Uint8Array(await fs.download(path));
    return JSON.parse(new TextDecoder().decode(bytes)) as GitLeaseInfo;
  }

  private async verifyMetadata(expected: GitLeaseInfo): Promise<void> {
    const fs = this.fs as unknown as { download?: (path: string) => Promise<ArrayBuffer> };
    if (typeof fs.download !== "function") return;
    let lastActual: GitLeaseInfo | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const actual = await this.readVerificationMetadata();
      lastActual = actual;
      if (
        actual.token === expected.token &&
        actual.owner === expected.owner &&
        actual.branch === expected.branch &&
        (actual.expectedOldRef || undefined) === (expected.expectedOldRef || undefined)
      ) {
        return;
      }
      if (attempt < 4) {
        debugLog(`[git-filestation-lease] metadata verification mismatch; retrying branch=${this.opts.branch} attempt=${attempt + 1}`);
        await sleep(150 * (attempt + 1));
      }
    }
    debugLog(`[git-filestation-lease] metadata verification mismatch final branch=${this.opts.branch} ownerMatches=${lastActual?.owner === expected.owner} branchMatches=${lastActual?.branch === expected.branch} expectedOldRefMatches=${(lastActual?.expectedOldRef || undefined) === (expected.expectedOldRef || undefined)}`);
    throw new Error(`Git lease metadata verification failed for ${this.leaseDir}; refusing to sync without a verified lease token.`);
  }

  private async ensureLeaseRoot(): Promise<void> {
    await this.fs.createFolder(this.opts.remotePath, ".synology-sync");
    await this.fs.createFolder(joinRemotePath(this.opts.remotePath, ".synology-sync"), "leases");
  }

  private async writeMetadata(info: GitLeaseInfo): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(info, null, 2));
    await this.fs.upload(this.leaseDir, "lease.json", toArrayBuffer(bytes), true);
    await this.fs.upload(this.leaseDir, basenameRemotePath(this.verificationMetadataPath), toArrayBuffer(bytes), true);
  }

  private async readVerificationMetadata(): Promise<GitLeaseInfo> {
    try {
      return await this.readMetadataAt(this.verificationMetadataPath);
    } catch {
      return await this.readMetadata();
    }
  }
}

export async function withFileStationGitLease<T>(fs: FileStation, opts: GitLeaseOptions, fn: (lease: GitLeaseInfo) => Promise<T>): Promise<T> {
  const lease = new FileStationGitLease(fs, opts);
  const info = await lease.acquire();
  try {
    return await fn(info);
  } finally {
    await lease.release();
  }
}

function safeLeaseComponent(value: string): string {
  return (value || "main").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "main";
}

function joinRemotePath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

function basenameRemotePath(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
