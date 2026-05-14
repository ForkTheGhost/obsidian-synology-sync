const MAX_ENTRIES = 200;
const entries: string[] = [];

export function debugLog(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23);
  const entry = `[${ts}] ${msg}`;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.log(`[SynologySync] ${msg}`);
}

export function getDebugLog(): string {
  return entries.join("\n");
}

export function clearDebugLog(): void {
  entries.length = 0;
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
