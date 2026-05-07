import { TFile, Vault, Notice } from "obsidian";
import { FileStation } from "./filestation";
import { debugLog } from "./debug";
import {
  Action,
  ConflictStrategy,
  decideAction,
  DecideConfig,
  HistoryEntry,
  LocalEntry,
  RemoteEntry,
  TombstoneEntry as DecisionTombstoneEntry,
} from "./decision-table";
import {
  PrevSyncAdapter,
  PrevSyncMap,
  buildPrevSyncSnapshot,
  readPrevSync,
  writePrevSync,
} from "./prev-sync";
import {
  TombstoneEntry as ShardTombstoneEntry,
  TombstoneFileStation,
  readAllShards,
  updateOwnShard,
} from "./delete-log";

export type { ConflictStrategy };

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  /** Remote files deleted because the local copy was removed (propagates delete). */
  deletedRemote: string[];
  /** Local files deleted because a peer's tombstone said so. */
  deletedLocal: string[];
  /** Files re-created after an earlier delete (mtime gate positive on rows 8/10). */
  recreated: string[];
  /** Row 6: tombstone was stale; local preserved + tombstone purged. */
  preservedLocal: string[];
  conflicts: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface SyncEngineOptions {
  remotePath: string;
  conflictStrategy: ConflictStrategy;
  excludePatterns: string[];
  syncIdentityId: string;
  tombstoneJitterMs: number;
  honorTombstoneOnRecreate: boolean;
  remoteAbsenceGraceCycles: number;
  /** Skip files larger than this many megabytes (0 = no limit). Default 100. */
  maxFileSizeMb?: number;
}

/**
 * Runs `fn` over `items` with up to `concurrency` workers in flight.
 * Each worker pulls from a shared queue and processes items sequentially
 * within its own promise chain, so total parallelism is bounded.
 */
async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) return;
        await fn(item);
      }
    }),
  );
}

interface PlannedAction {
  path: string;
  action: Action;
  local: LocalEntry | undefined;
  remote: (RemoteEntry & { fullPath: string }) | undefined;
}

export class SyncEngine {
  private vault: Vault;
  private fs: FileStation;
  private adapter: PrevSyncAdapter;
  private remotePath: string;
  private conflictStrategy: ConflictStrategy;
  private excludePatterns: RegExp[];
  private syncIdentityId: string;
  private tombstoneJitterMs: number;
  private honorTombstoneOnRecreate: boolean;
  private remoteAbsenceGraceCycles: number;
  private maxFileSizeMb: number;
  /**
   * Per-sync cache of remote directory paths known to exist (full server
   * paths, e.g. `/volume1/vault/foo/bar`). Seeded from the remote listing at
   * the start of `sync()` and extended every time `ensureRemoteDir` creates
   * a folder. Avoids hundreds of redundant `createFolder` round trips when
   * uploading many files into existing directory trees.
   */
  private knownRemoteDirs = new Set<string>();

  constructor(vault: Vault, fs: FileStation, opts: SyncEngineOptions) {
    this.vault = vault;
    this.fs = fs;
    this.adapter = vault.adapter as unknown as PrevSyncAdapter;
    this.remotePath = opts.remotePath.replace(/\/+$/, "");
    this.conflictStrategy = opts.conflictStrategy;
    this.syncIdentityId = opts.syncIdentityId;
    this.tombstoneJitterMs = opts.tombstoneJitterMs;
    this.honorTombstoneOnRecreate = opts.honorTombstoneOnRecreate;
    this.remoteAbsenceGraceCycles = opts.remoteAbsenceGraceCycles;
    this.maxFileSizeMb = opts.maxFileSizeMb ?? 100;
    this.excludePatterns = [
      /^\.obsidian\/plugins\/synology-sync\//,
      /^\.trash\//,
      /^\.obsidian\/plugins\/text-extractor\/cache\//,
      /\/\.git\//,
      /^\.obsidian\/workspace-/,
      ...opts.excludePatterns.map((p) => new RegExp(p)),
    ];
  }

  private isExcluded(path: string): boolean {
    return this.excludePatterns.some((re) => re.test(path));
  }

  private async getLocalFiles(): Promise<Map<string, LocalEntry>> {
    const files = new Map<string, LocalEntry>();
    for (const file of this.vault.getFiles()) {
      if (!this.isExcluded(file.path)) {
        files.set(file.path, { mtime: file.stat.mtime, size: file.stat.size });
      }
    }
    return files;
  }

