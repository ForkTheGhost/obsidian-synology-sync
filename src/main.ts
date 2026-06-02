import { Plugin, Notice, Modal, App, TFile } from "obsidian";
import { FileStation, FileStationConfig, LoginResult } from "./filestation";
import { compareQuickConnectCandidates, resolveQuickConnect, resolveQuickConnectCandidates, probeQuickConnectCandidates, QCCandidate } from "./quickconnect";
import { SyncEngine, SyncResult } from "./sync";
import { MobileGitFileStationSyncEngine } from "./git-filestation-mobile";
import { CachedQuickConnectCandidate, SynologySyncSettings, SynologySyncSettingTab, DEFAULT_SETTINGS, LATEST_SYNC_LOG_NOTE_PATH, SYNC_LOG_HISTORY_FOLDER, SYNC_LOG_HISTORY_RETENTION, migrateLoadedSettings, sanitizeSyncBackendForRuntime } from "./settings";
import { beginDebugSync, debugBreadcrumb, debugLog, endDebugSync, formatErrorForDebug, getDebugLog, getRuntimeInstanceId, logRuntimeDiagnostics, redactSensitiveLogText, setDebugBreadcrumbsEnabled } from "./debug";
import { FileStationGitLeaseHeldError, clearFileStationGitLease } from "./git-filestation-lease";

interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

const DSM_PASSWORD_SECRET_ID = "synology-sync-dsm-password";
const DSM_DEVICE_ID_SECRET_ID = "synology-sync-dsm-device-id";
const DSM_DEVICE_TOKEN_SECRET_ID = "synology-sync-dsm-device-token";

function syncLogHistoryPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${SYNC_LOG_HISTORY_FOLDER}/sync-${stamp}.md`;
}

// UUID generator with fallbacks for older runtimes.
// crypto.randomUUID requires iOS 15.4+ / Chromium 92+; we fall back through
// crypto.getRandomValues (broad support) to a non-crypto timestamp+Math.random
// combo (last-resort; still unique enough for a per-install shard name).
function generateSyncIdentityId(): string {
  const c: Crypto | undefined =
    typeof crypto !== "undefined" ? (crypto as Crypto) : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return (
      hex.slice(0, 8) + "-" +
      hex.slice(8, 12) + "-" +
      hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" +
      hex.slice(20, 32)
    );
  }
  const t = Date.now().toString(16);
  const r = () => Math.random().toString(16).slice(2, 10);
  return `${t}-${r()}-${r()}-${r()}`;
}


export function sameQuickConnectCandidate(a: QCCandidate, b: QCCandidate): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.https === b.https && a.kind === b.kind;
}

export function moveCandidateToFront(candidates: QCCandidate[], selected: QCCandidate): QCCandidate[] {
  const rest = candidates.filter((candidate) => !sameQuickConnectCandidate(candidate, selected));
  return [selected, ...rest];
}

const QUICKCONNECT_CANDIDATE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const QUICKCONNECT_CANDIDATE_CACHE_LIMIT = 5;

function candidateUrl(candidate: QCCandidate): string {
  return `${candidate.https ? "https" : "http"}://${candidate.host}:${candidate.port}`;
}

function normalizedQuickConnectId(id: string): string {
  return id.trim().toLowerCase();
}

export function prioritizeCachedQuickConnectCandidates(
  discovered: QCCandidate[],
  cached: CachedQuickConnectCandidate[],
  quickConnectId: string,
  now = Date.now(),
): QCCandidate[] {
  const normalizedId = normalizedQuickConnectId(quickConnectId);
  const fresh = freshCachedQuickConnectCandidates(cached, normalizedId, now);

  const out: QCCandidate[] = [];
  // Cache is a memory hint, not a transport policy. Keep rediscovered LAN/direct
  // candidates ahead of stale-but-successful relay entries, then use recency only
  // inside the same candidate class. This preserves the speed benefit without
  // making an old relay win on local Wi-Fi.
  for (const candidate of [...discovered, ...fresh]) {
    const discoveredMatch = discovered.find((existing) => sameQuickConnectCandidate(existing, candidate));
    const enriched = { ...candidate, source: candidate.source ?? discoveredMatch?.source };
    if (!out.some((existing) => sameQuickConnectCandidate(existing, enriched))) out.push(enriched);
  }
  return out
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => compareQuickConnectCandidates(a.candidate, b.candidate) || a.index - b.index)
    .map((entry) => entry.candidate);
}

