#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const obsidianExe = process.env.OBSIDIAN_EXE || "C:\\Program Files\\Obsidian\\Obsidian.exe";
const runRoot = path.resolve(process.env.OBSIDIAN_LIVE_SMOKE_ROOT || path.join(os.tmpdir(), `obsidian-synology-live-smoke-${Date.now()}`));
const vaultDir = path.join(runRoot, "vault");
const userDataDir = path.join(runRoot, "obsidian-user-data");
const bareRepo = path.join(runRoot, "synology-bare.git");
const remoteWorktree = path.join(runRoot, "remote-worktree");
const evidencePath = path.join(runRoot, "evidence.json");
const remotePath = "/live-smoke/VertigoRay.git";
const branch = "main";
const debugPort = Number(process.env.OBSIDIAN_LIVE_SMOKE_DEBUG_PORT || "49229");
const bulkFileCount = Number(process.env.OBSIDIAN_LIVE_SMOKE_FILE_COUNT || "750");

const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "synology-sync");
const settingsPath = path.join(pluginDir, "data.json");
const logPath = path.join(vaultDir, "Synology Sync Logs", "latest-run.md");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return options.trim === false ? result.stdout : result.stdout.trim();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readFileUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

function gitBare(args) {
  return run("git", ["--git-dir", bareRepo, ...args]);
}

function tryGitBare(args) {
  try {
    return gitBare(args);
  } catch {
    return null;
  }
}

function gitShow(filePath) {
  return run("git", ["--git-dir", bareRepo, "show", `${branch}:${filePath}`], { trim: false });
}

function gitTreeFiles() {
  const out = gitBare(["ls-tree", "-r", "--name-only", branch]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function prepareVault() {
  if (fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  fs.copyFileSync(path.join(repoRoot, "manifest.json"), path.join(pluginDir, "manifest.json"));
  fs.copyFileSync(path.join(repoRoot, "main.js"), path.join(pluginDir, "main.js"));
  const styles = path.join(repoRoot, "styles.css");
  if (fs.existsSync(styles)) fs.copyFileSync(styles, path.join(pluginDir, "styles.css"));

  writeJson(path.join(vaultDir, ".obsidian", "community-plugins.json"), ["synology-sync"]);
  writeJson(path.join(vaultDir, ".obsidian", "app.json"), {});
  writeJson(path.join(userDataDir, "obsidian.json"), {
    vaults: {
      "0b5dcc0de5f00d01": {
        path: vaultDir,
        ts: Date.now(),
        open: true,
      },
    },
  });
  writeJson(settingsPath, {
    syncBackend: "git-filestation",
    connectionType: "direct",
    host: "127.0.0.1",
    port: 1,
    https: false,
    username: "live-smoke",
    password: "live-smoke",
    remotePath: "",
    syncInterval: 0,
    conflictStrategy: "newer-wins",
    deleteOrphans: false,
    excludePatterns: "",
    syncOnStartup: false,
    lastSync: 0,
    deviceId: "",
    deviceToken: "",
    syncIdentityId: "live-obsidian-smoke",
    tombstoneRetentionDays: 0,
    honorTombstoneOnRecreate: false,
    tombstoneJitterMs: 5000,
    remoteAbsenceGraceCycles: 2,
    maxFileSizeMb: 100,
    gitFileStationRepoPath: remotePath,
    gitBranch: branch,
    gitAuthorName: "Obsidian Live Smoke",
    gitAuthorEmail: "obsidian-live-smoke@local",
    obsidianConfigPolicy: "notes-only",
    obsidianConfigOptIns: {},
    filenameSanitizeRestrictedChars: ":<>\"/\\|?*",
    filenameSanitizeReplacementChar: "-",
    debugLogEnabled: true,
    quickConnectCandidateCache: [],
    persistSyncLogToVaultNote: true,
  });

  for (let i = 0; i < bulkFileCount; i++) {
    const folder = path.join(vaultDir, "Bulk", String(Math.floor(i / 100)).padStart(2, "0"));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `note-${String(i).padStart(4, "0")}.md`), `# Bulk ${i}\n\nSeed note ${i}\n`);
  }

  run("git", ["init", "--bare", "-b", branch, bareRepo]);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error(`timeout ${url}`));
    });
  });
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else pending.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async eval(expression, timeoutMs = 120000) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }

  close() {
    try { this.ws.close(); } catch {
      // Closing a CDP socket during Obsidian shutdown can race harmlessly.
    }
  }
}

