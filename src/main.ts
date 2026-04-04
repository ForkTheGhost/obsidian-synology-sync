import { Plugin, Notice } from "obsidian";
import { FileStation, FileStationConfig, LoginResult } from "./filestation";
import { resolveQuickConnect } from "./quickconnect";
import { SyncEngine, SyncResult } from "./sync";
import { SynologySyncSettings, SynologySyncSettingTab, DEFAULT_SETTINGS } from "./settings";

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

    if (this.settings.connectionType === "quickconnect") {
      if (!this.settings.quickConnectId) throw new Error("QuickConnect ID not configured");
      const resolved = await resolveQuickConnect(this.settings.quickConnectId);
      baseUrl = `${resolved.https ? "https" : "http"}://${resolved.host}:${resolved.port}`;
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
      this.settings.deviceId = crypto.randomUUID();
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

      const engine = new SyncEngine(
        this.app.vault,
        fs,
        this.settings.remotePath,
        overrideStrategy ?? this.settings.conflictStrategy,
        excludePatterns,
      );

      const result = await engine.sync(this.settings.deleteOrphans);
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

    new Notice(`Synology Sync: ${parts.join(", ")}`);

    if (result.errors.length > 0) {
      console.error("Synology Sync errors:", result.errors);
    }
  }
}
