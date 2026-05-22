import manifest from "../manifest.json";

const MAX_ENTRIES = 200;
const entries: string[] = [];
const lastSyncEntries: string[] = [];
let activeSyncEntries: string[] | null = null;
const listeners = new Set<() => void>();

function formatDebugEntry(msg: string): string {
  const ts = new Date().toISOString().substring(11, 23);
  return `[${ts}] ${msg}`;
}

export function debugLog(msg: string): void {
  const entry = formatDebugEntry(msg);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (activeSyncEntries) activeSyncEntries.push(entry);
  console.log(`[SynologySync] ${msg}`);
  listeners.forEach((listener) => {
    try { listener(); } catch { /* ignore listener errors */ }
  });
}

export function getDebugLog(): string {
  const syncEntries = activeSyncEntries ?? lastSyncEntries;
  return (syncEntries.length > 0 ? syncEntries : entries).join("\n");
}

export function getDebugLogSnippet(app?: unknown): string {
  const logEntries = activeSyncEntries ?? (lastSyncEntries.length > 0 ? lastSyncEntries : entries);
  const runtime = [...logEntries, ...entries].reverse().find((entry) => entry.includes("RUNTIME:"))
    ?? formatDebugEntry(`RUNTIME: ${formatRuntimeDiagnostics(getRuntimeDiagnostics(app))}`);
  const tail = logEntries.filter((entry) => entry !== runtime).slice(-5);
  return [runtime, ...tail].join("\n");
}

export function beginDebugSync(app?: unknown): void {
  activeSyncEntries = [];
  debugLog(`RUNTIME: ${formatRuntimeDiagnostics(getRuntimeDiagnostics(app))}`);
}

export function endDebugSync(): void {
  if (activeSyncEntries) {
    lastSyncEntries.length = 0;
    lastSyncEntries.push(...activeSyncEntries);
    activeSyncEntries = null;
  }
}

export function clearDebugLog(): void {
  entries.length = 0;
  lastSyncEntries.length = 0;
  activeSyncEntries = null;
  listeners.forEach((listener) => {
    try { listener(); } catch { /* ignore listener errors */ }
  });
}

export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function redact(s: string | undefined, showChars: number = 4): string {
  if (!s) return "(empty)";
  if (s.length <= showChars) return "***";
  return s.substring(0, showChars) + "***(" + s.length + " chars)";
}


export function formatErrorForDebug(error: unknown): string {
  if (error instanceof Error) {
    const parts = [`${error.name}: ${error.message}`];
    const maybe = error as Error & { stderr?: unknown; stdout?: unknown; code?: unknown };
    if (maybe.code !== undefined) parts.push(`code=${String(maybe.code)}`);
    if (typeof maybe.stderr === "string" && maybe.stderr.trim()) parts.push(`stderr=${maybe.stderr.trim()}`);
    if (typeof maybe.stdout === "string" && maybe.stdout.trim()) parts.push(`stdout=${maybe.stdout.trim()}`);
    if (error.stack) parts.push(`stack=${error.stack}`);
    return parts.join(" | ");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

let runtimeLogged = false;

export interface RuntimeDiagnostics {
  pluginVersion: string;
  platform: string;
  isDesktop: boolean | string;
  isMobile: boolean | string;
  isIosApp: boolean | string;
  isMobileApp: boolean | string;
  userAgent: string;
  hasVaultBasePath: boolean;
  hostFingerprint: string;
  hostFingerprintSource: string;
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hostFingerprint(app?: unknown): { value: string; source: string } {
  const adapter = (app as { vault?: { adapter?: { getBasePath?: () => string } } } | undefined)?.vault?.adapter;
  if (typeof adapter?.getBasePath === "function") {
    try {
      const basePath = adapter.getBasePath();
      if (basePath) return { value: `h_${fnv1a32(basePath)}`, source: "vaultBasePath" };
    } catch {
      // Fall through to browser/mobile identifiers.
    }
  }

  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const parts = [nav?.platform || "", nav?.userAgent || "", nav?.language || "", String(nav?.maxTouchPoints ?? "")].join("|");
  return { value: parts.trim() ? `h_${fnv1a32(parts)}` : "unknown", source: "runtimeProfile" };
}

export function getRuntimeDiagnostics(app?: unknown): RuntimeDiagnostics {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const obsidianPlatform = (globalThis as unknown as { Platform?: Record<string, unknown> }).Platform;
  const adapter = (app as { vault?: { adapter?: { getBasePath?: unknown } } } | undefined)?.vault?.adapter;
  const fp = hostFingerprint(app);
  return {
    pluginVersion: manifest.version || "unknown",
    platform: nav?.platform || "unknown",
    isDesktop: obsidianPlatform?.isDesktop ?? "unknown",
    isMobile: obsidianPlatform?.isMobile ?? "unknown",
    isIosApp: obsidianPlatform?.isIosApp ?? "unknown",
    isMobileApp: obsidianPlatform?.isMobileApp ?? "unknown",
    userAgent: nav?.userAgent || "unknown",
    hasVaultBasePath: typeof adapter?.getBasePath === "function",
    hostFingerprint: fp.value,
    hostFingerprintSource: fp.source,
  };
}

export function formatRuntimeDiagnostics(d: RuntimeDiagnostics): string {
  return `pluginVersion=${d.pluginVersion} platform=${d.platform} obsidianDesktop=${d.isDesktop} obsidianMobile=${d.isMobile} iosApp=${d.isIosApp} mobileApp=${d.isMobileApp} hasVaultBasePath=${d.hasVaultBasePath} hostFingerprint=${d.hostFingerprint} hostFingerprintSource=${d.hostFingerprintSource} userAgent=${d.userAgent}`;
}

export function logRuntimeDiagnostics(app?: unknown, force = false): void {
  if (runtimeLogged && !force) return;
  runtimeLogged = true;
  debugLog(`RUNTIME: ${formatRuntimeDiagnostics(getRuntimeDiagnostics(app))}`);
}
