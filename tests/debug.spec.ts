import { beginDebugSync, clearDebugLog, debugLog, endDebugSync, formatErrorForDebug, formatRuntimeDiagnostics, getDebugLog, getDebugLogSnippet, getRuntimeDiagnostics, redactSensitiveLogText } from "../src/debug";

describe("debug logging", () => {
  beforeEach(() => clearDebugLog());

  it("captures useful details from command-like errors", () => {
    const err = new Error("command failed") as Error & { stderr: string; stdout: string; code: number };
    err.stderr = "fatal: nope";
    err.stdout = "partial output";
    err.code = 128;

    const formatted = formatErrorForDebug(err);

    expect(formatted).toContain("Error: command failed");
    expect(formatted).toContain("code=128");
    expect(formatted).toContain("stderr=fatal: nope");
    expect(formatted).toContain("stdout=partial output");
  });

  it("keeps failure messages in the in-plugin debug log", () => {
    debugLog(`SYNC FAILED: ${formatErrorForDebug(new Error("boom"))}`);

    expect(getDebugLog()).toContain("SYNC FAILED: Error: boom");
  });

  it("redacts sensitive values before logs are persisted to a note", () => {
    const redacted = redactSensitiveLogText(
      "AUTH password=hunter2 sid=abc123 deviceToken=token123 url=/entry.cgi?passwd=secret&synotoken=syno",
    );

    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("token123");
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("password=***");
    expect(redacted).toContain("sid=***");
    expect(redacted).toContain("deviceToken=***");
  });

  it("generates runtime diagnostics in copied snippets when no runtime entry is in the log", () => {
    debugLog("SYNC FAILED: Error: boom");

    const snippet = getDebugLogSnippet({ vault: { adapter: {} } });

    expect(snippet).toContain("RUNTIME: pluginVersion=");
    expect(snippet).toContain("hasVaultBasePath=false");
    expect(snippet).toContain("SYNC FAILED: Error: boom");
    expect(getDebugLog()).not.toContain("RUNTIME:");
  });

  it("copies the full last sync block in the full log but only runtime plus last five lines in snippets", () => {
    debugLog("PREVIOUS SYNC LINE");
    beginDebugSync({ vault: { adapter: {} } });
    for (let i = 0; i < 12; i++) debugLog(`current sync line ${i}`);
    debugLog("SYNC FINISHED: SUCCESS — 0 uploaded, 0 downloaded, 0 deleted, 0 conflicts, 0 errors");
    endDebugSync();
    debugLog("NEXT SYNC LINE NOT INCLUDED");

    const fullLog = getDebugLog();
    const snippet = getDebugLogSnippet({ vault: { adapter: {} } });

    expect(fullLog).toContain("RUNTIME: pluginVersion=");
    expect(fullLog).toContain("current sync line 0");
    expect(fullLog).toContain("current sync line 11");
    expect(fullLog).toContain("SYNC FINISHED: SUCCESS");
    expect(fullLog).not.toContain("PREVIOUS SYNC LINE");
    expect(fullLog).not.toContain("NEXT SYNC LINE NOT INCLUDED");
    expect(snippet).toContain("RUNTIME: pluginVersion=");
    expect(snippet).not.toContain("current sync line 0");
    expect(snippet).toContain("current sync line 8");
    expect(snippet).toContain("current sync line 11");
    expect(snippet).toContain("SYNC FINISHED: SUCCESS");
    expect(snippet.split("\n")).toHaveLength(6);
  });
});


describe("runtime diagnostics", () => {
  it("reports whether the vault exposes a desktop filesystem path", () => {
    const d = getRuntimeDiagnostics({ vault: { adapter: { getBasePath: () => "/vault" } } });
    expect(d.hasVaultBasePath).toBe(true);
    expect(d.hostFingerprint).toMatch(/^h_[0-9a-f]{8}$/);
    expect(d.hostFingerprintSource).toBe("vaultBasePath");
    expect(formatRuntimeDiagnostics(d)).toContain("pluginVersion=");
    expect(formatRuntimeDiagnostics(d)).toContain("hasVaultBasePath=true");
    expect(formatRuntimeDiagnostics(d)).toContain("hostFingerprint=");
  });

  it("reports missing filesystem path for mobile-like adapters", () => {
    const d = getRuntimeDiagnostics({ vault: { adapter: {} } });
    expect(d.hasVaultBasePath).toBe(false);
    expect(d.hostFingerprint).toMatch(/^(h_[0-9a-f]{8}|unknown)$/);
    expect(formatRuntimeDiagnostics(d)).toContain("platform=");
    expect(formatRuntimeDiagnostics(d)).toContain("hostFingerprintSource=");
  });
});


describe("host fingerprint", () => {
  it("uses the same fingerprint for the same vault path without logging the path", () => {
    const app = { vault: { adapter: { getBasePath: () => "/Users/ray/Vault" } } };
    const a = getRuntimeDiagnostics(app);
    const b = getRuntimeDiagnostics(app);
    expect(a.hostFingerprint).toBe(b.hostFingerprint);
    expect(formatRuntimeDiagnostics(a)).not.toContain("/Users/ray/Vault");
  });
});