  private async getRemoteFiles(): Promise<Map<string, RemoteEntry & { fullPath: string }>> {
    const files = new Map<string, RemoteEntry & { fullPath: string }>();
    const remoteFiles = await this.fs.listAllFiles(this.remotePath);
    const prefixLen = this.remotePath.length + 1; // +1 for trailing /

    for (const f of remoteFiles) {
      const relativePath = f.path.substring(prefixLen);
      // Exclude the tombstones dir itself from the sync set
      if (relativePath.startsWith(".sync-tombstones/")) continue;
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
    // deleteOrphans is retained for backward compat with callers but is no
    // longer consulted during decisions — delete propagation is now driven by
    // history + tombstones. The flag historically covered the row-7 case;
    // that case is unconditionally honoured now (which is the fix).
    void deleteOrphans;

    // Record the sync start time. Any local file whose mtime is newer than
    // this was written by the user DURING the sync window and must not be
    // recorded as cleanly synced (unless the sync itself wrote that stat).
    const syncStartTs = Date.now();

    // Tracks stats of files actually written by this sync cycle.
    const syncedLocalStats = new Map<string, { mtime: number; size: number }>();

    const result: SyncResult = {
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

    // Reset per-sync state.  knownRemoteDirs is a per-sync directory cache so
    // upload bursts don't repeatedly hit createFolder for paths we've already
    // confirmed (or just created) on the NAS.
    this.knownRemoteDirs = new Set<string>();

    const local = await this.getLocalFiles();
    const remote = await this.getRemoteFiles();

    // Seed the directory cache from the existing remote listing.  Every
    // ancestor of every known remote file is, by definition, an existing
    // directory — no need to ask File Station to create it again.
    for (const rpath of remote.keys()) {
      const parts = rpath.split("/");
      let acc = this.remotePath;
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc + "/" + parts[i];
        this.knownRemoteDirs.add(acc);
      }
    }

    // Read per-device history (local JSON) and union of all tombstone shards (NAS).
    const history: PrevSyncMap = await readPrevSync(this.adapter);
    let tombstones: Map<string, DecisionTombstoneEntry>;
    try {
      tombstones = await readAllShards(
        this.fs as unknown as TombstoneFileStation,
        this.remotePath,
      );
    } catch (e) {
      debugLog(`[sync] readAllShards failed, proceeding with empty tombstones: ${(e as Error).message}`);
      tombstones = new Map();
    }

    const pendingShardWrites = new Map<string, ShardTombstoneEntry>();
    const pendingShardPurges = new Set<string>();

    // Paths whose outcome did NOT cleanly persist.  Their prior history
    // entries are preserved in the snapshot so the next sync fires the same
    // row again (e.g. Row 7 retry) instead of mis-diagnosing the path as
    // "never-seen-before" → Row 9 → resurrection.
    const erroredPaths = new Set<string>();

    const allPaths = new Set<string>([
      ...local.keys(),
      ...remote.keys(),
      ...history.keys(),
      ...tombstones.keys(),
    ]);

    // ---------------------------------------------------------------------
    // Pass 1 — Decision (sequential, no I/O)
    // ---------------------------------------------------------------------
    const planned: PlannedAction[] = [];
    for (const path of allPaths) {
      if (this.isExcluded(path)) continue;

      const l = local.get(path);
      const r = remote.get(path);
      const h = history.get(path);
      const t = tombstones.get(path);

      const cfg: DecideConfig = {
        conflictStrategy: this.conflictStrategy,
        tombstoneJitterMs: this.tombstoneJitterMs,
        honorTombstoneOnRecreate: this.honorTombstoneOnRecreate,
        remoteAbsenceGraceCycles: this.remoteAbsenceGraceCycles,
        remoteAbsenceCount: h?.missingCount ?? 0,
      };

      const action = decideAction(
        l as LocalEntry | undefined,
        r as RemoteEntry | undefined,
        h as HistoryEntry | undefined,
        t as DecisionTombstoneEntry | undefined,
        cfg,
      );

      planned.push({ path, action, local: l, remote: r });
    }

    // ---------------------------------------------------------------------
    // Pass 2 — Execution (concurrent within independent buckets)
    // ---------------------------------------------------------------------
    const uploads: PlannedAction[] = [];
    const downloads: PlannedAction[] = [];
    const deletes: PlannedAction[] = [];
    const others: PlannedAction[] = [];

    for (const p of planned) {
      switch (p.action.kind) {
        case "upload":
          uploads.push(p);
          break;
        case "download":
        case "recreate-after-delete":
          downloads.push(p);
          break;
        case "delete-local":
        case "delete-remote":
        case "delete-remote-stale-tombstone":
          deletes.push(p);
          break;
        default:
          others.push(p);
      }
    }

    const runOne = async (p: PlannedAction): Promise<void> => {
      try {
        await this.applyAction(
          p.action,
          p.path,
          p.local,
          p.remote,
          pendingShardWrites,
          pendingShardPurges,
          result,
          syncedLocalStats,
        );
      } catch (e) {
        const errMsg = (e as Error).message;
        // Array.push and Set.add are synchronous and safe to call from
        // multiple concurrent async workers — the JS event loop never
        // interleaves the actual mutation.
        result.errors.push({ path: p.path, error: errMsg });
        erroredPaths.add(p.path);
        debugLog(`SYNC ERROR: ${p.path} - ${errMsg} (action=${p.action.kind})`);
      }
    };

    const CONCURRENCY = 5;
    await runConcurrent(uploads, runOne, CONCURRENCY);
    await runConcurrent(downloads, runOne, CONCURRENCY);
    await runConcurrent(deletes, runOne, CONCURRENCY);
    // "others" includes conflict-resolve, history-cleanup variants, noop, and
    // keep-local-purge-tombstone. They mutate per-path state and may upload
    // (keep-local-purge-tombstone) — keep them sequential to preserve the
    // simple ordering invariants that already exist around them.
    for (const p of others) {
      await runOne(p);
    }

    // Persist own shard iff anything changed.  If the upload itself fails,
    // every path with pending writes/purges must be treated as errored so
    // its history entry is preserved for next-cycle retry.
    let shardWriteFailed = false;
    if (pendingShardWrites.size > 0 || pendingShardPurges.size > 0) {
      try {
        await updateOwnShard(
          this.fs as unknown as TombstoneFileStation,
          this.remotePath,
          this.syncIdentityId,
          pendingShardWrites,
          pendingShardPurges,
        );
      } catch (e) {
        shardWriteFailed = true;
        result.errors.push({ path: "<shard>", error: (e as Error).message });
        debugLog(`SYNC ERROR shard-write: ${(e as Error).message}`);
        for (const p of pendingShardWrites.keys()) erroredPaths.add(p);
        for (const p of pendingShardPurges) erroredPaths.add(p);
      }
    }
    void shardWriteFailed;

    // Persist prev-sync history snapshot (post-sync view of local).
    //   - For paths present in freshLocal: record fresh stats.  If the path
    //     was absent remotely at sync-start, carry / increment missingCount
    //     (Row 3 staleness gate); otherwise reset to 0.
    //   - For errored paths that were in prior history but are no longer
    //     in freshLocal: preserve the prior entry unchanged.  This is the
    //     core fix for Opus showstoppers #1 and #2.
    try {
      const freshLocal = await this.getLocalFiles();
      const preSyncRemote = new Set(remote.keys());
      const snapshot = buildPrevSyncSnapshot({
        freshLocal,
        preSyncRemote,
        priorHistory: history,
        erroredPaths,
        now: Date.now(),
        syncStartTs,
        syncedLocalStats,
      });
      await writePrevSync(this.adapter, snapshot);
    } catch (e) {
      result.errors.push({ path: "<prev-sync>", error: (e as Error).message });
      debugLog(`SYNC ERROR prev-sync-write: ${(e as Error).message}`);
    }

    // Maintain the legacy `deleted` field for any callers / UI that still read it.
    result.deleted = [...result.deletedRemote, ...result.deletedLocal];

    return result;
  }

  // ---------------------------------------------------------------------
  // Action dispatch
  // ---------------------------------------------------------------------
  private async applyAction(
    action: Action,
    path: string,
    local: LocalEntry | undefined,
    remote: (RemoteEntry & { fullPath: string }) | undefined,
    pendingShardWrites: Map<string, ShardTombstoneEntry>,
    pendingShardPurges: Set<string>,
    result: SyncResult,
    syncedLocalStats: Map<string, { mtime: number; size: number }>,
  ): Promise<void> {
    switch (action.kind) {
      case "upload":
        if (await this.uploadFile(path, result)) {
          this.recordLocalStat(path, syncedLocalStats);
          result.uploaded.push(path);
        }
        return;

      case "download":
        if (!remote) return;
        if (await this.downloadFile(path, remote.fullPath, local, remote, this.conflictStrategy, result)) {
          this.recordLocalStat(path, syncedLocalStats);
          result.downloaded.push(path);
        }
        return;

      case "delete-local":
        await this.deleteLocalFile(path);
        result.deletedLocal.push(path);
        return;

      case "delete-remote": {
        // Row 7: we deleted locally; propagate delete and record our own tombstone.
        // The pendingShardWrites.set MUST be inside the `if (remote)` branch
        // and gated on the delete actually succeeding — if `fs.delete` throws,
        // we propagate the error to the caller (and skip the tombstone) so the
        // path stays in `erroredPaths`. If `remote` is undefined the file is
        // already gone on the NAS; nothing to tombstone.
        if (remote) {
          await this.fs.delete(remote.fullPath);
          result.deletedRemote.push(path);
          pendingShardWrites.set(path, { deleted_at: Date.now() });
        }
        return;
      }

      case "delete-remote-stale-tombstone":
        if (remote) {
          await this.fs.delete(remote.fullPath);
          result.deletedRemote.push(path);
        }
        return;

      case "recreate-after-delete":
        // Rows 8 & 10 positive mtime gate: remote (or local) is newer than the
        // tombstone → treat as a legitimate recreate. Keep remote, clear entry.
        if (remote) {
          if (await this.downloadFile(path, remote.fullPath, local, remote, this.conflictStrategy, result)) {
            this.recordLocalStat(path, syncedLocalStats);
            result.downloaded.push(path);
          }
        }
        pendingShardPurges.add(path);
        result.recreated.push(path);
        return;

      case "keep-local-purge-tombstone":
        if (await this.uploadFile(path, result)) {
          this.recordLocalStat(path, syncedLocalStats);
          result.uploaded.push(path);
        }
        pendingShardPurges.add(path);
        result.preservedLocal.push(path);
        return;

      case "conflict-resolve":
        await this.conflictResolve(path, local, remote, action.strategy, result, syncedLocalStats);
        if (action.purgeTombstone) pendingShardPurges.add(path);
        return;

      case "history-cleanup":
      case "history-cleanup-keep-tombstone":
        // History cleanup is implicit: we rebuild the snapshot from the fresh
        // local scan at the end of sync; orphan paths disappear naturally.
        return;

      case "noop":
        return;
    }
  }

  /**
   * After a successful upload or download, capture the file's post-write stat
   * so the prev-sync snapshot can distinguish "sync wrote this" from "user
   * wrote this during the sync window".
   */
  private recordLocalStat(
    path: string,
    syncedLocalStats: Map<string, { mtime: number; size: number }>,
  ): void {
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      syncedLocalStats.set(path, { mtime: file.stat.mtime, size: file.stat.size });
    }
  }

