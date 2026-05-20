import {
  DEFAULT_SETTINGS,
  SynologySyncSettings,
  migrateLoadedSettings,
} from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
  it("has syncIdentityId empty by default (bootstrapped on first load)", () => {
    expect(DEFAULT_SETTINGS.syncIdentityId).toBe("");
  });

  it("keeps File Station as the default sync backend", () => {
    expect(DEFAULT_SETTINGS.syncBackend).toBe("filestation");
  });

  it("has tombstone retention 0 (forever) by default", () => {
    expect(DEFAULT_SETTINGS.tombstoneRetentionDays).toBe(0);
  });

  it("defaults honorTombstoneOnRecreate off (preserve-local wins)", () => {
    expect(DEFAULT_SETTINGS.honorTombstoneOnRecreate).toBe(false);
  });

  it("has a 5s jitter default for the mtime gate (matches Synology 1s mtime resolution + small clock skew)", () => {
    expect(DEFAULT_SETTINGS.tombstoneJitterMs).toBe(5000);
  });

  it("has remoteAbsenceGraceCycles=2 by default", () => {
    expect(DEFAULT_SETTINGS.remoteAbsenceGraceCycles).toBe(2);
  });

  it("keeps deleteOrphans false by default (safe)", () => {
    expect(DEFAULT_SETTINGS.deleteOrphans).toBe(false);
  });

  it("leaves deviceId untouched (it is the DSM 2FA cookie, not sync identity)", () => {
    // deviceId and syncIdentityId are distinct fields with distinct purposes.
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS };
    expect("deviceId" in s).toBe(true);
    expect("syncIdentityId" in s).toBe(true);
    expect(s.deviceId).toBe("");
    expect(s.syncIdentityId).toBe("");
  });

  it("has safe generic defaults for Git-backed sync", () => {
    expect(DEFAULT_SETTINGS.gitRemotePath).toBe("");
    expect(DEFAULT_SETTINGS.gitFileStationRepoPath).toBe("");
    expect(DEFAULT_SETTINGS.gitUseExistingLocalRepo).toBe(false);
    expect(DEFAULT_SETTINGS.gitBranch).toBe("main");
    expect(DEFAULT_SETTINGS.gitAuthorName).toBe("Obsidian Synology Sync");
    expect(DEFAULT_SETTINGS.gitAuthorEmail).toBe("synology-sync@local");
  });
});

describe("migrateLoadedSettings", () => {
  it("rewrites legacy 30000ms jitter to the new 5000ms default", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, tombstoneJitterMs: 30000 };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(true);
    expect(s.tombstoneJitterMs).toBe(5000);
  });

  it("leaves a custom jitter value untouched", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, tombstoneJitterMs: 15000 };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(false);
    expect(s.tombstoneJitterMs).toBe(15000);
  });

  it("leaves the new default untouched", () => {
    const s: SynologySyncSettings = { ...DEFAULT_SETTINGS, tombstoneJitterMs: 5000 };
    const changed = migrateLoadedSettings(s);
    expect(changed).toBe(false);
    expect(s.tombstoneJitterMs).toBe(5000);
  });
});
