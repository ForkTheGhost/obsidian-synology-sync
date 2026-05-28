import { App, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import type SynologySync from "./main";
import { resolveQuickConnect } from "./quickconnect";
import { getDebugLog, getDebugLogSnippet, clearDebugLog, subscribeDebugLog } from "./debug";
import { FileStation, FileInfo } from "./filestation";
import type { ObsidianConfigOptIns, ObsidianConfigSyncPolicy } from "./git-excludes";
import type { QCCandidate } from "./quickconnect";

export interface CachedQuickConnectCandidate {
  candidate: QCCandidate;
  quickConnectId: string;
  successCount: number;
  lastSuccessAt: number;
  lastTriedAt?: number;
  lastFailureAt?: number;
}

export interface SynologySyncSettings {
  syncBackend: "filestation" | "git-filestation";
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

  // Git-bare-backed Sync stores a bare repo on the NAS and uses
  // File Station/QuickConnect as the transport.
  gitFileStationRepoPath: string;
  gitBranch: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  obsidianConfigPolicy: ObsidianConfigSyncPolicy;
  obsidianConfigOptIns: ObsidianConfigOptIns;
  debugLogEnabled: boolean;
  quickConnectCandidateCache: CachedQuickConnectCandidate[];
  persistSyncLogToVaultNote: boolean;
}

export const LATEST_SYNC_LOG_NOTE_PATH = ".obsidian/plugins/synology-sync/latest-run.md";

export function sanitizeSyncBackendForRuntime(
  settings: SynologySyncSettings,
  _adapter: unknown,
): "filestation" | "git-filestation" {
  return settings.syncBackend === "git-filestation" ? "git-filestation" : "filestation";
}

export const DEFAULT_SETTINGS: SynologySyncSettings = {
  syncBackend: "filestation",
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
  gitFileStationRepoPath: "",
  gitBranch: "main",
  gitAuthorName: "Obsidian Synology Sync",
  gitAuthorEmail: "synology-sync@local",
  obsidianConfigPolicy: "notes-only",
  obsidianConfigOptIns: {},
  debugLogEnabled: false,
  quickConnectCandidateCache: [],
  persistSyncLogToVaultNote: false,
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
  if (!Array.isArray(settings.quickConnectCandidateCache)) {
    settings.quickConnectCandidateCache = [];
    changed = true;
  }
  if (typeof settings.debugLogEnabled !== "boolean") {
    const legacyDebugQuickConnectResolution = (settings as SynologySyncSettings & { debugQuickConnectResolution?: unknown }).debugQuickConnectResolution;
    settings.debugLogEnabled = typeof legacyDebugQuickConnectResolution === "boolean" ? legacyDebugQuickConnectResolution : false;
    changed = true;
  }
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

    const effectiveSyncBackend = sanitizeSyncBackendForRuntime(this.plugin.settings, this.app.vault.adapter);

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Connect to Synology File Station by QuickConnect or direct address, then choose Single User or Multi User/Device sync.")
      .addDropdown((dd) =>
        dd
          .addOption("filestation", "Single User (Simple File Sync)")
          .addOption("git-filestation", "Multi User/Device (Git-bare-backed Sync)")
          .setValue(effectiveSyncBackend)
          .onChange(async (value: string) => {
            this.plugin.settings.syncBackend = value as SynologySyncSettings["syncBackend"];
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (effectiveSyncBackend === "filestation") {
      new Setting(containerEl)
        .setName("Remote folder path")
        .setDesc("Required for Single User (Simple File Sync). Use a normal NAS folder containing readable Markdown files.")
        .addText((text) =>
          text
            .setPlaceholder("/homes/username/Obsidian/MyVault")
            .setValue(this.plugin.settings.remotePath)
            .onChange(async (value) => {
              this.plugin.settings.remotePath = value;
              await this.plugin.saveSettings();
            })
        )
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
    }

    if (effectiveSyncBackend === "git-filestation") {
      new Setting(containerEl)
        .setName("Bare repository path on NAS")
        .setDesc("Required for Multi User/Device (Git-bare-backed Sync). Use a bare Git repository on Synology, such as MyVault.git; do not open this path as an Obsidian vault.")
        .addText((text) =>
          text
            .setPlaceholder("/homes/username/Obsidian/MyVault.git")
            .setValue(this.plugin.settings.gitFileStationRepoPath)
            .onChange(async (value) => {
              this.plugin.settings.gitFileStationRepoPath = value.trim();
              await this.plugin.saveSettings();
            })
        )
        .addButton((btn) =>
          btn.setButtonText("Browse").onClick(async () => {
            try {
              const fs = await this.plugin.getFileStation();
              new FolderBrowserModal(this.app, fs, this.plugin.settings.gitFileStationRepoPath, async (path) => {
                this.plugin.settings.gitFileStationRepoPath = path;
                await this.plugin.saveSettings();
                this.display();
              }, {
                title: "Select bare Git repo",
                selectLabel: (path) => `Use this repo: ${path}`,
                emptySelectionLabel: "Select a repo folder first",
                selectedNotice: (path) => `Bare repo path set to: ${path}`,
                validateSelection: async (fs, path) => {
                  const bare = await fs.isBareGitRepo(path);
                  if (bare) {
                    return {
                      ok: true,
                      message: "Bare Git repo detected. This will be used as the shared upstream; do not open it as an Obsidian vault.",
                    };
                  }
                  return {
                    ok: false,
                    message: "This looks like a normal folder, not a bare Git repo. Choose a repo folder such as MyVault.git or initialize one first.",
                  };
                },
              }).open();
            } catch (e) {
              new Notice(`Browse failed: ${(e as Error).message}`);
            }
          })
        );

      new Setting(containerEl)
        .setName("Branch")
        .setDesc("Branch to sync")
        .addText((text) =>
          text
            .setPlaceholder("main")
            .setValue(this.plugin.settings.gitBranch)
            .onChange(async (value) => {
              this.plugin.settings.gitBranch = value.trim() || "main";
              await this.plugin.saveSettings();
            })
        );


      new Setting(containerEl)
        .setName("Obsidian config sync policy")
        .setDesc("Notes only is safest. Selected settings lets you opt into reviewed .obsidian categories. Advanced full config may sync secrets/device-specific paths.")
        .addDropdown((dd) =>
          dd
            .addOption("notes-only", "Notes only")
            .addOption("selected-settings", "Notes + selected settings")
            .addOption("full-config", "Advanced full config")
            .setValue(this.plugin.settings.obsidianConfigPolicy)
            .onChange(async (value: string) => {
              this.plugin.settings.obsidianConfigPolicy = value as ObsidianConfigSyncPolicy;
              await this.plugin.saveSettings();
              this.display();
            })
        );

      if (this.plugin.settings.obsidianConfigPolicy === "selected-settings") {
        const opt = this.plugin.settings.obsidianConfigOptIns || {};
        const addOptIn = (name: string, desc: string, key: keyof ObsidianConfigOptIns) => {
          new Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addToggle((toggle) => toggle.setValue(!!opt[key]).onChange(async (value) => {
              this.plugin.settings.obsidianConfigOptIns = { ...(this.plugin.settings.obsidianConfigOptIns || {}), [key]: value };
              await this.plugin.saveSettings();
            }));
        };
        addOptIn("Appearance/app/graph settings", "Sync reviewed appearance/app/graph JSON files.", "appearance");
        addOptIn("Plugin lists", "Sync community/core plugin list files, not plugin data.", "pluginLists");
        addOptIn("Hotkeys", "Sync .obsidian/hotkeys.json.", "hotkeys");
        addOptIn("Snippets", "Sync .obsidian/snippets/.", "snippets");
      }

      new Setting(containerEl)
        .setName("Commit author")
        .setDesc("Used for automatic sync commits if the local repo has no author configured")
        .addText((text) =>
          text
            .setPlaceholder("Obsidian Synology Sync")
            .setValue(this.plugin.settings.gitAuthorName)
            .onChange(async (value) => {
              this.plugin.settings.gitAuthorName = value.trim() || "Obsidian Synology Sync";
              await this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder("synology-sync@local")
            .setValue(this.plugin.settings.gitAuthorEmail)
            .onChange(async (value) => {
              this.plugin.settings.gitAuthorEmail = value.trim() || "synology-sync@local";
              await this.plugin.saveSettings();
            })
        );
    }

    // Sync behavior
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

    if (effectiveSyncBackend === "filestation") {
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
    } else {
      new Setting(containerEl)
        .setName("Git notes")
        .setDesc("Git backend uses real Git commits and merge behavior. In File Station mode, the NAS path is a bare Git repo used as the canonical store; human-readable files are checked out locally or by an optional server-side mirror task.");
    }

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
      .setName("Persist latest run log")
      .setDesc(`Write the redacted latest sync transcript to ${LATEST_SYNC_LOG_NOTE_PATH}`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.persistSyncLogToVaultNote).onChange(async (value) => {
          this.plugin.settings.persistSyncLogToVaultNote = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debug log")
      .setDesc("Enable extra diagnostic logging for troubleshooting. Logs are sanitized and may include detailed connection, sync, and QuickConnect resolution details.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogEnabled).onChange(async (value) => {
          this.plugin.settings.debugLogEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("View debug log")
      .setDesc("View detailed connection and auth logs (credentials are redacted)")
      .addButton((btn) =>
        btn.setButtonText("Show log").onClick(() => {
          new DebugLogModal(this.app).open();
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

interface FolderBrowserValidationResult {
  ok: boolean;
  message: string;
}

interface FolderBrowserModalOptions {
  title?: string;
  selectLabel?: (path: string) => string;
  emptySelectionLabel?: string;
  selectedNotice?: (path: string) => string;
  validateSelection?: (fs: FileStation, path: string) => Promise<FolderBrowserValidationResult>;
}

class FolderBrowserModal extends Modal {
  private fs: FileStation;
  private currentPath: string;
  private onSelect: (path: string) => void;
  private options: FolderBrowserModalOptions;
  private validation: FolderBrowserValidationResult | null = null;
  private validating = false;

  constructor(
    app: App,
    fs: FileStation,
    initialPath: string,
    onSelect: (path: string) => void,
    options: FolderBrowserModalOptions = {},
  ) {
    super(app);
    this.fs = fs;
    this.currentPath = initialPath || "";
    this.onSelect = onSelect;
    this.options = options;
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
    this.validation = null;
    this.validating = !!(this.currentPath && this.options.validateSelection);

    contentEl.createEl("h2", { text: this.options.title || "Select Folder" });

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

    const validationEl = contentEl.createDiv({ cls: "setting-item-description" });
    validationEl.style.marginBottom = "12px";
    if (this.validating) validationEl.setText("Validating selection...");

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
      text: this.currentPath
        ? (this.options.selectLabel ? this.options.selectLabel(this.currentPath) : `Select "${this.currentPath}"`)
        : (this.options.emptySelectionLabel || "Select a folder first"),
      cls: this.currentPath ? "mod-cta" : "",
    });
    selectBtn.disabled = !this.currentPath || this.validating;
    selectBtn.addEventListener("click", () => {
      if (!this.currentPath) return;
      if (this.options.validateSelection && !this.validation?.ok) {
        new Notice(this.validation?.message || "Selection is not valid");
        return;
      }
      this.onSelect(this.currentPath);
      new Notice(this.options.selectedNotice ? this.options.selectedNotice(this.currentPath) : `Remote path set to: ${this.currentPath}`);
      this.close();
    });

    if (this.currentPath && this.options.validateSelection) {
      try {
        this.validation = await this.options.validateSelection(this.fs, this.currentPath);
      } catch (e) {
        this.validation = {
          ok: false,
          message: `Could not validate this path. Permission may be limited or File Station could not list the required Git directories. ${(e as Error).message}`,
        };
      }
      validationEl.setText(this.validation.message);
      selectBtn.disabled = !this.validation.ok;
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

        row.createSpan({ text: "📁" }); // folder emoji
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
  private preEl: HTMLPreElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Synology Sync - Live Debug Log" });
    contentEl.createEl("p", {
      text: "Live feed. Leave this open while syncing; final success/failure is printed as an obvious SYNC FINISHED line. Passwords and tokens are redacted.",
      cls: "setting-item-description",
    });

    this.preEl = contentEl.createEl("pre");
    this.preEl.style.fontSize = "11px";
    this.preEl.style.lineHeight = "1.4";
    this.preEl.style.whiteSpace = "pre-wrap";
    this.preEl.style.wordBreak = "break-all";
    this.preEl.style.maxHeight = "400px";
    this.preEl.style.overflow = "auto";
    this.preEl.style.padding = "8px";
    this.preEl.style.borderRadius = "4px";
    this.preEl.style.backgroundColor = "var(--background-secondary)";

    const render = () => this.renderLog();
    this.unsubscribe = subscribeDebugLog(render);
    render();

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Copy to clipboard").setCta().onClick(async () => {
          await navigator.clipboard.writeText(getDebugLog());
          new Notice("Debug log copied to clipboard");
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Copy snippet").onClick(async () => {
          await navigator.clipboard.writeText(getDebugLogSnippet(this.app));
          new Notice("Debug snippet copied to clipboard");
        })
      );
  }

  private renderLog() {
    if (!this.preEl) return;
    const nearBottom = this.preEl.scrollTop + this.preEl.clientHeight >= this.preEl.scrollHeight - 24;
    this.preEl.setText(getDebugLog() || "(no log entries yet - try Browse or Sync first)");
    if (nearBottom) this.preEl.scrollTop = this.preEl.scrollHeight;
  }

  onClose() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.contentEl.empty();
  }
}
