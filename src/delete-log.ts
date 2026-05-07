// delete-log.ts — per-device tombstone shard module
// Each device writes ONLY its own shard under <remotePath>/.sync-tombstones/<syncIdentityId>.json
// At sync time all shards are read and unioned; latest deleted_at wins on conflict.

export interface TombstoneFileStation {
  listAllFiles(dir: string): Promise<Array<{ path: string; name?: string }>>;
  download(fullPath: string): Promise<ArrayBuffer>;
  /**
   * NOTE: `createParents` matches FileStation.upload's 4th parameter — the
   * underlying File Station API always overwrites existing files, so there
   * is no separate overwrite flag.  Pass `true` to ensure the tombstones
   * directory is created on first use.
   */
  upload(
    remoteDir: string,
    fileName: string,
    data: ArrayBuffer,
    createParents: boolean,
    mtime?: number,
  ): Promise<void>;
  delete(fullPath: string): Promise<void>;
  createFolder(parentDir: string, name: string): Promise<void>;
}

export interface TombstoneEntry {
  deleted_at: number;
}

export type TombstoneMap = Map<string, TombstoneEntry>;

export interface ShardDoc {
  version: 1;
  syncIdentityId: string;
  tombstones: Record<string, TombstoneEntry>;
  last_updated: number;
}

export const TOMBSTONES_DIR_NAME = ".sync-tombstones";

// Shared marker file that suppresses tombstones across all devices.
// Written when a device keeps a file via keep-local-purge-tombstone (Row 6),
// so peer devices stop honoring the stale per-device shard tombstones.
export const CLEARED_MARKER_NAME = "_cleared.json";

export interface ClearEntry {
  cleared_at: number;
}

export interface ClearedDoc {
  version: 1;
  clears: Record<string, ClearEntry>;
  last_updated: number;
}

/**
 * Returns `${remotePath}/.sync-tombstones/${syncIdentityId}.json`,
 * normalising away any trailing slash on remotePath.
 */
export function shardPath(remotePath: string, syncIdentityId: string): string {
  const base = remotePath.replace(/\/+$/, "");
  return `${base}/${TOMBSTONES_DIR_NAME}/${syncIdentityId}.json`;
}

/**
 * Pure merge: given an array of ShardDocs, return a TombstoneMap where each
 * path keeps the entry with the greatest deleted_at value.
 */
export function mergeShards(docs: ShardDoc[]): TombstoneMap {
  const result: TombstoneMap = new Map();
  for (const doc of docs) {
    for (const [filePath, entry] of Object.entries(doc.tombstones)) {
      const existing = result.get(filePath);
      if (!existing || entry.deleted_at > existing.deleted_at) {
        result.set(filePath, { deleted_at: entry.deleted_at });
      }
    }
  }
  return result;
}

/**
 * Reads and merges all *.json files under <remotePath>/.sync-tombstones/.
 * - Missing dir (listAllFiles throws or returns empty) → empty Map, no throw.
 * - Corrupt shard → skip that shard, console.warn, continue others.
 * - Non-JSON files are ignored.
 * - Union rule: for each path, keep the entry with the latest deleted_at.
 */
export async function readAllShards(
  fs: TombstoneFileStation,
  remotePath: string,
): Promise<TombstoneMap> {
  const base = remotePath.replace(/\/+$/, "");
  const tombstonesDir = `${base}/${TOMBSTONES_DIR_NAME}`;

  let files: Array<{ path: string; name?: string }>;
  try {
    files = await fs.listAllFiles(tombstonesDir);
  } catch {
    // Directory missing or any list error → treat as no tombstones
    return new Map();
  }

  if (!files || files.length === 0) {
    return new Map();
  }

  const docs: ShardDoc[] = [];
  let clearedDoc: ClearedDoc | null = null;

  // Filter to .json files first, then download in parallel.
  // Sequential per-shard awaits add ~30ms × N latency on every sync; with a
  // dozen devices that's nearly half a second of wall time before any
  // decision can be made. Promise.allSettled keeps the "skip-corrupt-shard"
  // resilience while parallelising the network round trips.
  const jsonFiles = files.filter((f) => {
    const name = f.name ?? f.path.split("/").pop() ?? "";
    return name.endsWith(".json");
  });

  const settled = await Promise.allSettled(
    jsonFiles.map((file) => fs.download(file.path)),
  );

  for (let i = 0; i < settled.length; i++) {
    const file = jsonFiles[i];
    const name = file.name ?? file.path.split("/").pop() ?? "";
    const r = settled[i];

    if (r.status === "rejected") {
      console.warn(
        `[delete-log] Failed to download shard ${file.path}, skipping:`,
        (r as PromiseRejectedResult).reason,
      );
      continue;
    }

    const buf = (r as PromiseFulfilledResult<ArrayBuffer>).value;

    let doc: unknown;
    try {
      const text = new TextDecoder().decode(buf);
      doc = JSON.parse(text);
    } catch (err) {
      console.warn(
        `[delete-log] Corrupt shard (parse error) ${file.path}, skipping:`,
        err,
      );
      continue;
    }

    if (name === CLEARED_MARKER_NAME) {
      if (isClearedDoc(doc)) {
        clearedDoc = doc;
      } else {
        console.warn(`[delete-log] Corrupt cleared marker ${file.path}, skipping.`);
      }
      continue;
    }

    if (!isShardDoc(doc)) {
      console.warn(
        `[delete-log] Corrupt shard (invalid shape) ${file.path}, skipping.`,
      );
      continue;
    }

    docs.push(doc);
  }

  const merged = mergeShards(docs);

  // Apply the cleared marker: suppress any tombstone whose deleted_at is
  // older than or equal to the clear timestamp recorded for that path.
  // A newer tombstone (deleted_at > cleared_at) still wins — it represents
  // a subsequent deletion on another device.
  if (clearedDoc) {
    for (const [path, clearEntry] of Object.entries(clearedDoc.clears)) {
      const tombstone = merged.get(path);
      if (tombstone && tombstone.deleted_at <= clearEntry.cleared_at) {
        merged.delete(path);
      }
    }
  }

  return merged;
}