export function freshCachedQuickConnectCandidates(
  cached: CachedQuickConnectCandidate[],
  quickConnectId: string,
  now = Date.now(),
): QCCandidate[] {
  const normalizedId = normalizedQuickConnectId(quickConnectId);
  return cached
    .filter((entry) => normalizedQuickConnectId(entry.quickConnectId) === normalizedId)
    .filter((entry) => now - entry.lastSuccessAt <= QUICKCONNECT_CANDIDATE_CACHE_TTL_MS)
    .sort((a, b) => {
      if (b.lastSuccessAt !== a.lastSuccessAt) return b.lastSuccessAt - a.lastSuccessAt;
      return b.successCount - a.successCount;
    })
    .map((entry) => entry.candidate);
}

export function quickConnectCandidatesAfterResolution(
  discovered: QCCandidate[] | null,
  cached: CachedQuickConnectCandidate[],
  quickConnectId: string,
  now = Date.now(),
): QCCandidate[] {
  if (discovered) {
    return prioritizeCachedQuickConnectCandidates(discovered, cached, quickConnectId, now);
  }
  return freshCachedQuickConnectCandidates(cached, quickConnectId, now);
}

export default class SynologySync extends Plugin {
  settings: SynologySyncSettings = DEFAULT_SETTINGS;
  private autoSyncInterval: number | null = null;
  private syncing = false;

  async onload() {
    await this.loadSettings();
    logRuntimeDiagnostics(this.app);
    this.addSettingTab(new SynologySyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Synology Sync", async () => {
      await this.runSync();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync with Synology NAS",
      callback: async () => {
        await this.runSync();
      },
    });

    this.addCommand({
      id: "sync-push",
      name: "Push all local changes to NAS",
      callback: async () => {
        await this.runSync("local-wins");
      },
    });

    this.addCommand({
      id: "sync-pull",
      name: "Pull all changes from NAS",
      callback: async () => {
        await this.runSync("remote-wins");
      },
    });

    this.setupAutoSync();

