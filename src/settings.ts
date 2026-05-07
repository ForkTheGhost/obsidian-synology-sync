import { App, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import type SynologySync from "./main";
import { resolveQuickConnect } from "./quickconnect";
import { getDebugLog, clearDebugLog } from "./debug";
import { FileStation, FileInfo } from "./filestation";

export interface SynologySyncSettings {
  connectionType: "quickconnect" | "direct";
  quickConnectId: string;
  host: string;
  port: number;
  https: boolean;
  username: string;
  password: string;
  remotePath: string;
  syncInterval: number; // minutes, 0 = manual only
  conflictStrategy: "newer-wins" | "local-wins" | "remote-wins" | "skip";
  deleteOrphans: boolean;
  excludePatterns: string;
  syncOnStartup: boolean;
  lastSync: number;
  deviceId: string;
  deviceToken: string;

  // Stable identity for this device's delete-log shard on the NAS.
  // Distinct from deviceId (which is the DSM 2FA `did` cookie, overwritten on login).
  // Generated once on first plugin load; never rewritten.
  syncIdentityId: string;

  // Delete-log retention. 0 = keep forever (default; shard is tiny).
  tombstoneRetentionDays: number;

  // When a local file exists and a tombstone marks the path deleted, the default
  // behavior is preserve-local and purge the stale tombstone (prevents silent data loss).
  // Setting this to true honors the tombstone and deletes the local file.
  honorTombstoneOnRecreate: boolean;

  // Grace window for clock skew across devices (milliseconds). Used by the
  // decision-table mtime gate on rows 8 and 10 to detect recreate-after-delete.
  tombstoneJitterMs: number;

  // Rows 3/10 staleness gate: upload local file if remote has been absent
  // for fewer than N sync cycles; beyond that, prefer delete-local.
  remoteAbsenceGraceCycles: number;

  // Files larger than this (megabytes) are skipped during sync to prevent
  // out-of-memory errors on mobile. 0 disables the limit. Default: 100.
  maxFileSizeMb: number;
}

export const DEFAULT_SETTINGS: SynologySyncSettings = {
  connectionType: "quickconnect",
  quickConnectId: "",
  host: "",
  port: 5001,
  https: true,
  username: "",
  password: "",
  remotePath: "",
  syncInterval: 0,
  conflictStrategy: "newer-wins",
  deleteOrphans: false,
  excludePatterns: "",
  syncOnStartup: false,
  lastSync: 0,
  deviceId: "",
  deviceToken: "",
  syncIdentityId: "",
  tombstoneRetentionDays: 0,
  honorTombstoneOnRecreate: false,
  // 5s jitter absorbs realistic cross-device clock skew (Synology mtime
  // resolution is 1 second). The prior default of 30s was too wide — it
  // created a 30-second window where a live remote file could be treated
  // as a stale tombstone and silently deleted.
  tombstoneJitterMs: 5000,
  remoteAbsenceGraceCycles: 2,
  maxFileSizeMb: 100,
};

// Legacy default that was shipped in releases prior to 2026.0505.1.
// Used by the migration shim to distinguish "user left the old default"
// from "user intentionally set a custom value".
const LEGACY_TOMBSTONE_JITTER_MS = 30000;

/**
 * Applies one-time migrations to settings loaded from disk.
 * Returns true if any value was changed (caller should persist).
 */
export function migrateLoadedSettings(settings: SynologySyncSettings): boolean {
  let changed = false;
  if (settings.tombstoneJitterMs === LEGACY_TOMBSTONE_JITTER_MS) {
    settings.tombstoneJitterMs = DEFAULT_SETTINGS.tombstoneJitterMs;
    changed = true;
  }
  return changed;
}

export class SynologySyncSettingTab extends PluginSettingTab {
  plugin: SynologySync;

  constructor(app: App, plugin: SynologySync) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Synology Sync" });

    // Connection type
    new Setting(containerEl)
      .setName("Connection type")
      .setDesc("Use QuickConnect ID or direct IP/hostname")
      .addDropdown((dd) =>
        dd
          .addOption("quickconnect", "QuickConnect ID")
          .addOption("direct", "Direct connection")
          .setValue(this.plugin.settings.connectionType)
          .onChange(async (value: string) => {
            this.plugin.settings.connectionType = value as "quickconnect" | "direct";
            await this.plugin.saveSettings();
            this.display(); // re-render to show/hide fields
          })
      );

    if (this.plugin.settings.connectionType === "quickconnect") {
      new Setting(containerEl)
        .setName("QuickConnect ID")
        .setDesc("Your Synology QuickConnect ID (e.g. 'mynas')")
        .addText((text) =>
          text
            .setPlaceholder("mynas")
            .setValue(this.plugin.settings.quickConnectId)
            .onChange(async (value) => {
              this.plugin.settings.quickConnectId = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Test QuickConnect")
        .setDesc("Resolve the QuickConnect ID and test connectivity")
        .addButton((btn) =>
          btn.setButtonText("Test").onClick(async () => {
            try {
              new Notice("Resolving QuickConnect...");
              const resolved = await resolveQuickConnect(this.plugin.settings.quickConnectId);
              new Notice(
                `Resolved: ${resolved.https ? "https" : "http"}://${resolved.host}:${resolved.port}`
              );
            } catch (e) {
              new Notice(`QuickConnect failed: ${(e as Error).message}`);
            }
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Host")
        .setDesc("NAS IP address or hostname")
        .addText((text) =>
          text
            .setPlaceholder("nas.local")
            .setValue(this.plugin.settings.host)
            .onChange(async (value) => {
              this.plugin.settings.host = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Port")
        .setDesc("DSM port (default: 5001 for HTTPS, 5000 for HTTP)")
        .addText((text) =>
          text
            .setPlaceholder("5001")
            .setValue(String(this.plugin.settings.port))
            .onChange(async (value) => {
              this.plugin.settings.port = parseInt(value) || 5001;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Use HTTPS")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.https).onChange(async (value) => {
            this.plugin.settings.https = value;
            await this.plugin.saveSettings();
          })
        );
    }

    // Credentials
    containerEl.createEl("h3", { text: "Authentication" });

    new Setting(containerEl)
      .setName("Username")
      .addText((text) =>
        text
          .setPlaceholder("admin")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("password")
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
      });

    // 2FA device trust
    if (this.plugin.settings.deviceToken) {
      new Setting(containerEl)
        .setName("2FA device trust")
        .setDesc("This device is trusted - 2FA will be skipped on login")
        .addButton((btn) =>
          btn.setButtonText("Forget device").onClick(async () => {
            this.plugin.settings.deviceId = "";
            this.plugin.settings.deviceToken = "";
            await this.plugin.saveSettings();
            new Notice("Device trust cleared. You will need to enter a 2FA code on next sync.");
            this.display();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("2FA setup")
        .setDesc("If your DSM account has 2FA enabled, enter your authenticator code to trust this device")
        .addText((text) =>
          text.setPlaceholder("6-digit code").onChange(() => {})
        )
        .addButton((btn) =>
          btn.setButtonText("Trust device").onClick(async () => {
            const otpInput = containerEl.querySelector<HTMLInputElement>(
              'input[placeholder="6-digit code"]'
            );
            const otpCode = otpInput?.value?.trim();
            if (!otpCode || otpCode.length < 6) {
              new Notice("Enter your 6-digit authenticator code");
              return;
            }
            try {
              new Notice("Authenticating with 2FA...");
              const result = await this.plugin.trustDevice(otpCode);
              if (result.deviceToken) {
                new Notice("Device trusted! 2FA will be skipped on future logins.");
              } else {
                new Notice("Logged in but no device token returned. 2FA may still be required.");
              }
              this.display();
            } catch (e) {
              new Notice(`2FA failed: ${(e as Error).message}`);
            }
          })
        );
    }

    // Sync target
    containerEl.createEl("h3", { text: "Sync Target" });

    new Setting(containerEl)
      .setName("Remote folder path")
      .setDesc("Full path on the NAS (e.g. /homes/user/Obsidian/MyVault)")
      .addText((text) =>
        text
          .setPlaceholder("/homes/username/Obsidian/MyVault")
          .setValue(this.plugin.settings.remotePath)
          .onChange(async (value) => {
            this.plugin.settings.remotePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Browse folders")
      .setDesc("Connect to NAS and browse for the target folder")
      .addButton((btn) =>
        btn.setButtonText("Browse").onClick(async () => {
          try {
            const fs = await this.plugin.getFileStation();
            new FolderBrowserModal(this.app, fs, this.plugin.settings.remotePath, async (path) => {
              this.plugin.settings.remotePath = path;
              await this.plugin.saveSettings();
              this.display();
            }).open();
          } catch (e) {
            new Notice(`Browse failed: ${(e as Error).message}`);
          }
        })
      );

    // Sync settings
    containerEl.createEl("h3", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("0 = manual sync only")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = parseInt(value) || 0;
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Conflict resolution")
      .setDesc("When a file differs on both sides")
      .addDropdown((dd) =>
        dd
          .addOption("newer-wins", "Newer file wins")
          .addOption("local-wins", "Local always wins")
          .addOption("remote-wins", "Remote always wins")
          .addOption("skip", "Skip conflicts")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value: string) => {
            this.plugin.settings.conflictStrategy = value as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Delete remote orphans")
      .setDesc("Remove files from NAS that no longer exist locally. Automatically disabled on first sync to prevent data loss.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.deleteOrphans).onChange(async (value) => {
          this.plugin.settings.deleteOrphans = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("Regex patterns to exclude, one per line")
      .addTextArea((text) =>
        text
          .setPlaceholder("^\\.git/\n^node_modules/")
          .setValue(this.plugin.settings.excludePatterns)
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Files larger than this are skipped during sync to prevent out-of-memory errors on mobile (0 = no limit). Default: 100.")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxFileSizeMb))
          .onChange(async (value) => {
            const parsed = parseInt(value);
            this.plugin.settings.maxFileSizeMb =
              Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;
            await this.plugin.saveSettings();
          })
      );

    // Status
    containerEl.createEl("h3", { text: "Status" });

    const lastSync = this.plugin.settings.lastSync;
    const lastSyncText = lastSync ? new Date(lastSync).toLocaleString() : "Never";

    new Setting(containerEl)
      .setName("Last sync")
      .setDesc(lastSyncText)
      .addButton((btn) =>
        btn.setButtonText("Sync now").setCta().onClick(async () => {
          await this.plugin.runSync();
        })
      );

    // Debug
    containerEl.createEl("h3", { text: "Troubleshooting" });

    new Setting(containerEl)
      .setName("Debug log")
      .setDesc("View detailed connection and auth logs (credentials are redacted)")
      .addButton((btn) =>
        btn.setButtonText("Show log").onClick(() => {
          new DebugLogModal(this.app, getDebugLog()).open();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Clear").onClick(() => {
          clearDebugLog();
          new Notice("Debug log cleared");
        })
      );
  }
}

class FolderBrowserModal extends Modal {
  private fs: FileStation;
  private currentPath: string;
  private pathHistory: string[];
  private onSelect: (path: string) => void;

  constructor(app: App, fs: FileStation, initialPath: string, onSelect: (path: string) => void) {
    super(app);
    this.fs = fs;
    this.currentPath = initialPath || "";
    this.pathHistory = [];
    this.onSelect = onSelect;
  }

  async onOpen() {
    await this.renderFolder();
  }

  onClose() {
    this.contentEl.empty();
    this.fs.logout().catch(() => {});
  }

  private async renderFolder() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Select Folder" });

    // Current path display
    const pathBar = contentEl.createDiv({ cls: "synology-path-bar" });
    pathBar.style.padding = "8px 12px";
    pathBar.style.backgroundColor = "var(--background-secondary)";
    pathBar.style.borderRadius = "4px";
    pathBar.style.marginBottom = "12px";
    pathBar.style.fontFamily = "var(--font-monospace)";
    pathBar.style.fontSize = "13px";
    pathBar.style.wordBreak = "break-all";
    pathBar.setText(this.currentPath || "/");

    // Action buttons row
    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.marginBottom = "12px";

    if (this.currentPath) {
      const upBtn = actions.createEl("button", { text: ".. Up" });
      upBtn.addEventListener("click", async () => {
        const parts = this.currentPath.split("/").filter(Boolean);
        parts.pop();
        this.currentPath = parts.length > 0 ? "/" + parts.join("/") : "";
        await this.renderFolder();
      });
    }

    const selectBtn = actions.createEl("button", {
      text: this.currentPath ? `Select "${this.currentPath}"` : "Select a folder first",
      cls: this.currentPath ? "mod-cta" : "",
    });
    if (this.currentPath) {
      selectBtn.addEventListener("click", () => {
        this.onSelect(this.currentPath);
        new Notice(`Remote path set to: ${this.currentPath}`);
        this.close();
      });
    } else {
      selectBtn.disabled = true;
    }

    // Loading indicator
    const list = contentEl.createDiv();
    list.setText("Loading...");

    try {
      let items: any[];
      if (!this.currentPath) {
        // Root level: show shared folders
        items = await this.fs.listShares();
      } else {
        items = await this.fs.listFolder(this.currentPath);
      }

      list.empty();

      // Filter to directories only
      const folders = items.filter((f: any) => f.isdir);
      const files = items.filter((f: any) => !f.isdir);

      if (folders.length === 0 && files.length === 0) {
        list.createDiv({ text: "(empty folder)", cls: "setting-item-description" });
      }

      // Folders first (clickable)
      for (const folder of folders) {
        const row = list.createDiv();
        row.style.padding = "6px 12px";
        row.style.cursor = "pointer";
        row.style.borderRadius = "4px";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";

        row.createSpan({ text: "\uD83D\uDCC1" }); // folder emoji
        row.createSpan({ text: folder.name || folder.path.split("/").pop() });

        row.addEventListener("mouseenter", () => {
          row.style.backgroundColor = "var(--background-modifier-hover)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.backgroundColor = "";
        });
        row.addEventListener("click", async () => {
          this.currentPath = folder.path;
          await this.renderFolder();
        });
      }

      // Show file count (non-clickable, just for context)
      if (files.length > 0) {
        const fileCount = list.createDiv();
        fileCount.style.padding = "6px 12px";
        fileCount.style.opacity = "0.5";
        fileCount.style.fontSize = "12px";
        fileCount.setText(`+ ${files.length} file${files.length !== 1 ? "s" : ""}`);
      }
    } catch (e) {
      list.empty();
      list.createDiv({ text: `Error: ${(e as Error).message}`, cls: "setting-item-description" });
    }
  }
}

class DebugLogModal extends Modal {
  private logContent: string;

  constructor(app: App, logContent: string) {
    super(app);
    this.logContent = logContent || "(no log entries yet - try Browse or Sync first)";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Synology Sync - Debug Log" });
    contentEl.createEl("p", {
      text: "Copy this log and share it for troubleshooting. Passwords and tokens are redacted.",
      cls: "setting-item-description",
    });

    const pre = contentEl.createEl("pre", {
      text: this.logContent,
    });
    pre.style.fontSize = "11px";
    pre.style.lineHeight = "1.4";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-all";
    pre.style.maxHeight = "400px";
    pre.style.overflow = "auto";
    pre.style.padding = "8px";
    pre.style.borderRadius = "4px";
    pre.style.backgroundColor = "var(--background-secondary)";

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Copy to clipboard").setCta().onClick(async () => {
          await navigator.clipboard.writeText(this.logContent);
          new Notice("Debug log copied to clipboard");
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close())
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