async function waitForTarget() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${debugPort}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Obsidian may still be starting the DevTools endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Obsidian DevTools target did not appear");
}

async function waitFor(cdp, expression, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression, 5000).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function installFakeFileStationExpression() {
  return `
(() => {
  const plugin = app.plugins.plugins["synology-sync"];
  const nodeRequire = globalThis.require || window.require;
  if (!plugin) throw new Error("synology-sync plugin not loaded");
  if (!nodeRequire) throw new Error("Node require is unavailable in Obsidian renderer");
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const remoteRoot = ${JSON.stringify(remotePath)};
  const localRoot = ${JSON.stringify(bareRepo)};
  const normalize = (p) => p.replace(/\\\\/g, "/").replace(/\\/+$/, "") || "/";
  const toLocal = (remote) => {
    const normalized = normalize(remote);
    if (normalized === remoteRoot) return localRoot;
    if (!normalized.startsWith(remoteRoot + "/")) throw new Error("outside fake File Station root: " + remote);
    return path.join(localRoot, ...normalized.slice(remoteRoot.length + 1).split("/"));
  };
  const toRemote = (local) => {
    const rel = path.relative(localRoot, local).split(path.sep).join("/");
    return rel ? remoteRoot + "/" + rel : remoteRoot;
  };
  const arrayBufferFromBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const fakeFs = {
    async logout() {},
    async download(remote) {
      const full = toLocal(remote);
      return arrayBufferFromBuffer(fs.readFileSync(full));
    },
    async upload(destFolder, fileName, content) {
      const folder = toLocal(destFolder);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, fileName), Buffer.from(new Uint8Array(content)));
    },
    async createFolder(folderPath, name) {
      fs.mkdirSync(path.join(toLocal(folderPath), name), { recursive: true });
    },
    async createFolderStrict(folderPath, name) {
      const target = path.join(toLocal(folderPath), name);
      if (fs.existsSync(target)) throw new Error("createFolderStrict target already exists: " + target);
      fs.mkdirSync(target);
    },
    async rename(remote, newName) {
      const full = toLocal(remote);
      fs.renameSync(full, path.join(path.dirname(full), newName));
    },
    async delete(remote) {
      fs.rmSync(toLocal(remote), { recursive: true, force: true });
    },
    async listFolder(remote) {
      const folder = toLocal(remote);
      return fs.readdirSync(folder, { withFileTypes: true }).map((entry) => {
        const full = path.join(folder, entry.name);
        const stat = fs.statSync(full);
        return {
          path: toRemote(full),
          name: entry.name,
          isdir: entry.isDirectory(),
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      });
    },
    async listAllFiles(remote) {
      const out = [];
      const walk = (folder) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const full = path.join(folder, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            const stat = fs.statSync(full);
            out.push({ path: toRemote(full), name: entry.name, isdir: false, size: stat.size, mtime: stat.mtimeMs });
          }
        }
      };
      walk(toLocal(remote));
      return out;
    },
  };
  plugin.settings.syncBackend = "git-filestation";
  plugin.settings.connectionType = "direct";
  plugin.settings.gitFileStationRepoPath = remoteRoot;
  plugin.settings.gitBranch = ${JSON.stringify(branch)};
  plugin.settings.debugLogEnabled = true;
  plugin.settings.persistSyncLogToVaultNote = true;
  plugin.settings.syncOnStartup = false;
  plugin.settings.syncInterval = 0;
  plugin.getFileStation = async () => fakeFs;
  return plugin.saveSettings().then(() => true);
})()
`;
}

function vaultExpression(js) {
  return `(() => ${js})()`;
}

async function runObsidianSync(cdp, label) {
  return await cdp.eval(`
(async () => {
  const plugin = app.plugins.plugins["synology-sync"];
  const start = performance.now();
  await plugin.runSync();
  const elapsedMs = performance.now() - start;
  return { label: ${JSON.stringify(label)}, elapsedMs };
})()
`, 300000);
}

async function createOrModifyVaultFile(cdp, filePath, content) {
  return await cdp.eval(vaultExpression(`
(async () => {
  const filePath = ${JSON.stringify(filePath)};
  const content = ${JSON.stringify(content)};
  const parts = filePath.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? current + "/" + part : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing) await app.vault.modify(existing, content);
  else await app.vault.create(filePath, content);
  return { path: filePath, sha256: ${JSON.stringify(sha256(content))} };
})()
`));
}

