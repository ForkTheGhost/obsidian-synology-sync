import { Plugin, Notice, Modal, App } from "obsidian";
import { FileStation, FileStationConfig, LoginResult } from "./filestation";
import { resolveQuickConnect } from "./quickconnect";
import { SyncEngine, SyncResult } from "./sync";
import { SynologySyncSettings, SynologySyncSettingTab, DEFAULT_SETTINGS } from "./settings";
import { debugLog, getDebugLog } from "./debug";

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

export default class SynologySync extends Plugin {
  settings: SynologySyncSettings = DEFAULT_SETTINGS;
  private autoSyncInterval: number | null = null;
  private syncing = false;

  async onload() {
    await this.loadSettings();
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

    if (this.settings.syncOnStartup && this.settings.remotePath) {
      // Delay startup sync to let vault finish loading
      setTimeout(() => this.runSync(), 5000);
    }
  }

  onunload() {
    if (this.autoSyncInterval !== null) {
      window.clearInterval(this.autoSyncInterval);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  async getFileStation(): Promise<FileStation> {
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

    if (!this.settings.remotePath) {
      new Notice("Configure remote folder path in Synology Sync settings first");
      return;
    }

    this.syncing = true;
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
      this.settings.lastSync = Date.now();
      await this.saveSettings();

      this.showResult(result);
    } catch (e) {
      new Notice(`Sync failed: ${(e as Error).message}`);
      console.error("Synology Sync error:", e);
    } finally {
      if (fs) {
        try { await fs.logout(); } catch { /* ignore */ }
      }
      this.syncing = false;
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
