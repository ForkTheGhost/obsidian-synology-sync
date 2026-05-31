import { App } from "obsidian";
import SynologySync from "../src/main";
import { DEFAULT_SETTINGS, SynologySyncSettings } from "../src/settings";

jest.mock("../src/filestation", () => {
  return {
    FileStation: jest.fn().mockImplementation(() => ({
      login: jest.fn().mockResolvedValue({
        sid: "sid",
        deviceId: "secure-device-id",
        deviceToken: "secure-device-token",
      }),
      logout: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

jest.mock("../src/git-filestation-mobile", () => {
  return {
    MobileGitFileStationSyncEngine: jest.fn(),
  };
});

function buildPlugin(settings: Partial<SynologySyncSettings> = {}) {
  const plugin = new SynologySync();
  plugin.app = new App() as never;
  plugin.settings = { ...DEFAULT_SETTINGS, ...settings };
  plugin.saveSettings = jest.fn().mockResolvedValue(undefined);
  return plugin as SynologySync & { saveSettings: jest.Mock };
}

describe("DSM secret storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("migrates legacy plaintext credentials into Obsidian SecretStorage", async () => {
    const plugin = buildPlugin();
    plugin.loadData = jest.fn().mockResolvedValue({
      password: "legacy-password",
      deviceId: "legacy-device-id",
      deviceToken: "legacy-device-token",
    });

    await plugin.loadSettings();

    expect(plugin.getDsmPassword()).toBe("legacy-password");
    expect(plugin.getDsmDeviceId()).toBe("legacy-device-id");
    expect(plugin.getDsmDeviceToken()).toBe("legacy-device-token");
    expect(plugin.settings.password).toBe("");
    expect(plugin.settings.deviceId).toBe("");
    expect(plugin.settings.deviceToken).toBe("");
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("falls back to plugin settings when SecretStorage is unavailable", async () => {
    const plugin = buildPlugin({
      password: "legacy-password",
      deviceId: "legacy-device-id",
      deviceToken: "legacy-device-token",
    });
    plugin.app = { vault: { adapter: {} } } as never;

    expect(plugin.hasSecretStorageSupport()).toBe(false);
    expect(plugin.getDsmPassword()).toBe("legacy-password");
    expect(plugin.getDsmDeviceToken()).toBe("legacy-device-token");

    await plugin.setDsmPassword("new-password");
    await plugin.clearDsmDeviceTrust();

    expect(plugin.settings.password).toBe("new-password");
    expect(plugin.settings.deviceId).toBe("");
    expect(plugin.settings.deviceToken).toBe("");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("stores trusted DSM device tokens outside plugin settings when SecretStorage is available", async () => {
    const plugin = buildPlugin({
      connectionType: "direct",
      host: "nas.local",
      username: "ray",
    });

    const result = await plugin.trustDevice("123456");

    expect(result.deviceToken).toBe("secure-device-token");
    expect(plugin.getDsmDeviceId()).toBe("secure-device-id");
    expect(plugin.getDsmDeviceToken()).toBe("secure-device-token");
    expect(plugin.settings.deviceId).toBe("");
    expect(plugin.settings.deviceToken).toBe("");
  });
});