async function readVaultFile(cdp, filePath) {
  return await cdp.eval(vaultExpression(`
(async () => {
  const filePath = ${JSON.stringify(filePath)};
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file) return null;
  const content = await app.vault.read(file);
  return { path: filePath, content, sha256: await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)).then((hash) => Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("")) };
})()
`));
}

function commitRemoteChange(filePath, content, message) {
  fs.rmSync(remoteWorktree, { recursive: true, force: true });
  run("git", ["clone", bareRepo, remoteWorktree]);
  run("git", ["config", "user.name", "Live Smoke Remote"], { cwd: remoteWorktree });
  run("git", ["config", "user.email", "live-smoke-remote@local"], { cwd: remoteWorktree });
  const full = path.join(remoteWorktree, ...filePath.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  run("git", ["add", filePath], { cwd: remoteWorktree });
  run("git", ["commit", "-m", message], { cwd: remoteWorktree });
  run("git", ["push", "origin", `HEAD:${branch}`], { cwd: remoteWorktree });
  return {
    ref: gitBare(["rev-parse", `refs/heads/${branch}`]),
    sha256: sha256(content),
  };
}

function snapshotLatestLog(name) {
  const destination = path.join(runRoot, `latest-run-${name}.md`);
  if (!fs.existsSync(logPath)) return { path: null, finalLine: null, fastNoop: false };
  fs.copyFileSync(logPath, destination);
  const text = readFileUtf8(destination);
  const finalLine = text
    .split(/\r?\n/)
    .filter((line) => line.includes("SYNC FINISHED") || line.includes("GIT-OVER-FILE-STATION SYNC FINISHED"))
    .at(-1) || null;
  return {
    path: destination,
    finalLine,
    fastNoop: text.includes("fast no-op: remote ref and local vault metadata unchanged"),
    size: text.length,
  };
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!fs.existsSync(obsidianExe)) throw new Error(`Obsidian executable not found: ${obsidianExe}`);
  if (process.platform === "win32") {
    const running = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process Obsidian -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"], { encoding: "utf8" });
    if (running.stdout.trim() && process.env.OBSIDIAN_LIVE_SMOKE_ALLOW_EXISTING !== "1") {
      throw new Error("Obsidian is already running; close it or set OBSIDIAN_LIVE_SMOKE_ALLOW_EXISTING=1 for an isolated best-effort run");
    }
  }

  prepareVault();
  const startedAt = new Date().toISOString();
  const obsidian = spawn(obsidianExe, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-gpu",
    vaultDir,
  ], {
    detached: false,
    stdio: "ignore",
  });

  let cdp;
  try {
    const target = await waitForTarget();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await waitFor(cdp, "!!globalThis.app && !!app.vault && app.workspace?.layoutReady === true", "Obsidian app ready");
    await cdp.eval(`
(() => {
  const trustButton = Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Trust author and enable plugins"));
  if (trustButton) {
    trustButton.click();
    return true;
  }
  return false;
})()
`, 10000);
    try {
      await waitFor(cdp, "!!app.plugins?.plugins?.['synology-sync']", "Synology Sync plugin loaded");
    } catch (e) {
      const diagnostics = await cdp.eval(`
(() => ({
  appReady: !!globalThis.app,
  vaultName: app?.vault?.getName?.(),
  enabledPlugins: Array.from(app?.plugins?.enabledPlugins || []),
  loadedPlugins: Object.keys(app?.plugins?.plugins || {}),
  manifests: Object.keys(app?.plugins?.manifests || {}),
  safeMode: app?.plugins?.safeMode,
  requireAvailable: !!(globalThis.require || window.require),
  bodyText: document.body?.innerText?.slice(0, 1000),
}))()
`, 10000).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
      throw new Error(`${e.message}\nDiagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
    }
    await cdp.eval(installFakeFileStationExpression());

    const evidence = {
      startedAt,
      runRoot,
      vaultDir,
      bareRepo,
      remotePath,
      branch,
      bulkFileCount,
      steps: {},
    };

    const obsidianFile = "Live/obsidian-to-synology.md";
    const obsidianContent1 = `# Obsidian to Synology\n\ncreated by live Obsidian smoke ${startedAt}\n`;
    evidence.steps.obsidianCreate = await createOrModifyVaultFile(cdp, obsidianFile, obsidianContent1);
    evidence.steps.initialRefBefore = tryGitBare(["rev-parse", "--verify", `refs/heads/${branch}`]);
    evidence.steps.initialSync = await runObsidianSync(cdp, "initial bulk + Obsidian-created file");
    evidence.steps.initialRefAfter = gitBare(["rev-parse", `refs/heads/${branch}`]);
    evidence.steps.initialTreeCount = gitTreeFiles().length;
    const initialRemoteContent = gitShow(obsidianFile);
    evidence.steps.obsidianCreate.remoteSha256 = sha256(initialRemoteContent);
    evidence.logs = { initial: snapshotLatestLog("initial") };
    assertCondition(initialRemoteContent === obsidianContent1, "Obsidian-created file did not land in the bare repo");
    assertCondition(evidence.steps.initialTreeCount >= bulkFileCount + 1, "Bulk initial sync did not publish expected file count");

    const obsidianContent2 = `# Obsidian to Synology\n\nedited inside live Obsidian smoke ${new Date().toISOString()}\n`;
    evidence.steps.obsidianEditRefBefore = evidence.steps.initialRefAfter;
    evidence.steps.obsidianEdit = await createOrModifyVaultFile(cdp, obsidianFile, obsidianContent2);
    evidence.steps.obsidianEditSync = await runObsidianSync(cdp, "single Obsidian edit");
    evidence.steps.obsidianEditRefAfter = gitBare(["rev-parse", `refs/heads/${branch}`]);
    const editedRemoteContent = gitShow(obsidianFile);
    evidence.steps.obsidianEdit.remoteSha256 = sha256(editedRemoteContent);
    evidence.logs.edit = snapshotLatestLog("obsidian-edit");
    assertCondition(evidence.steps.obsidianEditRefAfter !== evidence.steps.obsidianEditRefBefore, "Obsidian edit did not advance the bare repo ref");
    assertCondition(editedRemoteContent === obsidianContent2, "Obsidian edit content did not land in the bare repo");

    const remoteFile = "Live/synology-to-obsidian.md";
    const remoteContent = `# Synology to Obsidian\n\ncommitted directly to the bare repo ${new Date().toISOString()}\n`;
    evidence.steps.remoteCommitRefBefore = evidence.steps.obsidianEditRefAfter;
    evidence.steps.remoteCommit = commitRemoteChange(remoteFile, remoteContent, "Live smoke remote materialization");
    evidence.steps.remoteMaterializeSync = await runObsidianSync(cdp, "direct bare commit materialization");
    evidence.steps.remoteMaterializeRefAfter = gitBare(["rev-parse", `refs/heads/${branch}`]);
    evidence.steps.remoteMaterializedVaultFile = await readVaultFile(cdp, remoteFile);
    evidence.logs.remoteMaterialize = snapshotLatestLog("remote-materialize");
    assertCondition(evidence.steps.remoteCommit.ref !== evidence.steps.remoteCommitRefBefore, "Direct bare commit did not advance the ref");
    assertCondition(evidence.steps.remoteMaterializedVaultFile?.content === remoteContent, "Direct bare commit did not materialize into Obsidian");

    evidence.steps.noopRefBefore = evidence.steps.remoteMaterializeRefAfter;
    evidence.steps.noopSync = await runObsidianSync(cdp, "restored-state no-op");
    evidence.steps.noopRefAfter = gitBare(["rev-parse", `refs/heads/${branch}`]);
    evidence.logs.noop = snapshotLatestLog("noop");
    assertCondition(evidence.steps.noopRefAfter === evidence.steps.noopRefBefore, "No-op sync unexpectedly changed the bare repo ref");
    assertCondition(evidence.logs.noop.fastNoop, "No-op live Obsidian run did not hit the fast no-op path");

    evidence.finishedAt = new Date().toISOString();
    writeJson(evidencePath, evidence);
    console.log(JSON.stringify({
      evidencePath,
      runRoot,
      initialSyncMs: evidence.steps.initialSync.elapsedMs,
      obsidianEditSyncMs: evidence.steps.obsidianEditSync.elapsedMs,
      remoteMaterializeSyncMs: evidence.steps.remoteMaterializeSync.elapsedMs,
      noopSyncMs: evidence.steps.noopSync.elapsedMs,
      initialTreeCount: evidence.steps.initialTreeCount,
      initialRefAfter: evidence.steps.initialRefAfter,
      obsidianEditRefAfter: evidence.steps.obsidianEditRefAfter,
      remoteCommitRef: evidence.steps.remoteCommit.ref,
      noopFastPath: evidence.logs.noop.fastNoop,
    }, null, 2));
  } finally {
    if (cdp) cdp.close();
    if (!obsidian.killed) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(obsidian.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        obsidian.kill("SIGTERM");
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
