export const DEFAULT_GIT_EXCLUDES = [
  // Notes-first default, modeled after Obsidian Sync's selective config strategy:
  // sync note content by default while keeping volatile/device-local Obsidian state local.
  ".obsidian/app.json",
  ".obsidian/appearance.json",
  ".obsidian/graph.json",
  ".obsidian/workspace*",
  ".obsidian/plugins/*/data.json",
  ".obsidian/plugins/synology-sync/",
  ".trash/",
  ".sync-tombstones/",
  "node_modules/",
];

export const OBSIDIAN_CONFIG_SYNC_POLICY = [
  { category: "workspace/UI layout", pattern: ".obsidian/workspace*", defaultBehavior: "device-local" },
  { category: "app/appearance/graph state", pattern: ".obsidian/{app,appearance,graph}.json", defaultBehavior: "device-local" },
  { category: "plugin data", pattern: ".obsidian/plugins/*/data.json", defaultBehavior: "excluded unless explicitly reviewed" },
  { category: "plugin list/core plugin list", pattern: ".obsidian/{community-plugins,core-plugins}.json", defaultBehavior: "opt-in shared setting" },
  { category: "hotkeys/snippets", pattern: ".obsidian/hotkeys.json and .obsidian/snippets/", defaultBehavior: "opt-in shared setting" },
];

export type ObsidianConfigSyncPolicy = "notes-only" | "selected-settings" | "full-config";

export interface ObsidianConfigOptIns {
  appearance?: boolean;
  pluginLists?: boolean;
  hotkeys?: boolean;
  snippets?: boolean;
  reviewedPluginConfig?: boolean;
}

export function buildGitExcludes(policy: ObsidianConfigSyncPolicy = "notes-only", optIns: ObsidianConfigOptIns = {}): string[] {
  if (policy === "full-config") {
    return [
      ".obsidian/plugins/synology-sync/",
      ".trash/",
      ".sync-tombstones/",
      "node_modules/",
    ];
  }

  const excludes = [...DEFAULT_GIT_EXCLUDES];
  if (policy === "selected-settings") {
    if (optIns.appearance) removeAll(excludes, [".obsidian/app.json", ".obsidian/appearance.json", ".obsidian/graph.json"]);
    if (optIns.pluginLists) removeAll(excludes, [".obsidian/community-plugins.json", ".obsidian/core-plugins.json", ".obsidian/core-plugins-migration.json"]);
    if (optIns.hotkeys) removeAll(excludes, [".obsidian/hotkeys.json"]);
    if (optIns.snippets) removeAll(excludes, [".obsidian/snippets/"]);
    if (optIns.reviewedPluginConfig) removeAll(excludes, [".obsidian/plugins/*/data.json"]);
  }
  return excludes;
}

function removeAll(values: string[], remove: string[]): void {
  for (const item of remove) {
    const idx = values.indexOf(item);
    if (idx >= 0) values.splice(idx, 1);
  }
}

export function isGitIgnoredPath(path: string, patterns: string[]): boolean {
  const normalized = normalizeGitPath(path);
  return patterns.some((pattern) => matchesGitIgnorePattern(normalized, pattern));
}

export function matchesGitIgnorePattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeGitPath(path);
  let normalizedPattern = normalizeGitPath(pattern.trim());
  if (!normalizedPattern || normalizedPattern.startsWith("#")) return false;
  if (normalizedPattern.startsWith("!")) return false;

  const directoryOnly = normalizedPattern.endsWith("/");
  if (directoryOnly) normalizedPattern = normalizedPattern.replace(/\/+$/, "");

  const anchored = normalizedPattern.startsWith("/");
  if (anchored) normalizedPattern = normalizedPattern.replace(/^\/+/, "");

  const candidates = anchored || normalizedPattern.includes("/")
    ? [normalizedPath]
    : pathSuffixCandidates(normalizedPath);

  return candidates.some((candidate) => {
    if (directoryOnly) {
      return candidate === normalizedPattern || candidate.startsWith(`${normalizedPattern}/`);
    }
    return matchSegments(splitPath(candidate), splitPath(normalizedPattern));
  });
}

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function pathSuffixCandidates(path: string): string[] {
  const parts = splitPath(path);
  return parts.map((_, idx) => parts.slice(idx).join("/"));
}

function matchSegments(pathParts: string[], patternParts: string[]): boolean {
  if (patternParts.length === 0) return pathParts.length === 0;
  const [pattern, ...restPattern] = patternParts;
  if (pattern === "**") {
    if (restPattern.length === 0) return true;
    for (let i = 0; i <= pathParts.length; i++) {
      if (matchSegments(pathParts.slice(i), restPattern)) return true;
    }
    return false;
  }
  if (pathParts.length === 0) return false;
  return matchSegment(pathParts[0], pattern) && matchSegments(pathParts.slice(1), restPattern);
}

function matchSegment(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(value);
}