  private async conflictResolve(
    path: string,
    local: LocalEntry | undefined,
    remote: (RemoteEntry & { fullPath: string }) | undefined,
    strategy: ConflictStrategy,
    result: SyncResult,
    syncedLocalStats: Map<string, { mtime: number; size: number }>,
  ): Promise<void> {
    if (!local || !remote) return; // defensive — conflict requires both

    // Preserve existing close-mtime same-size short-circuit.
    const timeDiff = Math.abs(local.mtime - remote.mtime);
    if (timeDiff < 2000 && local.size === remote.size) {
      return;
    }

    switch (strategy) {
      case "newer-wins":
        if (local.mtime > remote.mtime) {
          if (await this.uploadFile(path, result)) {
            this.recordLocalStat(path, syncedLocalStats);
            result.uploaded.push(path);
          }
        } else if (remote.mtime > local.mtime) {
          if (await this.downloadFile(path, remote.fullPath, local, remote, strategy, result)) {
            this.recordLocalStat(path, syncedLocalStats);
            result.downloaded.push(path);
          }
        }
        return;
      case "local-wins":
        if (await this.uploadFile(path, result)) {
          this.recordLocalStat(path, syncedLocalStats);
          result.uploaded.push(path);
        }
        return;
      case "remote-wins":
        if (await this.downloadFile(path, remote.fullPath, local, remote, strategy, result)) {
          this.recordLocalStat(path, syncedLocalStats);
          result.downloaded.push(path);
        }
        return;
      case "skip":
        result.conflicts.push(path);
        return;
    }
  }

