import { TFile, TFolder, Vault } from "obsidian";
import { FileStation } from "./filestation";
import { debugLog } from "./debug";
import { SyncResult } from "./sync";
import { buildGitExcludes, classifyGitConflict, findInvalidLocalFilesystemPaths, invalidLocalFilesystemPathError, nestedGitRepoError } from "./git-sync";

import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import pako from "pako";

const globalScope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalScope.Buffer) globalScope.Buffer = Buffer;

export interface MobileGitFileStationSyncOptions {
  remotePath: string;
  branch: string;
  syncIdentityId: string;
  authorName: string;
  authorEmail: string;
}

type FsData = Uint8Array;

type NodeLikeStat = {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
};

type FsNode =
  | { type: "dir"; children: Map<string, FsNode>; mtimeMs: number; ctimeMs: number; mode: number }
  | { type: "file"; data: FsData; mtimeMs: number; ctimeMs: number; mode: number };

const DEFAULT_GIT_EXCLUDES = buildGitExcludes();
const WORKDIR = "/vault";
const GITDIR = "/vault/.git";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Browser/mobile Git-over-File-Station engine.
 *
 * It intentionally avoids Obsidian desktop-only getBasePath(), Node fs, and
 * native git. The vault and NAS bare repo are mirrored into an in-memory FS,
 * isomorphic-git performs the Git operations, and only changed checkout files
 * are written back through Obsidian's Vault adapter.
 */
export class MobileGitFileStationSyncEngine {
  private vault: Vault;
  private fs: FileStation;
  private opts: MobileGitFileStationSyncOptions;
  private memfs = new MemoryFs();
  private cache: Record<string, unknown> = {};

  constructor(vault: Vault, fs: FileStation, opts: MobileGitFileStationSyncOptions) {
    this.vault = vault;
    this.fs = fs;
    this.opts = {
      ...opts,
      remotePath: normalizeRemotePath(opts.remotePath),
      branch: opts.branch.trim() || "main",
      authorName: opts.authorName.trim() || "Obsidian Synology Sync",
      authorEmail: opts.authorEmail.trim() || "synology-sync@local",
    };
  }

  async sync(): Promise<SyncResult> {
    const result = emptyResult();
    debugLog("[git-filestation-mobile] starting pure JS Git sync over File Station");

    await this.runPhase("load vault", () => this.loadVaultIntoMemory());
    await this.runPhase("ensure local repo", () => this.ensureLocalRepo());
    await this.runPhase("configure local repo", () => this.configureLocalRepo());

    const hadUserFilesAtStart = this.localHasUserFiles();
    const workdirFilesAtStart = await this.listWorkdirFiles();
    const hiddenSystemFilesAtStart = this.hiddenSystemVaultFilesAtStart(workdirFilesAtStart);
    const initialLocalFiles = await this.snapshotInitialLocalFileBytes(workdirFilesAtStart);
    const hadLocalCommitsBeforeRemoteImport = await this.localHasCommits();

    await this.runPhase("download remote bare repo", () => this.downloadRemoteBareRepoIfPresent());
    await this.runPhase("verify downloaded Git store", () => this.verifyDownloadedGitStore());
    await this.runPhase("ensure remote configured", () => this.ensureRemoteConfigured());

    const remoteHadCommits = await this.remoteHasCommits();
    const localHadCommits = hadLocalCommitsBeforeRemoteImport;

    const invalidRemotePaths = await this.runPhase("inspect remote tree", () => this.invalidRemotePathsForLocalCheckout());
    if (invalidRemotePaths.length > 0) {
      result.errors.push(invalidLocalFilesystemPathError(invalidRemotePaths));
      return result;
    }

    const nestedRepos = this.findNestedGitRepositories();
    if (nestedRepos.length > 0) {
      result.errors.push(nestedGitRepoError(nestedRepos));
      return result;
    }

    // Important: after downloading the remote bare repo into .git, HEAD may be
    // resolvable even though the mobile workdir has not been populated yet.
    // Treat an empty Obsidian/workdir + existing remote as a pure first pull and
    // materialize the remote tree before status/merge logic can mistake missing
    // workdir files for local deletes.
    if (remoteHadCommits && !hadUserFilesAtStart && workdirFilesAtStart.length === hiddenSystemFilesAtStart.length) {
      if (hiddenSystemFilesAtStart.length > 0) debugLog(`[git-filestation-mobile] treating vault as empty except hidden system files: ${hiddenSystemFilesAtStart.join(", ")}`);
      const beforeSnapshot = await this.runPhase("snapshot workdir", () => this.snapshotWorkdirFiles());
      const remoteFiles = await this.runPhase("list remote files", () => this.remoteTreeFiles());
      await this.runPhase("checkout remote", () => this.checkoutRemote());
      await this.runPhase("materialize remote files", () => this.materializeRemoteFiles(remoteFiles, result));
      // Direct materialization already writes every remote file through Obsidian's vault API.
      // Do not immediately run applyCheckoutChanges against the original empty snapshot: on
      // mobile, getAbstractFileByPath() may lag just-created files and a second createBinary()
      // can double-touch the same path.
      return result;
    }

    const beforeSnapshot = await this.runPhase("snapshot workdir", () => this.snapshotWorkdirFiles());

    if (!localHadCommits && remoteHadCommits) {
      const remoteFiles = await this.runPhase("list remote files", () => this.remoteTreeFiles());
      if (!hadUserFilesAtStart) {
        if (hiddenSystemFilesAtStart.length > 0) debugLog(`[git-filestation-mobile] treating vault as empty except hidden system files: ${hiddenSystemFilesAtStart.join(", ")}`);
        await this.runPhase("checkout remote", () => this.checkoutRemote());
        await this.runPhase("materialize remote files", () => this.materializeRemoteFiles(remoteFiles, result));
        // Direct materialization already writes every remote file through Obsidian's vault API.
        // Do not immediately run applyCheckoutChanges against the original empty snapshot: on
        // mobile, getAbstractFileByPath() may lag just-created files and a second createBinary()
        // can double-touch the same path.
        return result;
      }

      // First sync into a non-empty mobile vault must not let starter/local files replace
      // the established remote vault. Anchor the local branch to the remote first, materialize
      // the remote tree, then add the starter files back as conflict copies. This preserves
      // local work while keeping remote history as the source of truth.
      await this.runPhase("checkout remote", () => this.checkoutRemote());
      await this.runPhase("materialize remote files", () => this.materializeRemoteFiles(remoteFiles, result));
      await this.runPhase("materialize pre-sync local copies", () => this.materializeInitialLocalCopies(initialLocalFiles, result));
      if (result.conflicts.length > 0) await this.runPhase("commit local conflict copies", () => this.commitLocalChanges(`Preserve local conflict copies from ${this.opts.syncIdentityId}`, false));
      await this.runPhase("push local branch", () => this.pushWithRetry());
      await this.runPhase("upload bare repo mirror", () => this.uploadBareRepoMirror());
      return result;
    }

    const localChanged = await this.runPhase("detect local changes", () => this.changedFiles());
    const preserveInitialLocalFiles = false;
    const preMergeLocalChanged = new Set<string>();

    const needsBootstrapCommit = !localHadCommits && !remoteHadCommits;
    if (localChanged.length > 0 || needsBootstrapCommit) {
      await this.runPhase("commit local changes", () => this.commitLocalChanges(
        needsBootstrapCommit ? "Initialize Obsidian vault sync" : `Sync from ${this.opts.syncIdentityId}`,
        needsBootstrapCommit,
      ));
      result.uploaded.push(...localChanged);
    }

    if (remoteHadCommits) {
      const remoteChanged = await this.runPhase("detect remote changes", () => this.remoteChangedFiles());
      await this.runPhase("merge remote", () => this.mergeRemote(!localHadCommits && hadUserFilesAtStart));
      if (!localHadCommits) await this.runPhase("checkout merged remote", () => this.checkoutRemote());
      result.downloaded.push(...remoteChanged);

      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        await this.runPhase("materialize conflict copies", () => this.materializeConflictCopies(conflicts, result));
        result.conflicts.push(...conflicts);
        result.errors.push({
          path: "<git-merge>",
          error: conflicts.some((p) => p.startsWith(".obsidian/"))
            ? classifyGitConflict(conflicts.find((p) => p.startsWith(".obsidian/")) || conflicts[0]).message
            : "Merge conflicts need to be resolved before Git sync can push.",
        });
        await this.runPhase("apply checkout changes", () => this.applyCheckoutChanges(beforeSnapshot, result));
        return result;
      }
    }

