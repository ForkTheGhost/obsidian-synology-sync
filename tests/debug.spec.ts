import { clearDebugLog, debugLog, formatErrorForDebug, formatRuntimeDiagnostics, getDebugLog, getRuntimeDiagnostics } from "../src/debug";

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
});


describe("runtime diagnostics", () => {
  it("reports whether the vault exposes a desktop filesystem path", () => {
    const d = getRuntimeDiagnostics({ vault: { adapter: { getBasePath: () => "/vault" } } });
    expect(d.hasVaultBasePath).toBe(true);
    expect(formatRuntimeDiagnostics(d)).toContain("hasVaultBasePath=true");
  });

  it("reports missing filesystem path for mobile-like adapters", () => {
    const d = getRuntimeDiagnostics({ vault: { adapter: {} } });
    expect(d.hasVaultBasePath).toBe(false);
    expect(formatRuntimeDiagnostics(d)).toContain("platform=");
  });
});
