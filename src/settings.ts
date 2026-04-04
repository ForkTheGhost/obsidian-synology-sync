import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SynologySync from "./main";
import { resolveQuickConnect } from "./quickconnect";

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
};

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
            const shares = await fs.listShares();
            const names = shares.map((s: any) => s.path).join("\n");
            new Notice(`Shared folders:\n${names}`, 10000);
            await fs.logout();
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
      .setDesc("Remove files from NAS that no longer exist locally (dangerous)")
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
  }
}