    if (preserveInitialLocalFiles) {
      await this.runPhase("materialize pre-merge local copies", () => this.materializePreMergeLocalCopies(preMergeLocalChanged, beforeSnapshot, result));
      if (preMergeLocalChanged.size > 0) await this.runPhase("commit conflict copies", () => this.commitLocalChanges(`Preserve local conflict copies from ${this.opts.syncIdentityId}`, false));
    }
    await this.runPhase("push local branch", () => this.pushWithRetry());
    await this.runPhase("apply checkout changes", () => this.applyCheckoutChanges(beforeSnapshot, result));
    await this.runPhase("upload bare repo mirror", () => this.uploadBareRepoMirror());
    return result;
  }


  private async runPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    debugLog(`[git-filestation-mobile] phase: ${phase}`);
    try {
      return await fn();
    } catch (e) {
      debugLog(`[git-filestation-mobile] phase failed: ${phase}: ${(e as Error).message}`);
      throw e;
    }
  }

  private async verifyDownloadedGitStore(): Promise<void> {
    const objectRoot = `${GITDIR}/objects`;
    const files = await this.listMemFiles(objectRoot).catch(() => [] as string[]);
    const rels = files.map((abs) => abs.slice(GITDIR.length + 1)).sort();
    if (rels.length === 0) {
      debugLog("[git-filestation-mobile] downloaded Git store is empty; remote will initialize if no refs are present");
      return;
    }
    const looseObjects = rels.filter((rel) => /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/i.test(rel));
    const packFiles = rels.filter((rel) => /^objects\/pack\/pack-[0-9a-f]{40}\.pack$/i.test(rel));
    const idxFiles = rels.filter((rel) => /^objects\/pack\/pack-[0-9a-f]{40}\.idx$/i.test(rel));
    const otherPackEntries = rels.filter((rel) => rel.startsWith("objects/pack/") && !packFiles.includes(rel) && !idxFiles.includes(rel));
    debugLog(`[git-filestation-mobile] downloaded Git store loose=${looseObjects.length} pack=${packFiles.length} idx=${idxFiles.length} otherPack=${otherPackEntries.length}`);

    for (const rel of looseObjects) {
      const oid = rel.slice("objects/".length).replace("/", "");
      try {
        const bytes = await this.readMemBytes(`${GITDIR}/${rel}`);
        verifyGitLooseObjectBytes(bytes, oid, rel);
      } catch (e) {
        const bytes = await this.readMemBytes(`${GITDIR}/${rel}`).catch(() => new Uint8Array());
        const prefix = hexPrefix(bytes, 32);
        const hash = fnv1a32(bytes);
        throw new Error(`remote Git loose object failed oid=${oid} path=${rel} bytes=${bytes.byteLength} prefix32=${prefix} fnv1a=${hash}: ${(e as Error).message}`);
      }
    }

    for (const packRel of packFiles) {
      const packBytes = await this.readMemBytes(`${GITDIR}/${packRel}`);
      const packInfo = await verifyGitPackBytes(packBytes, packRel);
      const base = packRel.slice(0, -".pack".length);
      const idxRel = `${base}.idx`;
      if (!idxFiles.includes(idxRel)) throw new Error(`remote Git pack missing idx pack=${packRel} expected=${idxRel}`);
      const idxBytes = await this.readMemBytes(`${GITDIR}/${idxRel}`);
      const idxInfo = await verifyGitPackIndexBytes(idxBytes, idxRel, packInfo.packSha);
      if (idxInfo.objectCount !== packInfo.objectCount) {
        throw new Error(`remote Git pack/idx object count mismatch pack=${packRel} packCount=${packInfo.objectCount} idx=${idxRel} idxCount=${idxInfo.objectCount}`);
      }
      debugLog(`[git-filestation-mobile] verified pack ${packRel} bytes=${packBytes.byteLength} objects=${packInfo.objectCount} packSha=${packInfo.packSha} idx=${idxRel} idxBytes=${idxBytes.byteLength}`);
    }

    for (const idxRel of idxFiles) {
      const packRel = `${idxRel.slice(0, -".idx".length)}.pack`;
      if (!packFiles.includes(packRel)) throw new Error(`remote Git idx missing pack idx=${idxRel} expected=${packRel}`);
    }

    await this.probeDownloadedGitStore(idxFiles);
  }

  private async ensureLocalRepo(): Promise<void> {
    if (await this.pathExists(GITDIR)) return;
    await git.init({ fs: this.memfs.client, dir: WORKDIR, defaultBranch: this.opts.branch });
  }

  private async configureLocalRepo(): Promise<void> {
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: "user.name", value: this.opts.authorName });
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: "user.email", value: this.opts.authorEmail });
    await this.writeInfoExclude();
  }

  private async ensureRemoteConfigured(): Promise<void> {
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: "remote.origin.url", value: GITDIR });
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: `branch.${this.opts.branch}.remote`, value: "origin" });
    await git.setConfig({ fs: this.memfs.client, dir: WORKDIR, path: `branch.${this.opts.branch}.merge`, value: `refs/heads/${this.opts.branch}` });
  }

  private async downloadRemoteBareRepoIfPresent(): Promise<void> {
    let files;
    try {
      files = await this.listAllRemoteGitFilesStrict(this.opts.remotePath);
    } catch (e) {
      const message = (e as Error).message;
      if (!message.startsWith(`Could not list remote Git folder ${this.opts.remotePath}:`)) throw e;
      debugLog(`[git-filestation-mobile] remote bare repo not found or unreadable; will initialize: ${message}`);
      return;
    }

    for (const file of files) {
      if (file.isdir) continue;
      const rel = relativeRemotePath(this.opts.remotePath, file.path);
      if (!rel || shouldSkipRemoteGitFile(rel)) continue;
      await this.writeMemFile(`${GITDIR}/${rel}`, new Uint8Array(await this.fs.download(file.path)));
    }
  }

  private async listAllRemoteGitFilesStrict(basePath: string): Promise<Array<{ path: string; isdir: boolean }>> {
    const station = this.fs as unknown as { listFolder?: (path: string) => Promise<Array<{ path: string; isdir: boolean }>>; listAllFiles?: (path: string) => Promise<Array<{ path: string; isdir: boolean }>> };
    if (typeof station.listFolder !== "function") {
      try {
        return station.listAllFiles ? await station.listAllFiles(basePath) : [];
      } catch (e) {
        throw new Error(`Could not list remote Git folder ${basePath}: ${(e as Error).message}`);
      }
    }

    const all: Array<{ path: string; isdir: boolean }> = [];
    let frontier = [basePath];
    const batch = 5;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (let i = 0; i < frontier.length; i += batch) {
        const slice = frontier.slice(i, i + batch);
        const settled = await Promise.allSettled(slice.map((folder) => station.listFolder!(folder)));
        for (let j = 0; j < settled.length; j++) {
          const folder = slice[j];
          const r = settled[j];
          if (r.status === "rejected") throw new Error(`Could not list remote Git folder ${folder}: ${(r.reason as Error).message}`);
          for (const f of r.value) {
            if (f.isdir) next.push(f.path);
            else all.push(f);
          }
        }
      }
      frontier = next;
    }
    return all;
  }

  private async probeDownloadedGitStore(idxFiles: string[]): Promise<void> {
    await this.probePackedObjects(idxFiles);
    const head = await git.resolveRef({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}` });
    try {
      const files = await git.listFiles({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}`, cache: this.cache });
      debugLog(`[git-filestation-mobile] Git store probe ref=${this.opts.branch} oid=${head.slice(0, 12)} files=${files.length}`);
    } catch (e) {
      throw new Error(`Git store ref/list probe failed ref=${this.opts.branch} oid=${head.slice(0, 12)}: ${(e as Error).message || String(e)}`);
    }
  }

  private async probePackedObjects(idxFiles: string[]): Promise<void> {
    for (const idxRel of idxFiles) {
      const idxBytes = await this.readMemBytes(`${GITDIR}/${idxRel}`);
      const oids = parseGitPackIndexOids(idxBytes);
      let checked = 0;
      for (const oid of oids) {
        try {
          const result = await git.readObject({ fs: this.memfs.client, gitdir: GITDIR, oid, cache: this.cache, format: "content" });
          checked++;
          if (checked <= 3) debugLog(`[git-filestation-mobile] packed object probe ok idx=${idxRel} oid=${oid.slice(0, 12)} type=${result.type} bytes=${result.object.byteLength}`);
        } catch (e) {
          const packRel = `${idxRel.slice(0, -".idx".length)}.pack`;
          const packBytes = await this.readMemBytes(`${GITDIR}/${packRel}`).catch(() => new Uint8Array());
          throw new Error(`packed object probe failed idx=${idxRel} pack=${packRel} oid=${oid} checked=${checked}/${oids.length} packBytes=${packBytes.byteLength} packPrefix32=${hexPrefix(packBytes, 32)} packFnv1a=${fnv1a32(packBytes)}: ${(e as Error).message || String(e)}`);
        }
      }
      debugLog(`[git-filestation-mobile] packed object probe idx=${idxRel} checked=${checked}`);
    }
  }

  private async remoteHasCommits(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}` });
      return true;
    } catch {
      return false;
    }
  }

  private async localHasCommits(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  private localHasUserFiles(): boolean {
    return this.vault.getFiles().some((file) => {
      if (!(file instanceof TFile)) return false;
      if (file.path.startsWith(".obsidian/")) return false;
      if (DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(file.path, pattern))) return false;
      return true;
    });
  }

  private async checkoutRemote(): Promise<void> {
    await git.branch({ fs: this.memfs.client, dir: WORKDIR, ref: this.opts.branch, checkout: true, force: true });
    await git.checkout({ fs: this.memfs.client, dir: WORKDIR, ref: this.opts.branch, force: true });
  }

  private async changedFiles(): Promise<string[]> {
    try {
      const matrix = await git.statusMatrix({ fs: this.memfs.client, dir: WORKDIR, ignored: false, cache: this.cache });
      return matrix
        .filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
        .map(([filepath]) => filepath)
        .filter((path) => !this.isExcluded(path))
        .sort();
    } catch (e) {
      const message = (e as Error).message || String(e);
      if (!/too many length or distance symbols/i.test(message)) throw e;
      debugLog(`[git-filestation-mobile] statusMatrix failed with inflate error after Git store verification; using strict direct-pako status fallback: ${message}`);
      return this.changedFilesByPako();
    }
  }

  private async changedFilesByPako(): Promise<string[]> {
    const [headOid, indexEntries, workdirFiles] = await Promise.all([
      this.resolveHeadOid(),
      this.readIndexEntries(),
      this.listWorkdirFiles(),
    ]);
    let headEntries: Map<string, string>;
    try {
      headEntries = headOid ? await this.readTreeBlobEntries(headOid) : new Map<string, string>();
    } catch (e) {
      throw new Error(`strict pako status fallback cannot read HEAD tree oid=${headOid || "none"}; refusing to continue with an unreadable/partial Git tree: ${(e as Error).message}`);
    }
    const paths = Array.from(new Set([...headEntries.keys(), ...indexEntries.keys(), ...workdirFiles])).filter((path) => !this.isExcluded(path)).sort();
    const changed: string[] = [];
    for (const path of paths) {
      const head = headEntries.get(path);
      const stage = indexEntries.get(path);
      const workdir = await this.pathExists(`${WORKDIR}/${path}`) ? await this.workdirBlobOid(path) : undefined;
      if (head !== workdir || workdir !== stage) changed.push(path);
    }
    return changed;
  }

  private async resolveHeadOid(): Promise<string | undefined> {
    return git.resolveRef({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD" });
  }

  private async workdirBlobOid(path: string): Promise<string> {
    const data = await this.memfs.promises.readFile(`${WORKDIR}/${path}`);
    const wrapped = wrapGitObject("blob", data);
    return sha1Hex(wrapped);
  }

  private async readTreeBlobEntries(commitOid: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const commit = await this.readLooseObjectContent(commitOid);
    const treeLine = textDecoder.decode(commit.object).split(/\n/, 1)[0];
    const match = /^tree ([0-9a-f]{40})$/i.exec(treeLine);
    if (!match) return out;
    await this.collectTreeBlobEntries(match[1], "", out);
    return out;
  }

  private async collectTreeBlobEntries(treeOid: string, prefix: string, out: Map<string, string>): Promise<void> {
    const tree = await this.readLooseObjectContent(treeOid);
    let offset = 0;
    while (offset < tree.object.byteLength) {
      const modeStart = offset;
      while (tree.object[offset] !== 32) offset++;
      const mode = textDecoder.decode(tree.object.slice(modeStart, offset));
      offset++;
      const pathStart = offset;
      while (tree.object[offset] !== 0) offset++;
      const name = textDecoder.decode(tree.object.slice(pathStart, offset));
      offset++;
      const oid = hexPrefix(tree.object.slice(offset, offset + 20), 20);
      offset += 20;
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode === "40000") await this.collectTreeBlobEntries(oid, path, out);
      else out.set(path, oid);
    }
  }

  private async readLooseObjectContent(oid: string): Promise<{ type: string; object: Uint8Array }> {
    const rel = `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    const bytes = await this.readMemBytes(`${GITDIR}/${rel}`);
    return unwrapGitLooseObjectBytes(bytes, oid, rel);
  }

  private async readIndexEntries(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const bytes = await this.readMemBytes(`${GITDIR}/index`).catch(() => undefined);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12 || textDecoder.decode(bytes.slice(0, 4)) !== "DIRC") return out;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = view.getUint32(8, false);
    let offset = 12;
    for (let i = 0; i < entries && offset + 62 <= bytes.byteLength; i++) {
      const entryStart = offset;
      const oid = hexPrefix(bytes.slice(offset + 40, offset + 60), 20);
      const flags = view.getUint16(offset + 60, false);
      offset += 62;
      const pathStart = offset;
      const pathLength = flags & 0x0fff;
      if (pathLength < 0x0fff) offset += pathLength;
      else while (offset < bytes.byteLength && bytes[offset] !== 0) offset++;
      const path = textDecoder.decode(bytes.slice(pathStart, offset));
      out.set(path, oid);
      offset = entryStart + Math.ceil((offset + 1 - entryStart) / 8) * 8;
    }
    return out;
  }

  private async commitLocalChanges(message: string, allowEmpty: boolean): Promise<void> {
    const files = await this.listWorkdirFiles();
    for (const file of files) {
      if (!this.isExcluded(file)) await git.add({ fs: this.memfs.client, dir: WORKDIR, filepath: file, cache: this.cache });
    }

    const tracked = await git.listFiles({ fs: this.memfs.client, dir: WORKDIR, cache: this.cache });
    for (const file of tracked) {
      if (!(await this.pathExists(`${WORKDIR}/${file}`))) await git.remove({ fs: this.memfs.client, dir: WORKDIR, filepath: file, cache: this.cache });
    }

    const changed = await this.changedFiles();
    if (changed.length === 0 && !allowEmpty) return;

    await git.commit({
      fs: this.memfs.client,
      dir: WORKDIR,
      message,
      author: { name: this.opts.authorName, email: this.opts.authorEmail },
      committer: { name: this.opts.authorName, email: this.opts.authorEmail },
      cache: this.cache,
    });
  }

  private async remoteChangedFiles(): Promise<string[]> {
    try {
      const remoteFiles = await git.listFiles({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}`, cache: this.cache });
      const localFiles = await git.listFiles({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD", cache: this.cache }).catch(() => [] as string[]);
      return Array.from(new Set([...remoteFiles, ...localFiles])).filter((p) => !this.isExcluded(p)).sort();
    } catch {
      return [];
    }
  }

  private async remoteTreeFiles(): Promise<string[]> {
    try {
      return (await git.listFiles({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}`, cache: this.cache })).sort();
    } catch {
      return [];
    }
  }

  private async invalidRemotePathsForLocalCheckout(): Promise<string[]> {
    return findInvalidLocalFilesystemPaths(await this.remoteTreeFiles());
  }

  private async mergeRemote(allowUnrelatedHistories: boolean): Promise<void> {
    try {
      await git.merge({
        fs: this.memfs.client,
        dir: WORKDIR,
        ours: this.opts.branch,
        theirs: `refs/heads/${this.opts.branch}`,
        fastForward: true,
        abortOnConflict: false,
        allowUnrelatedHistories,
        author: { name: this.opts.authorName, email: this.opts.authorEmail },
        committer: { name: this.opts.authorName, email: this.opts.authorEmail },
        cache: this.cache,
      });
    } catch (e) {
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) {
        debugLog(`[git-filestation-mobile] merge stopped with conflicts: ${conflicts.join(", ")}`);
        return;
      }
      throw e;
    }
  }

  private async unmergedFiles(): Promise<string[]> {
    const matrix = await git.statusMatrix({ fs: this.memfs.client, dir: WORKDIR, ignored: false, cache: this.cache });
    return matrix
      .filter(([, head, workdir, stage]) => head !== 1 && workdir === 2 && stage === 0)
      .map(([filepath]) => filepath)
      .sort();
  }

  private async pushWithRetry(): Promise<void> {
    try {
      await this.copyLocalBranchToRemote();
    } catch (e) {
      debugLog(`[git-filestation-mobile] push failed, retrying merge once: ${(e as Error).message}`);
      await this.mergeRemote(false);
      const conflicts = await this.unmergedFiles();
      if (conflicts.length > 0) throw new Error("Push retry found merge conflicts; resolve them and sync again.");
      await this.copyLocalBranchToRemote();
    }
  }

  private async copyLocalBranchToRemote(): Promise<void> {
    const oid = await git.resolveRef({ fs: this.memfs.client, dir: WORKDIR, ref: "HEAD" });
    await this.writeMemText(`${GITDIR}/refs/heads/${this.opts.branch}`, `${oid}\n`);
  }

  private async snapshotInitialLocalFileBytes(paths: string[]): Promise<Map<string, Uint8Array>> {
    const snapshot = new Map<string, Uint8Array>();
    for (const path of paths) {
      if (this.isExcluded(path)) continue;
      snapshot.set(path, await this.readMemBytes(`${WORKDIR}/${path}`));
    }
    return snapshot;
  }

  private async materializeInitialLocalCopies(initialFiles: Map<string, Uint8Array>, result: SyncResult): Promise<void> {
    for (const [path, bytes] of initialFiles) {
      if (this.isExcluded(path)) continue;
      const copyPath = conflictCopyPath(path, this.opts.syncIdentityId);
      if (await this.pathExists(`${WORKDIR}/${copyPath}`)) continue;
      await this.writeMemFile(`${WORKDIR}/${copyPath}`, bytes);
      await git.add({ fs: this.memfs.client, dir: WORKDIR, filepath: copyPath, cache: this.cache });
      result.conflicts.push(path);
      debugLog(`[git-filestation-mobile] preserved pre-sync local copy ${path} -> ${copyPath}`);
    }
  }

  private async materializePreMergeLocalCopies(localChanged: Set<string>, before: Map<string, string>, result: SyncResult): Promise<void> {
    if (localChanged.size === 0) return;
    for (const path of await this.listWorkdirFiles()) {
      if (!localChanged.has(path) || this.isExcluded(path)) continue;
      const currentHash = await this.fileHash(`${WORKDIR}/${path}`);
      if (before.has(path) && before.get(path) !== currentHash) continue;
      const copyPath = conflictCopyPath(path, this.opts.syncIdentityId);
      if (await this.pathExists(`${WORKDIR}/${copyPath}`)) continue;
      await this.writeMemFile(`${WORKDIR}/${copyPath}`, await this.readMemBytes(`${WORKDIR}/${path}`));
      await git.add({ fs: this.memfs.client, dir: WORKDIR, filepath: copyPath, cache: this.cache });
      result.conflicts.push(path);
      debugLog(`[git-filestation-mobile] preserved local pre-merge copy ${path} -> ${copyPath}`);
    }
  }

  private async materializeConflictCopies(conflicts: string[], result: SyncResult): Promise<void> {
    for (const path of conflicts) {
      if (this.isExcluded(path)) continue;
      const copyPath = conflictCopyPath(path, this.opts.syncIdentityId);
      if (!(await this.pathExists(`${WORKDIR}/${path}`)) || await this.pathExists(`${WORKDIR}/${copyPath}`)) continue;
      await this.writeMemFile(`${WORKDIR}/${copyPath}`, await this.readMemBytes(`${WORKDIR}/${path}`));
      await git.add({ fs: this.memfs.client, dir: WORKDIR, filepath: copyPath, cache: this.cache });
      debugLog(`[git-filestation-mobile] preserved conflicted local copy ${path} -> ${copyPath}`);
    }
    if (conflicts.length > 0) result.conflicts.push(...conflicts.filter((p) => !result.conflicts.includes(p)));
  }

  private async uploadBareRepoMirror(): Promise<void> {
    await this.ensureRemoteDirectoryTree();
    const files = await this.listMemFiles(GITDIR);
    for (const abs of files) {
      const rel = abs.slice(GITDIR.length + 1);
      if (shouldSkipRemoteGitFile(rel)) continue;
      const bytes = await this.memfs.promises.readFile(abs);
      await this.fs.upload(joinRemotePath(this.opts.remotePath, dirnameRemotePath(rel)), basenameRemotePath(rel), bytesToArrayBuffer(bytes), true);
    }
  }

  private async ensureRemoteDirectoryTree(): Promise<void> {
    const parts = normalizeRemotePath(this.opts.remotePath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      const parent = current ? `/${current}` : "/";
      try {
        await this.fs.createFolder(parent, part);
      } catch (e) {
        debugLog(`[git-filestation-mobile] createFolder ${parent}/${part} failed: ${(e as Error).message}`);
      }
      current = current ? `${current}/${part}` : part;
    }
  }

  private findNestedGitRepositories(): string[] {
    const found = this.vault.getFiles()
      .map((file) => file.path)
      .filter((path) => /(^|\/)\.git(\/|$)/.test(path))
      .map((path) => path.replace(/\/.git(\/.*)?$/, ""))
      .filter((path) => path && !DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(path, pattern)));
    return Array.from(new Set(found)).sort();
  }

  private hiddenSystemVaultFilesAtStart(paths: string[]): string[] {
    return paths.filter((path) => path.startsWith(".") && !path.startsWith(".obsidian/") && !this.isExcluded(path)).sort();
  }

  private async loadVaultIntoMemory(): Promise<void> {
    await this.memfs.promises.mkdir(WORKDIR, { recursive: true });
    for (const file of this.vault.getFiles()) {
      if (!(file instanceof TFile)) continue;
      if (this.isExcluded(file.path)) continue;
      if (file.path.startsWith(".")) {
        debugLog(`[git-filestation-mobile] ignoring hidden system vault file during mobile load: ${file.path}`);
        continue;
      }
      await this.writeMemFile(`${WORKDIR}/${file.path}`, new Uint8Array(await this.vault.readBinary(file)));
    }
  }

  private async snapshotWorkdirFiles(): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    for (const file of await this.listWorkdirFiles()) {
      if (!this.isExcluded(file)) snapshot.set(file, await this.fileHash(`${WORKDIR}/${file}`));
    }
    return snapshot;
  }

  private async materializeRemoteFiles(remoteFiles: string[], result: SyncResult): Promise<void> {
    debugLog(`[git-filestation-mobile] materializing remote files count=${remoteFiles.length}`);
    const head = await git.resolveRef({ fs: this.memfs.client, gitdir: GITDIR, ref: `refs/heads/${this.opts.branch}` });
    for (const path of remoteFiles) {
      if (this.isExcluded(path)) continue;
      const blob = await git.readBlob({ fs: this.memfs.client, gitdir: GITDIR, oid: head, filepath: path, cache: this.cache });
      const bytes = blob.blob instanceof Uint8Array ? blob.blob : new Uint8Array(blob.blob);
      const existing = this.vault.getAbstractFileByPath(path);
      await this.ensureVaultFolder(dirnameVaultPath(path));
      if (existing instanceof TFile) await this.vault.modifyBinary(existing, bytesToArrayBuffer(bytes));
      else await this.vault.createBinary(path, bytesToArrayBuffer(bytes));
      await this.writeMemFile(`${WORKDIR}/${path}`, bytes);
      if (!result.downloaded.includes(path) && !result.uploaded.includes(path)) result.downloaded.push(path);
    }
    debugLog(`[git-filestation-mobile] materialized remote files count=${result.downloaded.length}`);
  }

  private async applyCheckoutChanges(before: Map<string, string>, result: SyncResult): Promise<void> {
    const after = await this.snapshotWorkdirFiles();
    const all = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
    for (const path of all) {
      if (this.isExcluded(path)) continue;
      const beforeHash = before.get(path);
      const afterHash = after.get(path);
      if (beforeHash === afterHash) continue;
      const file = this.vault.getAbstractFileByPath(path);
      if (afterHash === undefined) {
        if (file instanceof TFile) {
          await this.vault.delete(file);
          result.deleted.push(path);
        }
        continue;
      }
      const bytes = await this.memfs.promises.readFile(`${WORKDIR}/${path}`);
      if (file instanceof TFile) await this.vault.modifyBinary(file, bytesToArrayBuffer(bytes));
      else {
        await this.ensureVaultFolder(dirnameVaultPath(path));
        await this.vault.createBinary(path, bytesToArrayBuffer(bytes));
      }
      if (!result.downloaded.includes(path) && !result.uploaded.includes(path)) result.downloaded.push(path);
    }
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    const parts = splitPath(path);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing instanceof TFile) throw new Error(`Cannot create checkout folder ${current}; a file already exists at that path.`);
      try {
        await this.vault.createFolder(current);
      } catch (e) {
        const afterCreate = this.vault.getAbstractFileByPath(current);
        if (afterCreate instanceof TFolder || /already exists/i.test((e as Error).message || "")) {
          debugLog(`[git-filestation-mobile] checkout folder already exists: ${current}`);
          continue;
        }
        throw e;
      }
    }
  }

  private async writeInfoExclude(): Promise<void> {
    const path = `${GITDIR}/info/exclude`;
    const prior = await this.readMemText(path).catch(() => "");
    const lines = prior.split(/\r?\n/);
    const missing = DEFAULT_GIT_EXCLUDES.filter((line) => !lines.includes(line));
    if (missing.length > 0) {
      await this.writeMemText(path, `${prior}${prior.endsWith("\n") || prior.length === 0 ? "" : "\n"}${missing.join("\n")}\n`);
    }
  }

  private isExcluded(path: string): boolean {
    return path.startsWith(".git/") || DEFAULT_GIT_EXCLUDES.some((pattern) => matchesSimpleExclude(path, pattern));
  }

  private async listWorkdirFiles(): Promise<string[]> {
    const files = await this.listMemFiles(WORKDIR);
    return files
      .map((path) => path.slice(WORKDIR.length + 1))
      .filter((path) => path && !path.startsWith(".git/"))
      .sort();
  }

  private async listMemFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: string[];
      try { entries = await this.memfs.promises.readdir(dir); } catch { return; }
      for (const name of entries) {
        const abs = `${dir}/${name}`;
        const stat = await this.memfs.promises.lstat(abs);
        if (stat.isDirectory()) await walk(abs);
        else if (stat.isFile()) out.push(abs);
      }
    };
    await walk(root);
    return out.sort();
  }

  private async pathExists(path: string): Promise<boolean> {
    try { await this.memfs.promises.lstat(path); return true; } catch { return false; }
  }

  private async writeMemText(path: string, text: string): Promise<void> {
    await this.writeMemFile(path, textEncoder.encode(text));
  }

  private async readMemText(path: string): Promise<string> {
    return textDecoder.decode(await this.readMemBytes(path));
  }

  private async readMemBytes(path: string): Promise<Uint8Array> {
    const data = await this.memfs.promises.readFile(path);
    return data instanceof Uint8Array ? data : textEncoder.encode(String(data));
  }

  private async writeMemFile(path: string, data: Uint8Array): Promise<void> {
    await this.memfs.promises.mkdir(dirname(path), { recursive: true });
    await this.memfs.promises.writeFile(path, data);
  }

  private async fileHash(path: string): Promise<string> {
    const data = await this.memfs.promises.readFile(path);
    let hash = 2166136261;
    for (const byte of data) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `${data.byteLength}:${hash >>> 0}`;
  }
}