  private async deleteLocalFile(relativePath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(relativePath);
    if (!file) {
      // File already gone — nothing to do.
      return;
    }
    if (file instanceof TFile) {
      // Send to system trash so the user can recover if needed.
      await this.vault.trash(file, true);
      return;
    }
    // Folders are not sync-tracked as entries; skip.
  }

  /**
   * Walks each segment of `relDir` (a vault-relative dir path), creating any
   * segments that aren't already in `knownRemoteDirs`. Each newly-created
   * segment is added to the cache so subsequent uploads skip the round trip.
   */
  private async ensureRemoteDir(relDir: string): Promise<void> {
    const parts = relDir.split("/").filter(Boolean);
    let acc = this.remotePath;
    for (const part of parts) {
      const parent = acc;
      acc = acc + "/" + part;
      if (this.knownRemoteDirs.has(acc)) continue;
      try {
        await this.fs.createFolder(parent, part);
      } catch {
        // createFolder already swallows "already exists" — any other error
        // here will surface on the upload itself with a clearer message.
      }
      this.knownRemoteDirs.add(acc);
    }
  }

  private async uploadFile(
    relativePath: string,
    result: SyncResult,
  ): Promise<boolean> {
    const file = this.vault.getAbstractFileByPath(relativePath);
    if (!(file instanceof TFile)) return false;

    // Mobile devices can OOM when reading multi-hundred-MB files into an
    // ArrayBuffer. The setting `maxFileSizeMb` (default 100) skips them with
    // a clear error so the rest of the sync still completes.
    const maxBytes = (this.maxFileSizeMb ?? 100) * 1024 * 1024;
    if (maxBytes > 0 && file.stat.size > maxBytes) {
      const mb = Math.round(file.stat.size / 1024 / 1024);
      const limit = this.maxFileSizeMb ?? 100;
      result.errors.push({
        path: relativePath,
        error: `skipped: file too large (${mb}MB > ${limit}MB limit)`,
      });
      return false;
    }

    const content = await this.vault.readBinary(file);
    const parts = relativePath.split("/");
    const fileName = parts.pop()!;
    const remoteDir = parts.length > 0
      ? `${this.remotePath}/${parts.join("/")}`
      : this.remotePath;

    // Ensure remote directory exists (cached per-sync; only round trips for
    // dirs we haven't already seen or just created).
    if (parts.length > 0) {
      await this.ensureRemoteDir(parts.join("/"));
    }

    await this.fs.upload(remoteDir, fileName, content, true, file.stat.mtime);
    return true;
  }