    const hasStartupTarget = !!this.settings.remotePath || !!this.settings.gitFileStationRepoPath;
    if (this.settings.syncOnStartup && hasStartupTarget) {
      // Use onLayoutReady instead of a fixed 5s timeout so we sync as soon as
      // the workspace is ready (typically <1s) rather than always waiting 5s.
      // It also avoids racing with vault index population on slow startups.
      this.app.workspace.onLayoutReady(() => {
        this.runSync();
      });
    }
  }

  onunload() {
    if (this.autoSyncInterval !== null) {
      window.clearInterval(this.autoSyncInterval);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (migrateLoadedSettings(this.settings)) {
      await this.saveSettings();
    }
    setDebugBreadcrumbsEnabled(this.settings.debugLogEnabled);
    await this.migrateLegacySecretsToStorage();
    if (!this.settings.syncIdentityId) {
      this.settings.syncIdentityId = generateSyncIdentityId();
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private getSecretStorage(): SecretStorageLike | null {
    const app = this.app as App & { secretStorage?: unknown };
    const storage = app?.secretStorage;
    if (
      storage &&
      typeof (storage as SecretStorageLike).getSecret === "function" &&
      typeof (storage as SecretStorageLike).setSecret === "function"
    ) {
      return storage as SecretStorageLike;
    }
    return null;
  }

  hasSecretStorageSupport(): boolean {
    return this.getSecretStorage() !== null;
  }

  private getStoredSecret(secretId: string, fallback: string): string {
    const storage = this.getSecretStorage();
    if (!storage) return fallback;
    const secret = storage.getSecret(secretId);
    return secret !== null ? secret : fallback;
  }

  getDsmPassword(): string {
    return this.getStoredSecret(DSM_PASSWORD_SECRET_ID, this.settings.password);
  }

  getDsmDeviceId(): string {
    return this.getStoredSecret(DSM_DEVICE_ID_SECRET_ID, this.settings.deviceId);
  }

  getDsmDeviceToken(): string {
    return this.getStoredSecret(DSM_DEVICE_TOKEN_SECRET_ID, this.settings.deviceToken);
  }

  hasDsmDeviceTrust(): boolean {
    return !!this.getDsmDeviceToken();
  }

  async setDsmPassword(password: string): Promise<void> {
    const storage = this.getSecretStorage();
    if (!storage) {
      this.settings.password = password;
      await this.saveSettings();
      return;
    }

    storage.setSecret(DSM_PASSWORD_SECRET_ID, password);
    if (this.settings.password) {
      this.settings.password = "";
      await this.saveSettings();
    }
  }

  private async setDsmDeviceTrust(deviceId: string, deviceToken: string): Promise<void> {
    const storage = this.getSecretStorage();
    if (!storage) {
      this.settings.deviceId = deviceId;
      this.settings.deviceToken = deviceToken;
      await this.saveSettings();
      return;
    }

    storage.setSecret(DSM_DEVICE_ID_SECRET_ID, deviceId);
    storage.setSecret(DSM_DEVICE_TOKEN_SECRET_ID, deviceToken);
    if (this.settings.deviceId || this.settings.deviceToken) {
      this.settings.deviceId = "";
      this.settings.deviceToken = "";
      await this.saveSettings();
    }
  }

  async clearDsmDeviceTrust(): Promise<void> {
    const storage = this.getSecretStorage();
    if (!storage) {
      this.settings.deviceId = "";
      this.settings.deviceToken = "";
      await this.saveSettings();
      return;
    }

    storage.setSecret(DSM_DEVICE_ID_SECRET_ID, "");
    storage.setSecret(DSM_DEVICE_TOKEN_SECRET_ID, "");
    if (this.settings.deviceId || this.settings.deviceToken) {
      this.settings.deviceId = "";
      this.settings.deviceToken = "";
      await this.saveSettings();
    }
  }

  private async migrateLegacySecretsToStorage(): Promise<void> {
    const storage = this.getSecretStorage();
    if (!storage) return;

    let changed = false;
    if (this.settings.password) {
      storage.setSecret(DSM_PASSWORD_SECRET_ID, this.settings.password);
      this.settings.password = "";
      changed = true;
    }
    if (this.settings.deviceId) {
      storage.setSecret(DSM_DEVICE_ID_SECRET_ID, this.settings.deviceId);
      this.settings.deviceId = "";
      changed = true;
    }
    if (this.settings.deviceToken) {
      storage.setSecret(DSM_DEVICE_TOKEN_SECRET_ID, this.settings.deviceToken);
      this.settings.deviceToken = "";
      changed = true;
    }
    if (changed) await this.saveSettings();
  }

  setupAutoSync() {
    if (this.autoSyncInterval !== null) {
      window.clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }

    if (this.settings.syncInterval > 0) {
      const ms = this.settings.syncInterval * 60 * 1000;
      this.autoSyncInterval = this.registerInterval(
        window.setInterval(() => this.runSync(), ms)
      );
    }
  }


  private configFromQuickConnectCandidate(candidate: QCCandidate, otpCode?: string): FileStationConfig {
    const baseUrl = `${candidate.https ? "https" : "http"}://${candidate.host}:${candidate.port}`;
    return {
      baseUrl,
      username: this.settings.username,
      password: this.getDsmPassword(),
      deviceId: this.getDsmDeviceId() || undefined,
      deviceToken: this.getDsmDeviceToken() || undefined,
      otpCode,
      quickConnectRelay: candidate.kind === "portal",
    };
  }

  async buildConfig(otpCode?: string): Promise<FileStationConfig> {
    let baseUrl: string;
    let quickConnectRelay = false;

    if (this.settings.connectionType === "quickconnect") {
      if (!this.settings.quickConnectId) throw new Error("QuickConnect ID not configured");
      const resolved = await resolveQuickConnect(this.settings.quickConnectId);
      baseUrl = `${resolved.https ? "https" : "http"}://${resolved.host}:${resolved.port}`;
      quickConnectRelay = !!resolved.relay;
      debugLog(`QC: selected ${resolved.relay ? "relay" : "direct"} endpoint`);
    } else {
      const proto = this.settings.https ? "https" : "http";
      baseUrl = `${proto}://${this.settings.host}:${this.settings.port}`;
    }

    return {
      baseUrl,
      username: this.settings.username,
      password: this.getDsmPassword(),
      deviceId: this.getDsmDeviceId() || undefined,
      deviceToken: this.getDsmDeviceToken() || undefined,
      otpCode,
      quickConnectRelay,
    };
  }


  private async prioritizedQuickConnectCandidates(quickConnectId: string): Promise<QCCandidate[]> {
    const cached = this.settings.quickConnectCandidateCache || [];
    const freshCachedCandidates = freshCachedQuickConnectCandidates(cached, quickConnectId);
    if (freshCachedCandidates.length > 0) {
      debugLog(`QC: found ${freshCachedCandidates.length} fresh cached working candidate(s); merging with rediscovered candidates by source priority`);
    }
    let discoveredCandidates: QCCandidate[] | null = null;
    try {
      discoveredCandidates = await resolveQuickConnectCandidates(quickConnectId, this.settings.debugLogEnabled);
    } catch (e) {
      if (freshCachedCandidates.length === 0) throw e;
      debugLog(`QC: server-info lookup failed; using ${freshCachedCandidates.length} fresh cached working candidate(s): ${(e as Error).message}`);
    }
    const cachedCandidates = quickConnectCandidatesAfterResolution(discoveredCandidates, cached, quickConnectId);
    if (this.settings.debugLogEnabled) {
      debugLog(`QC: working-candidate cache entries=${cached.length} candidates_after_cache=${cachedCandidates.length}`);
      cachedCandidates.forEach((candidate, i) => debugLog(`QC: priority [${i}] ${candidateUrl(candidate)} (${candidate.kind}${candidate.source ? ` source=${candidate.source}` : ""})`));
    }
    const candidatesToProbe = cachedCandidates;
    const reachable = await probeQuickConnectCandidates(candidatesToProbe);
    if (reachable) return moveCandidateToFront(candidatesToProbe, reachable);

    const slowReachable = await probeQuickConnectCandidates(candidatesToProbe, 30000);
    if (slowReachable) return moveCandidateToFront(candidatesToProbe, slowReachable);

    return candidatesToProbe;
  }

  private async recordQuickConnectCandidateResult(quickConnectId: string, candidate: QCCandidate, success: boolean): Promise<void> {
    const now = Date.now();
    const normalizedId = normalizedQuickConnectId(quickConnectId);
    const retained = (this.settings.quickConnectCandidateCache || [])
      .filter((entry) => normalizedQuickConnectId(entry.quickConnectId) === normalizedId || now - entry.lastSuccessAt <= QUICKCONNECT_CANDIDATE_CACHE_TTL_MS)
      .filter((entry) => now - entry.lastSuccessAt <= QUICKCONNECT_CANDIDATE_CACHE_TTL_MS);
    const existing = retained.find((entry) => normalizedQuickConnectId(entry.quickConnectId) === normalizedId && sameQuickConnectCandidate(entry.candidate, candidate));
    if (existing) {
      existing.lastTriedAt = now;
      if (success) {
        existing.lastSuccessAt = now;
        existing.successCount += 1;
      } else {
        existing.lastFailureAt = now;
      }
    } else if (success) {
      retained.push({
        candidate,
        quickConnectId: normalizedId,
        successCount: 1,
        lastSuccessAt: now,
        lastTriedAt: now,
      });
    }
    retained.sort((a, b) => b.lastSuccessAt - a.lastSuccessAt || b.successCount - a.successCount);
    this.settings.quickConnectCandidateCache = retained.slice(0, QUICKCONNECT_CANDIDATE_CACHE_LIMIT);
    if (this.settings.debugLogEnabled) {
      debugLog(`QC: working-candidate cache ${success ? "recorded success" : "recorded failure"} ${candidateUrl(candidate)} entries=${this.settings.quickConnectCandidateCache.length}`);
    }
    await this.saveSettings();
  }

  async getFileStation(): Promise<FileStation> {
    if (this.settings.connectionType === "quickconnect") {
      if (!this.settings.quickConnectId) throw new Error("QuickConnect ID not configured");
      const candidates = await this.prioritizedQuickConnectCandidates(this.settings.quickConnectId);
      let lastError: unknown = null;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const config = this.configFromQuickConnectCandidate(candidate);
        debugLog(`QC: trying candidate [${i}] ${config.baseUrl} (${candidate.kind}${candidate.source ? ` source=${candidate.source}` : ""})`);
        const fs = new FileStation(config);
        debugLog(`QC: candidate [${i}] endpoint kind=${fs.endpointKind()}`);
        try {
          const result = await fs.login();
          debugLog(`QC: authenticated candidate [${i}] ${config.baseUrl} (${candidate.kind}${candidate.source ? ` source=${candidate.source}` : ""}) endpoint=${fs.endpointKind()}`);
          await this.recordQuickConnectCandidateResult(this.settings.quickConnectId, candidate, true);
          if (result.deviceToken && result.deviceToken !== this.getDsmDeviceToken()) {
            await this.setDsmDeviceTrust(result.deviceId, result.deviceToken);
          }
          return fs;
        } catch (e) {
          lastError = e;
          debugLog(`QC: candidate [${i}] failed (${candidate.kind}${candidate.source ? ` source=${candidate.source}` : ""}) endpoint=${fs.endpointKind()}: ${(e as Error).message}`);
          await this.recordQuickConnectCandidateResult(this.settings.quickConnectId, candidate, false);
          try { await fs.logout(); } catch { /* ignore */ }
        }
      }
      throw lastError instanceof Error ? lastError : new Error("QuickConnect login failed for all candidates");
    }

    const config = await this.buildConfig();
    const fs = new FileStation(config);
    const result = await fs.login();

    // If we got a new device token, save it
    if (result.deviceToken && result.deviceToken !== this.getDsmDeviceToken()) {
      await this.setDsmDeviceTrust(result.deviceId, result.deviceToken);
    }

    return fs;
  }

  async trustDevice(otpCode: string): Promise<LoginResult> {
    // Generate a stable device ID if we don't have one
    const deviceId = this.getDsmDeviceId() || generateSyncIdentityId();

    const config = await this.buildConfig(otpCode);
    config.deviceId = deviceId;

    const fs = new FileStation(config);
    const result = await fs.login();
    await fs.logout();

    await this.setDsmDeviceTrust(result.deviceId || deviceId, result.deviceToken || this.getDsmDeviceToken());

    return result;
  }

  async clearGitSyncLock(): Promise<string> {
    if (!this.settings.gitFileStationRepoPath) {
      throw new Error("Configure Git bare repository path on NAS first");
    }

    const fs = await this.getFileStation();
    try {
      return await clearFileStationGitLease(fs, this.settings.gitFileStationRepoPath, this.settings.gitBranch);
    } finally {
      await fs.logout();
    }
  }

  async runSync(overrideStrategy?: SynologySyncSettings["conflictStrategy"]): Promise<void> {
    if (this.syncing) {
      new Notice("Sync already in progress");
      return;
    }

    const effectiveSyncBackend = sanitizeSyncBackendForRuntime(this.settings, this.app.vault.adapter);
    if (effectiveSyncBackend === "git-filestation") {
      await this.runGitFileStationSync();
      return;
    }

    if (!this.settings.remotePath) {
      new Notice("Configure remote folder path in Synology Sync settings first");
      return;
    }

    this.syncing = true;
    beginDebugSync(this.app);
    new Notice("Synology Sync starting...");

    let fs: FileStation | null = null;
    try {
      fs = await this.getFileStation();

      const excludePatterns = this.settings.excludePatterns
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const engine = new SyncEngine(this.app.vault, fs, {
        remotePath: this.settings.remotePath,
        conflictStrategy: overrideStrategy ?? this.settings.conflictStrategy,
        excludePatterns,
        syncIdentityId: this.settings.syncIdentityId,
        tombstoneJitterMs: this.settings.tombstoneJitterMs,
        honorTombstoneOnRecreate: this.settings.honorTombstoneOnRecreate,
        remoteAbsenceGraceCycles: this.settings.remoteAbsenceGraceCycles,
        maxFileSizeMb: this.settings.maxFileSizeMb,
      });

      // Safety: suppress the deleteOrphans flag on first sync (legacy #1 guard).
      // The new engine also uses prev-sync history + delete-log shards to make
      // ghost resurrection structurally impossible regardless of this flag.
      const isFirstSync = this.settings.lastSync === 0;
      const deleteOrphans = isFirstSync ? false : this.settings.deleteOrphans;
      if (isFirstSync && this.settings.deleteOrphans) {
        new Notice("First sync: 'Delete remote orphans' disabled for safety. It will apply on subsequent syncs.");
      }

      const result = await engine.sync(deleteOrphans);

      // Only advance lastSync when no infrastructure-level errors occurred.
      // Infrastructure errors are tagged with bracketed pseudo-paths
      // (e.g. "<shard>", "<prev-sync>") and indicate that the sync did not
      // achieve a clean steady state — keeping lastSync at its prior value
      // ensures the next sync still treats this as a continuation rather
      // than the first-sync safety branch.
      const hasInfraError = result.errors.some((e) => e.path.startsWith("<"));
      if (!hasInfraError) {
        this.settings.lastSync = Date.now();
        await this.saveSettings();
      }

      this.showResult(result);
      debugLog(`SYNC FINISHED: ${result.errors.length === 0 ? "SUCCESS" : "FAILED"} — ${result.uploaded.length} uploaded, ${result.downloaded.length} downloaded, ${result.deleted.length} deleted, ${result.conflicts.length} conflicts, ${result.errors.length} errors`);
    } catch (e) {
      debugLog(`SYNC FINISHED: FAILED — ${(e as Error).message}`);
      debugLog(`SYNC FAILED: ${formatErrorForDebug(e)}`);
      this.showFailureNotice("Synology Sync failed.", e);
      console.error("Synology Sync error:", e);
    } finally {
      if (fs) {
        try { await fs.logout(); } catch { /* ignore */ }
      }
      endDebugSync();
      await this.persistLatestSyncLog();
      this.syncing = false;
    }
  }


  private async runGitFileStationSync(): Promise<void> {
    if (!this.settings.gitFileStationRepoPath) {
      new Notice("Configure Git bare repository path on NAS in Synology Sync settings first");
      return;
    }

    this.syncing = true;
    setDebugBreadcrumbsEnabled(this.settings.debugLogEnabled);
    beginDebugSync(this.app);
    const runtimeInstanceId = getRuntimeInstanceId();
    debugBreadcrumb(`[git-filestation-mobile] debug run start runtimeInstance=${runtimeInstanceId} syncing=${this.syncing} debugLogEnabled=${this.settings.debugLogEnabled}`);
    new Notice("Git-over-File-Station sync starting...");
    void this.persistLatestSyncLog("started");
    const progressLogInterval = this.settings.persistSyncLogToVaultNote
      ? globalThis.setInterval(() => {
        void this.persistLatestSyncLog("running");
      }, 15_000)
      : null;

    let fs: FileStation | null = null;
    try {
      fs = await this.getFileStation();
      const engine = new MobileGitFileStationSyncEngine(this.app.vault, fs, {
        remotePath: this.settings.gitFileStationRepoPath,
        branch: this.settings.gitBranch,
        syncIdentityId: this.settings.syncIdentityId,
        authorName: this.settings.gitAuthorName,
        authorEmail: this.settings.gitAuthorEmail,
        configPolicy: this.settings.obsidianConfigPolicy,
        configOptIns: this.settings.obsidianConfigOptIns,
        filenameSanitizeRestrictedChars: this.settings.filenameSanitizeRestrictedChars,
        filenameSanitizeReplacementChar: this.settings.filenameSanitizeReplacementChar,
        debugBreadcrumbs: this.settings.debugLogEnabled,
        runtimeInstanceId,
      });

      const result = await engine.sync();
      const hasInfraError = result.errors.some((e) => e.path.startsWith("<"));
      if (!hasInfraError) {
        this.settings.lastSync = Date.now();
        await this.saveSettings();
      }
      this.showResult(result);
      debugLog(`GIT-OVER-FILE-STATION SYNC FINISHED: ${result.errors.length === 0 ? "SUCCESS" : "FAILED"} — ${result.uploaded.length} uploaded, ${result.downloaded.length} downloaded, ${result.deleted.length} deleted, ${result.conflicts.length} conflicts, ${result.errors.length} errors`);
      debugLog(`SYNC FINISHED: ${result.errors.length === 0 ? "SUCCESS" : "FAILED"} — ${result.uploaded.length} uploaded, ${result.downloaded.length} downloaded, ${result.deleted.length} deleted, ${result.conflicts.length} conflicts, ${result.errors.length} errors`);
    } catch (e) {
      debugLog(`GIT-OVER-FILE-STATION SYNC FINISHED: FAILED — ${(e as Error).message}`);
      debugLog(`SYNC FINISHED: FAILED — ${(e as Error).message}`);
      debugLog(`GIT-OVER-FILE-STATION SYNC FAILED: ${formatErrorForDebug(e)}`);
      this.showFailureNotice(gitFileStationFailureNoticeTitle(e), e);
      console.error("Git-over-File-Station Synology Sync error:", e);
    } finally {
      debugBreadcrumb(`[git-filestation-mobile] debug run cleanup runtimeInstance=${runtimeInstanceId} syncing=${this.syncing}`);
      if (progressLogInterval !== null) globalThis.clearInterval(progressLogInterval);
      if (fs) {
        try { await fs.logout(); } catch { /* ignore */ }
      }
      endDebugSync();
      await this.persistLatestSyncLog();
      this.syncing = false;
      debugBreadcrumb(`[git-filestation-mobile] debug run ended runtimeInstance=${runtimeInstanceId} syncing=${this.syncing}`);
    }
  }

  private async persistLatestSyncLog(status: "started" | "running" | "finished" = "finished"): Promise<void> {
    if (!this.settings.persistSyncLogToVaultNote) return;

    try {
      const log = redactSensitiveLogText(getDebugLog());
      const body = [
        "# Synology Sync Latest Run",
        "",
        `Updated: ${new Date().toISOString()}`,
        `Status: ${status}`,
        `Plugin version: ${this.manifest.version || "unknown"}`,
        `Sync mode: ${this.settings.syncBackend}`,
        "",
        "```text",
        log || "(no log entries)",
        "```",
        "",
      ].join("\n");

      await withTimeout(async () => {
        await this.writeSyncLogNote(LATEST_SYNC_LOG_NOTE_PATH, body);
        if (status === "finished") {
          await this.writeSyncLogNote(syncLogHistoryPath(), body, false);
          await this.pruneSyncLogHistory();
        }
      }, 2000, "persist latest sync log");
    } catch (e) {
      console.warn("Synology Sync could not persist latest sync log:", e);
    }
  }

  private async writeSyncLogNote(path: string, body: string, updateExisting = true): Promise<void> {
    await this.ensureAdapterFolder(path);
    const existing = updateExisting && typeof this.app.vault.getAbstractFileByPath === "function"
      ? this.app.vault.getAbstractFileByPath(path)
      : null;
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.adapter.write(path, body);
  }

  private async pruneSyncLogHistory(): Promise<void> {
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
      list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
      remove?: (path: string) => Promise<void>;
    };
    if (typeof adapter.list !== "function" || typeof adapter.remove !== "function") return;

    const listed = await adapter.list(SYNC_LOG_HISTORY_FOLDER);
    const historyFiles = listed.files
      .map((path) => path.includes("/") ? path : `${SYNC_LOG_HISTORY_FOLDER}/${path}`)
      .filter((path) => path.startsWith(`${SYNC_LOG_HISTORY_FOLDER}/sync-`) && path.endsWith(".md"))
      .sort();
    const staleCount = historyFiles.length - SYNC_LOG_HISTORY_RETENTION;
    if (staleCount <= 0) return;

    for (const stalePath of historyFiles.slice(0, staleCount)) {
      await adapter.remove(stalePath);
    }
  }

  private async ensureAdapterFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
      exists?: (path: string) => Promise<boolean>;
      mkdir?: (path: string) => Promise<void>;
    };
    if (typeof adapter.exists !== "function" || typeof adapter.mkdir !== "function") return;

    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await adapter.exists(current)) continue;
      await adapter.mkdir(current);
    }
  }

  private showResult(result: SyncResult) {
    const total = result.uploaded.length + result.downloaded.length + result.deleted.length;
    if (total === 0 && result.errors.length === 0) {
      new Notice("Synology Sync: already up to date");
      return;
    }

    const parts: string[] = [];
    if (result.uploaded.length) parts.push(`${result.uploaded.length} uploaded`);
    if (result.downloaded.length) parts.push(`${result.downloaded.length} downloaded`);
    if (result.deleted.length) parts.push(`${result.deleted.length} deleted`);
    if (result.conflicts.length) parts.push(`${result.conflicts.length} conflicts`);
    if (result.errors.length) parts.push(`${result.errors.length} errors`);

    if (result.errors.length > 0) {
      console.error("Synology Sync errors:", result.errors);
      debugLog(`--- ${result.errors.length} ERRORS ---`);
      for (const err of result.errors) {
        debugLog(`  ERROR: ${err.path} - ${err.error}`);
      }
    }

    // Log summary to debug log
    debugLog(`Sync complete: ${result.uploaded.length} uploaded, ${result.downloaded.length} downloaded, ${result.deleted.length} deleted, ${result.errors.length} errors`);

    // Clickable notice that opens the debug log
    const frag = document.createDocumentFragment();
    const text = frag.createEl("span", { text: `Synology Sync: ${parts.join(", ")}` });
    if (result.errors.length > 0 || total > 0) {
      frag.createEl("br");
      frag.createEl("span", {
        text: "Click for details",
        attr: { style: "font-size: 0.85em; opacity: 0.7;" },
      });
    }
    const notice = new Notice(frag, result.errors.length > 0 ? 10000 : 5000);
    notice.noticeEl.style.cursor = "pointer";
    notice.noticeEl.addEventListener("click", () => {
      notice.hide();
      new SyncLogModal(this.app, result, getDebugLog()).open();
    });
  }

  private showFailureNotice(title: string, error: unknown) {
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      conflicts: [],
      errors: [{ path: "<sync>", error: error instanceof Error ? error.message : String(error) }],
    };
    const content = typeof document !== "undefined" ? failureNoticeFragment(title) : `${title} Click for details.`;
    const notice = new Notice(content, 15000);
    notice.noticeEl.style.cursor = "pointer";
    notice.noticeEl.addEventListener("click", () => {
      notice.hide();
      new SyncLogModal(this.app, result, getDebugLog()).open();
    });
  }
}