/**
 * Writes this device's own shard.
 * - Loads this device's prior shard first (if any), applies writes + purges, then uploads.
 * - Creates the .sync-tombstones/ dir if needed (swallows "already exists" errors).
 * - Never touches other devices' shards.
 * - Always uploads with overwrite=true (shard-per-device has no contention).
 *
 * @param writes  Paths to add/update with their deleted_at timestamp.
 * @param purges  Paths to remove from this device's shard (e.g. after recreate-after-delete).
 */
export async function updateOwnShard(
  fs: TombstoneFileStation,
  remotePath: string,
  syncIdentityId: string,
  writes: Map<string, TombstoneEntry>,
  purges: Set<string>,
): Promise<void> {
  const base = remotePath.replace(/\/+$/, "");
  const tombstonesDir = `${base}/${TOMBSTONES_DIR_NAME}`;
  const fileName = `${syncIdentityId}.json`;
  const fullPath = `${tombstonesDir}/${fileName}`;

  // Ensure the directory exists (best-effort; swallow "already exists" errors)
  try {
    await fs.createFolder(base, TOMBSTONES_DIR_NAME);
  } catch {
    // Ignore — likely already exists
  }

  // Load this device's prior shard if available
  const prior: Record<string, TombstoneEntry> = {};
  try {
    const buf = await fs.download(fullPath);
    const text = new TextDecoder().decode(buf);
    const parsed: unknown = JSON.parse(text);
    if (isShardDoc(parsed)) {
      Object.assign(prior, parsed.tombstones);
    }
  } catch {
    // No prior shard or parse failure — start fresh
  }

  // Apply purges first, then writes
  for (const p of purges) {
    delete prior[p];
  }
  for (const [filePath, entry] of writes) {
    prior[filePath] = { deleted_at: entry.deleted_at };
  }

  const now = Date.now();
  const doc: ShardDoc = {
    version: 1,
    syncIdentityId,
    tombstones: prior,
    last_updated: now,
  };

  const encoded = new TextEncoder().encode(JSON.stringify(doc)).buffer;

  // Write the shared cleared marker BEFORE the own shard.
  // If the marker write fails, peers still see un-cleared tombstones and may
  // ghost-delete kept files. If the shard write fails after the marker, that
  // is safer: the shard simply retries next sync, but cleared intent is
  // already advertised, so peers stop honoring stale tombstones.
  if (purges.size > 0) {
    await writeClearedMarker(fs, tombstonesDir, purges, now);
  }

  await fs.upload(tombstonesDir, fileName, encoded, true);
}

/**
 * Reads the existing _cleared.json (if any), merges in the new purge set,
 * and writes the updated marker back to the NAS.
 */
async function writeClearedMarker(
  fs: TombstoneFileStation,
  tombstonesDir: string,
  purges: Set<string>,
  now: number,
): Promise<void> {
  const markerPath = `${tombstonesDir}/${CLEARED_MARKER_NAME}`;

  // Load existing marker
  const existingClears: Record<string, ClearEntry> = {};
  try {
    const buf = await fs.download(markerPath);
    const text = new TextDecoder().decode(buf);
    const parsed: unknown = JSON.parse(text);
    if (isClearedDoc(parsed)) {
      Object.assign(existingClears, parsed.clears);
    }
  } catch {
    // No existing marker or parse failure — start fresh
  }

  // Merge purges: update cleared_at to now for each purged path
  for (const path of purges) {
    existingClears[path] = { cleared_at: now };
  }

  const marker: ClearedDoc = {
    version: 1,
    clears: existingClears,
    last_updated: now,
  };

  const encoded = new TextEncoder().encode(JSON.stringify(marker)).buffer;
  await fs.upload(tombstonesDir, CLEARED_MARKER_NAME, encoded, true);
}

// ---------------------------------------------------------------------------
// Internal type guards
// ---------------------------------------------------------------------------

function isClearedDoc(val: unknown): val is ClearedDoc {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  if (obj["version"] !== 1) return false;
  if (typeof obj["last_updated"] !== "number") return false;
  if (typeof obj["clears"] !== "object" || obj["clears"] === null) return false;
  const clears = obj["clears"] as Record<string, unknown>;
  for (const entry of Object.values(clears)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>)["cleared_at"] !== "number"
    ) {
      return false;
    }
  }
  return true;
}

function isShardDoc(val: unknown): val is ShardDoc {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  if (obj["version"] !== 1) return false;
  if (typeof obj["syncIdentityId"] !== "string") return false;
  if (typeof obj["last_updated"] !== "number") return false;
  if (typeof obj["tombstones"] !== "object" || obj["tombstones"] === null)
    return false;
  // Validate each tombstone entry
  const tombstones = obj["tombstones"] as Record<string, unknown>;
  for (const entry of Object.values(tombstones)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>)["deleted_at"] !== "number"
    ) {
      return false;
    }
  }
  return true;
}