class MemoryFs {
  private root: FsNode = { type: "dir", children: new Map(), mtimeMs: Date.now(), ctimeMs: Date.now(), mode: 0o040777 };

  promises = {
    readFile: async (path: string, options?: string | { encoding?: string | null }): Promise<Uint8Array | string> => {
      const node = this.getNode(path);
      if (node.type !== "file") throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? textDecoder.decode(node.data) : Buffer.from(node.data);
    },
    writeFile: async (path: string, data: Uint8Array | string): Promise<void> => {
      const parent = this.getParent(path, true);
      const name = basename(path);
      const bytes = typeof data === "string" ? textEncoder.encode(data) : new Uint8Array(data);
      parent.children.set(name, { type: "file", data: bytes, mtimeMs: Date.now(), ctimeMs: Date.now(), mode: 0o100644 });
    },
    unlink: async (path: string): Promise<void> => {
      const parent = this.getParent(path, false);
      if (!parent.children.delete(basename(path))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    readdir: async (path: string): Promise<string[]> => {
      const node = this.getNode(path);
      if (node.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      return Array.from(node.children.keys()).sort();
    },
    mkdir: async (path: string, opts?: { recursive?: boolean } | number): Promise<void> => {
      const recursive = typeof opts === "object" && !!opts.recursive;
      try {
        this.ensureDir(path, recursive);
      } catch (error) {
        if (recursive || !isMissingParentDir(error)) throw error;
        // isomorphic-git initializes nested paths one level at a time, but on
        // mobile this in-memory FS is the only parent creator. Match the
        // forgiving behavior of browser filesystem shims for missing parents.
        this.ensureDir(path, true);
      }
    },
    rmdir: async (path: string): Promise<void> => {
      const node = this.getNode(path);
      if (node.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      if (node.children.size > 0) throw Object.assign(new Error(`ENOTEMPTY: ${path}`), { code: "ENOTEMPTY" });
      const parent = this.getParent(path, false);
      parent.children.delete(basename(path));
    },
    stat: async (path: string): Promise<NodeLikeStat> => this.toStat(this.getNode(path)),
    lstat: async (path: string): Promise<NodeLikeStat> => this.toStat(this.getNode(path)),
    readlink: async (): Promise<string> => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); },
    symlink: async (): Promise<void> => { throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" }); },
    chmod: async (path: string, mode: number): Promise<void> => { this.getNode(path).mode = mode; },
  };

  client = { promises: this.promises };

  private getNode(path: string): FsNode {
    const parts = splitPath(path);
    let node = this.root;
    for (const part of parts) {
      if (node.type !== "dir" || !node.children.has(part)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      node = node.children.get(part) as FsNode;
    }
    return node;
  }

  private getParent(path: string, create: boolean): Extract<FsNode, { type: "dir" }> {
    return this.ensureDir(dirname(path), create);
  }

  private ensureDir(path: string, recursive: boolean): Extract<FsNode, { type: "dir" }> {
    const parts = splitPath(path);
    let node = this.root;
    for (const part of parts) {
      if (node.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      let child = node.children.get(part);
      if (!child) {
        if (!recursive) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        child = { type: "dir", children: new Map(), mtimeMs: Date.now(), ctimeMs: Date.now(), mode: 0o040777 };
        node.children.set(part, child);
      }
      if (child.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      node = child;
    }
    return node;
  }

  private toStat(node: FsNode): NodeLikeStat {
    return {
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
      isSymbolicLink: () => false,
      size: node.type === "file" ? node.data.byteLength : 0,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      mode: node.mode,
    };
  }
}

async function verifyGitPackBytes(bytes: Uint8Array, rel: string): Promise<{ objectCount: number; packSha: string }> {
  if (bytes.byteLength < 32) throw new Error(`pack too short path=${rel} bytes=${bytes.byteLength}`);
  if (textDecoder.decode(bytes.slice(0, 4)) !== "PACK") throw new Error(`pack missing PACK header path=${rel} prefix32=${hexPrefix(bytes, 32)}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, false);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version path=${rel} version=${version}`);
  const objectCount = view.getUint32(8, false);
  const computed = await sha1Hex(bytes.slice(0, -20));
  const claimed = hexPrefix(bytes.slice(-20), 20);
  if (computed !== claimed) throw new Error(`pack trailer SHA mismatch path=${rel} bytes=${bytes.byteLength} expected=${claimed} actual=${computed}`);
  return { objectCount, packSha: claimed };
}

async function verifyGitPackIndexBytes(bytes: Uint8Array, rel: string, expectedPackSha: string): Promise<{ objectCount: number }> {
  if (bytes.byteLength < 8 + 256 * 4 + 40) throw new Error(`idx too short path=${rel} bytes=${bytes.byteLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== 0xff744f63) throw new Error(`idx missing v2 magic path=${rel} prefix32=${hexPrefix(bytes, 32)}`);
  const version = view.getUint32(4, false);
  if (version !== 2) throw new Error(`unsupported idx version path=${rel} version=${version}`);
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const count = view.getUint32(8 + i * 4, false);
    if (count < prev) throw new Error(`idx fanout not monotonic path=${rel} bucket=${i}`);
    prev = count;
  }
  const objectCount = prev;
  const expectedLength = 8 + 256 * 4 + objectCount * 20 + objectCount * 4 + objectCount * 4 + 40;
  if (bytes.byteLength < expectedLength) throw new Error(`idx truncated path=${rel} bytes=${bytes.byteLength} minExpected=${expectedLength}`);
  const packShaOffset = bytes.byteLength - 40;
  const idxPackSha = hexPrefix(bytes.slice(packShaOffset, packShaOffset + 20), 20);
  if (idxPackSha !== expectedPackSha) throw new Error(`idx pack SHA mismatch path=${rel} expected=${expectedPackSha} actual=${idxPackSha}`);
  const computed = await sha1Hex(bytes.slice(0, -20));
  const claimed = hexPrefix(bytes.slice(-20), 20);
  if (computed !== claimed) throw new Error(`idx trailer SHA mismatch path=${rel} expected=${claimed} actual=${computed}`);
  return { objectCount };
}

function parseGitPackIndexOids(bytes: Uint8Array): string[] {
  if (bytes.byteLength < 8 + 256 * 4 + 40) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0xff744f63 || view.getUint32(4, false) !== 2) return [];
  const objectCount = view.getUint32(8 + 255 * 4, false);
  const oidsOffset = 8 + 256 * 4;
  const out: string[] = [];
  for (let i = 0; i < objectCount && oidsOffset + (i + 1) * 20 <= bytes.byteLength; i++) {
    out.push(hexPrefix(bytes.slice(oidsOffset + i * 20, oidsOffset + (i + 1) * 20), 20));
  }
  return out;
}

function verifyGitLooseObjectBytes(bytes: Uint8Array, oid: string, rel: string): void {
  unwrapGitLooseObjectBytes(bytes, oid, rel);
}

function unwrapGitLooseObjectBytes(bytes: Uint8Array, oid: string, rel: string): { type: string; object: Uint8Array } {
  const inflated = pako.inflate(bytes);
  const nul = inflated.indexOf(0);
  if (nul <= 0) throw new Error(`inflated object missing header oid=${oid} path=${rel}`);
  const header = textDecoder.decode(inflated.slice(0, nul));
  if (!/^(blob|tree|commit|tag) [0-9]+$/.test(header)) {
    throw new Error(`inflated object has invalid header oid=${oid} path=${rel} header=${header}`);
  }
  const expectedLength = Number(header.slice(header.indexOf(" ") + 1));
  const actualLength = inflated.byteLength - nul - 1;
  if (expectedLength !== actualLength) {
    throw new Error(`inflated object length mismatch oid=${oid} path=${rel} expected=${expectedLength} actual=${actualLength}`);
  }
  return { type: header.slice(0, header.indexOf(" ")), object: inflated.slice(nul + 1) };
}

function wrapGitObject(type: string, object: Uint8Array): Uint8Array {
  const header = textEncoder.encode(`${type} ${object.byteLength}\0`);
  const wrapped = new Uint8Array(header.byteLength + object.byteLength);
  wrapped.set(header, 0);
  wrapped.set(object, header.byteLength);
  return wrapped;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return hexPrefix(new Uint8Array(digest), 20);
}

function hexPrefix(bytes: Uint8Array, max: number): string {
  return Array.from(bytes.slice(0, max), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fnv1a32(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function emptyResult(): SyncResult {
  return { uploaded: [], downloaded: [], deleted: [], deletedRemote: [], deletedLocal: [], recreated: [], preservedLocal: [], conflicts: [], errors: [] };
}

function isMissingParentDir(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function normalizeRemotePath(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

function relativeRemotePath(base: string, path: string): string {
  const normalizedBase = normalizeRemotePath(base);
  if (path === normalizedBase) return "";
  return path.startsWith(`${normalizedBase}/`) ? path.slice(normalizedBase.length + 1) : path;
}

function matchesSimpleExclude(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

function shouldSkipRemoteGitFile(path: string): boolean {
  return path === "config" || path === "description" || path.endsWith(".lock") || path.startsWith("hooks/");
}

function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] || "";
}


function conflictCopyPath(path: string, syncIdentityId: string): string {
  const dir = dirnameVaultPath(path);
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = syncIdentityId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
  const copyBase = dot > 0 ? `${base.slice(0, dot)} (conflict ${safeId} ${stamp})${base.slice(dot)}` : `${base} (conflict ${safeId} ${stamp})`;
  return dir ? `${dir}/${copyBase}` : copyBase;
}

function dirnameVaultPath(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return parts.join("/");
}

function dirname(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return `/${parts.join("/")}`;
}

function splitPath(path: string): string[] {
  if (path === ".") return [];
  return path.split("/").filter((part) => part.length > 0 && part !== ".");
}

function basenameRemotePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function dirnameRemotePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinRemotePath(base: string, relDir: string): string {
  const normalized = normalizeRemotePath(base);
  return relDir ? `${normalized}/${relDir}` : normalized;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
