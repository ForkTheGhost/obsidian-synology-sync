import { Plugin, Notice, Modal, App } from "obsidian";
import { FileStation, FileStationConfig, LoginResult } from "./filestation";
import { compareQuickConnectCandidates, resolveQuickConnect, resolveQuickConnectCandidates, probeQuickConnectCandidates, QCCandidate } from "./quickconnect";
import { SyncEngine, SyncResult } from "./sync";
import { MobileGitFileStationSyncEngine } from "./git-filestation-mobile";
import { CachedQuickConnectCandidate, SynologySyncSettings, SynologySyncSettingTab, DEFAULT_SETTINGS, LATEST_SYNC_LOG_NOTE_PATH, migrateLoadedSettings, sanitizeSyncBackendForRuntime } from "./settings";
import { beginDebugSync, debugLog, endDebugSync, formatErrorForDebug, getDebugLog, logRuntimeDiagnostics, redactSensitiveLogText } from "./debug";

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
    if (!this.settings.syncIdentityId) {
      this.settings.syncIdentityId = generateSyncIdentityId();
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      password: this.settings.password,
      deviceId: this.settings.deviceId || undefined,
      deviceToken: this.settings.deviceToken || undefined,
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
      password: this.settings.password,
      deviceId: this.settings.deviceId || undefined,
      deviceToken: this.settings.deviceToken || undefined,
      otpCode,
      quickConnectRelay,
    };
  }


  private async prioritizedQuickConnectCandidates(quickConnectId: string): Promise<QCCandidate[]> {
    const candidates = await resolveQuickConnectCandidates(quickConnectId, this.settings.debugLogEnabled);
    const freshCachedCandidates = freshCachedQuickConnectCandidates(this.settings.quickConnectCandidateCache || [], quickConnectId);
    if (freshCachedCandidates.length > 0) {
      debugLog(`QC: found ${freshCachedCandidates.length} fresh cached working candidate(s); merging with rediscovered candidates by source priority`);
    }
    const cachedCandidates = prioritizeCachedQuickConnectCandidates(
      candidates,
      this.settings.quickConnectCandidateCache || [],
      quickConnectId,
    );
    if (this.settings.debugLogEnabled) {
      debugLog(`QC: working-candidate cache entries=${(this.settings.quickConnectCandidateCache || []).length} candidates_after_cache=${cachedCandidates.length}`);
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
          if (result.deviceToken && result.deviceToken !== this.settings.deviceToken) {
            this.settings.deviceId = result.deviceId;
            this.settings.deviceToken = result.deviceToken;
            await this.saveSettings();
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
    if (result.deviceToken && result.deviceToken !== this.settings.deviceToken) {
      this.settings.deviceId = result.deviceId;
      this.settings.deviceToken = result.deviceToken;
      await this.saveSettings();
    }

    return fs;
  }

  async trustDevice(otpCode: string): Promise<LoginResult> {
    // Generate a stable device ID if we don't have one
    if (!this.settings.deviceId) {
      this.settings.deviceId = generateSyncIdentityId();
    }

    const config = await this.buildConfig(otpCode);
    config.deviceId = this.settings.deviceId;

    const fs = new FileStation(config);
    const result = await fs.login();
    await fs.logout();

    if (result.deviceToken) {
      this.settings.deviceToken = result.deviceToken;
    }
    this.settings.deviceId = result.deviceId || this.settings.deviceId;
    await this.saveSettings();

    return result;
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
    await this.persistLatestSyncLog("started");
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
      new Notice(`Sync failed: ${(e as Error).message}`);
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
    beginDebugSync(this.app);
    await this.persistLatestSyncLog("started");
    new Notice("Git-over-File-Station sync starting...");

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
      new Notice(`Git-over-File-Station sync failed: ${(e as Error).message}`);
      console.error("Git-over-File-Station Synology Sync error:", e);
    } finally {
      if (fs) {
        try { await fs.logout(); } catch { /* ignore */ }
      }
      endDebugSync();
      await this.persistLatestSyncLog();
      this.syncing = false;
    }
  }

  private async persistLatestSyncLog(status: "started" | "finished" = "finished"): Promise<void> {
    if (!this.settings.persistSyncLogToVaultNote) return;

    try {
      debugLog(`Persistent log ${status}: ${LATEST_SYNC_LOG_NOTE_PATH}`);
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

      await this.ensureAdapterFolder(LATEST_SYNC_LOG_NOTE_PATH);
      await this.app.vault.adapter.write(LATEST_SYNC_LOG_NOTE_PATH, body);
    } catch (e) {
      console.warn("Synology Sync could not persist latest sync log:", e);
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