export function gitFileStationFailureNoticeTitle(error: unknown): string {
  if (error instanceof FileStationGitLeaseHeldError) {
    return "Sync blocked: another device holds the Git lock.";
  }
  return "Git-over-File-Station sync failed.";
}

function failureNoticeFragment(title: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.createEl("span", { text: title });
  frag.createEl("br");
  frag.createEl("span", {
    text: "Click for details",
    attr: { style: "font-size: 0.85em; opacity: 0.7;" },
  });
  return frag;
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

class SyncLogModal extends Modal {
  private result: SyncResult;
  private log: string;

  constructor(app: App, result: SyncResult, log: string) {
    super(app);
    this.result = result;
    this.log = log;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Synology Sync Results" });

    const r = this.result;

    if (r.uploaded.length) {
      contentEl.createEl("h4", { text: `Uploaded (${r.uploaded.length})` });
      const ul = contentEl.createEl("ul");
      for (const p of r.uploaded.slice(0, 50)) ul.createEl("li", { text: p });
      if (r.uploaded.length > 50) ul.createEl("li", { text: `... and ${r.uploaded.length - 50} more` });
    }

    if (r.downloaded.length) {
      contentEl.createEl("h4", { text: `Downloaded (${r.downloaded.length})` });
      const ul = contentEl.createEl("ul");
      for (const p of r.downloaded.slice(0, 50)) ul.createEl("li", { text: p });
      if (r.downloaded.length > 50) ul.createEl("li", { text: `... and ${r.downloaded.length - 50} more` });
    }

    if (r.deleted.length) {
      contentEl.createEl("h4", { text: `Deleted (${r.deleted.length})` });
      const ul = contentEl.createEl("ul");
      for (const p of r.deleted.slice(0, 50)) ul.createEl("li", { text: p });
      if (r.deleted.length > 50) ul.createEl("li", { text: `... and ${r.deleted.length - 50} more` });
    }

    if (r.errors.length) {
      contentEl.createEl("h4", { text: `Errors (${r.errors.length})`, attr: { style: "color: var(--text-error);" } });
      const ul = contentEl.createEl("ul");
      for (const e of r.errors.slice(0, 100)) {
        ul.createEl("li", { text: `${e.path}: ${e.error}`, attr: { style: "font-size: 0.9em;" } });
      }
      if (r.errors.length > 100) ul.createEl("li", { text: `... and ${r.errors.length - 100} more` });
    }

    contentEl.createEl("h4", { text: "Debug Log" });
    const pre = contentEl.createEl("pre", {
      attr: { style: "max-height: 300px; overflow: auto; font-size: 0.8em; padding: 8px; background: var(--background-secondary); border-radius: 4px;" },
    });
    pre.createEl("code", { text: this.log || "(empty)" });
  }

  onClose() {
    this.contentEl.empty();
  }
}
