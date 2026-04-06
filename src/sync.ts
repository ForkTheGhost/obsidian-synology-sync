import { TFile, TFolder, Vault, Notice } from "obsidian";
import { FileStation, FileInfo } from "./filestation";
import { debugLog } from "./debug";

interface SyncItem {
  relativePath: string;
  localMtime: number | null;  // null = doesn't exist locally
  remoteMtime: number | null; // null = doesn't exist remotely
  localSize: number | null;
  remoteSize: number | null;
}

export type ConflictStrategy = "newer-wins" | "local-wins" | "remote-wins" | "skip";

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  conflicts: string[];
  errors: Array<{ path: string; error: string }>;
}

export class SyncEngine {
  private vault: Vault;
  private fs: FileStation;
  private remotePath: string;
  private conflictStrategy: ConflictStrategy;
  private excludePatterns: RegExp[];

  constructor(
    vault: Vault,
    fs: FileStation,
    remotePath: string,
    conflictStrategy: ConflictStrategy = "newer-wins",
    excludePatterns: string[] = [],
  ) {
    this.vault = vault;
    this.fs = fs;
    this.remotePath = remotePath.replace(/\/+$/, "");
    this.conflictStrategy = conflictStrategy;
    this.excludePatterns = [
      /^\.obsidian\/plugins\/synology-sync\//,
      /^\.trash\//,
      /^\.obsidian\/plugins\/text-extractor\/cache\//,
      /\/\.git\//,
      /^\.obsidian\/workspace-/,
      ...excludePatterns.map((p) => new RegExp(p)),
    ];
  }

  private isExcluded(path: string): boolean {
    return this.excludePatterns.some((re) => re.test(path));
  }

  private async getLocalFiles(): Promise<Map<string, { mtime: number; size: number }>> {
    const files = new Map<string, { mtime: number; size: number }>();
    const allFiles = this.vault.getFiles();
    for (const file of allFiles) {
      if (!this.isExcluded(file.path)) {
        files.set(file.path, { mtime: file.stat.mtime, size: file.stat.size });
      }
    }
    return files;
  }

  private async getRemoteFiles(): Promise<Map<string, { mtime: number; size: number; fullPath: string }>> {
    const files = new Map<string, { mtime: number; size: number; fullPath: string }>();
    const remoteFiles = await this.fs.listAllFiles(this.remotePath);
    const prefixLen = this.remotePath.length + 1; // +1 for trailing /

    for (const f of remoteFiles) {
      const relativePath = f.path.substring(prefixLen);
      if (relativePath && !this.isExcluded(relativePath)) {
        files.set(relativePath, {
          mtime: (f.additional?.time?.mtime ?? 0) * 1000, // convert to ms
          size: f.additional?.size ?? 0,
          fullPath: f.path,
        });
      }
    }
    return files;
  }

  async sync(deleteOrphans: boolean = false): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      conflicts: [],
      errors: [],
    };

    const localFiles = await this.getLocalFiles();
    const remoteFiles = await this.getRemoteFiles();
    const allPaths = new Set([...localFiles.keys(), ...remoteFiles.keys()]);

    for (const path of allPaths) {
      const local = localFiles.get(path);
      const remote = remoteFiles.get(path);

      try {
        if (local && !remote) {
          // Local only: upload
          await this.uploadFile(path);
          result.uploaded.push(path);
        } else if (!local && remote) {
          if (deleteOrphans) {
            // Remote only + delete orphans: remove from remote
            await this.fs.delete(remote.fullPath);
            result.deleted.push(path);
          } else {
            // Remote only: download
            await this.downloadFile(path, remote.fullPath);
            result.downloaded.push(path);
          }
        } else if (local && remote) {
          // Both exist: compare
          const timeDiff = Math.abs(local.mtime - remote.mtime);
          if (timeDiff < 2000 && local.size === remote.size) {
            // Close enough in time and same size: skip
            continue;
          }

          switch (this.conflictStrategy) {
            case "newer-wins":
              if (local.mtime > remote.mtime) {
                await this.uploadFile(path);
                result.uploaded.push(path);
              } else if (remote.mtime > local.mtime) {
                await this.downloadFile(path, remote.fullPath);
                result.downloaded.push(path);
              }
              break;
            case "local-wins":
              await this.uploadFile(path);
              result.uploaded.push(path);
              break;
            case "remote-wins":
              await this.downloadFile(path, remote.fullPath);
              result.downloaded.push(path);
              break;
            case "skip":
              result.conflicts.push(path);
              break;
          }
        }
      } catch (e) {
        const errMsg = (e as Error).message;
        result.errors.push({ path, error: errMsg });
        debugLog(`SYNC ERROR: ${path} - ${errMsg}`);
      }
    }

    return result;
  }

  private async uploadFile(relativePath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(relativePath);
    if (!(file instanceof TFile)) return;

    const content = await this.vault.readBinary(file);
    const parts = relativePath.split("/");
    const fileName = parts.pop()!;
    const remoteDir = parts.length > 0
      ? `${this.remotePath}/${parts.join("/")}`
      : this.remotePath;

    // Ensure remote directory exists (createFolder already ignores "exists" errors)
    if (parts.length > 0) {
      let current = this.remotePath;
      for (const part of parts) {
        try {
          await this.fs.createFolder(current, part);
        } catch {
          // Folder may already exist -- safe to ignore
        }
        current += "/" + part;
      }
    }

    await this.fs.upload(remoteDir, fileName, content, true, file.stat.mtime);
  }

  private async downloadFile(relativePath: string, remoteFullPath: string): Promise<void> {
    const content = await this.fs.download(remoteFullPath);

    // Ensure local directory exists
    const parts = relativePath.split("/");
    parts.pop();
    if (parts.length > 0) {
      const dirPath = parts.join("/");
      const existing = this.vault.getAbstractFileByPath(dirPath);
      if (!existing) {
        try {
          await this.vault.createFolder(dirPath);
        } catch {
          // Folder may have been created by a concurrent download -- ignore
        }
      }
    }

    const existing = this.vault.getAbstractFileByPath(relativePath);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, content);
    } else {
      await this.vault.createBinary(relativePath, content);
    }
  }
}