  /**
   * Downloads `remoteFullPath` and writes it to `relativePath`.
   *
   * Returns `true` when the local file was overwritten, `false` when the
   * download was skipped because the user modified the local file between
   * the initial scan and now (mid-sync write protection).
   *
   * The pre-write re-check compares the live local mtime against `local.mtime`
   * (captured at the start of this sync cycle).  When the local mtime has
   * advanced, the conflict strategy decides:
   *   - local-wins  → always skip (user's edit beats the remote copy);
   *   - newer-wins  → skip iff fresh local mtime > remote mtime;
   *   - remote-wins → never skip; remote always overwrites.
   *
   * Skipped paths land in `result.conflicts` instead of `result.downloaded`.
   *
   * Note: Adapter.rename has a confirmed bug — it throws "Destination file
   * already exists!" whenever the destination exists — so we cannot use a
   * tmp-then-rename atomic-write workaround here.  A small TOCTOU window
   * between the live-mtime read and the modifyBinary call remains; closing
   * it would require an Obsidian API change (or a vault event listener,
   * which is explicitly deferred).
   */
  private async downloadFile(
    relativePath: string,
    remoteFullPath: string,
    local: LocalEntry | undefined,
    remote: RemoteEntry | undefined,
    conflictStrategy: ConflictStrategy,
    result: SyncResult,
  ): Promise<boolean> {
    // Check live local mtime against the initial-scan mtime BEFORE we touch
    // the network — if the user edited the file mid-sync, we may skip
    // entirely and avoid wasted bandwidth.
    const existingPre = this.vault.getAbstractFileByPath(relativePath);
    if (existingPre instanceof TFile && local !== undefined) {
      const liveMtime = existingPre.stat.mtime;
      if (liveMtime > local.mtime) {
        const skip =
          conflictStrategy === "local-wins" ||
          (conflictStrategy === "newer-wins" &&
            (remote === undefined || liveMtime > remote.mtime));
        if (skip) {
          debugLog(`[sync] mid-sync write detected for ${relativePath}; skipping download (strategy=${conflictStrategy}).`);
          result.conflicts.push(relativePath);
          return false;
        }
      }
    }

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
      // Use adapter.writeBinary for files outside the vault index (e.g. .obsidian/ configs)
      await this.vault.adapter.writeBinary(relativePath, content);
    }
    return true;
  }
}
