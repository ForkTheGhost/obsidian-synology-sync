import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { debugLog, redact } from "./debug";

export interface FileInfo {
  path: string;
  name: string;
  isdir: boolean;
  additional?: {
    size?: number;
    time?: {
      mtime: number;
      ctime: number;
      atime: number;
    };
  };
}

export interface FileStationConfig {
  baseUrl: string; // e.g. https://nas.local:5001
  username: string;
  password: string;
  deviceId?: string;
  deviceToken?: string;
  otpCode?: string;
  twoFaToken?: string; // JWT from initial 403 response, needed for OTP step
  quickConnectRelay?: boolean;
}

export interface LoginResult {
  sid: string;
  deviceId: string;
  deviceToken?: string; // returned on first OTP login; save this for future logins
}

export class FileStationApiError extends Error {
  code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "FileStationApiError";
    this.code = code;
  }
}

export class FileStationPathExistsError extends FileStationApiError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = "FileStationPathExistsError";
  }
}

export type AuthPhase = "resolve_candidates" | "select_endpoint" | "start_login" | "classify_response" | "retry_without_token" | "prompt_otp" | "persist_replacement_token" | "repair_relay_session" | "fail";
export type AuthEndpointKind = "direct" | "relay" | "manual" | "unknown";
export type AuthResponseKind = "dsm_json_success" | "dsm_json_error" | "timeout" | "html_portal" | "network_error" | "unexpected_response";
export type PersistedTokenAction = "keep" | "clear_for_retry" | "replace" | "none";
export type AuthNextAction = "try_relay" | "retry_without_token" | "prompt_for_otp" | "save_token" | "repair_relay_or_choose_endpoint" | "fail_actionable" | "authenticated";

export interface AuthState {
  phase: AuthPhase;
  endpointKind: AuthEndpointKind;
  responseKind: AuthResponseKind;
  persistedTokenAction: PersistedTokenAction;
  message: string;
  nextAction: AuthNextAction;
}

class AuthStateError extends Error {
  state: AuthState;
  constructor(state: AuthState) {
    super(state.message);
    this.name = "AuthStateError";
    this.state = state;
  }
}

const LOGIN_TIMEOUT_MS = 10000;

function isLikelyHtmlResponse(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /invalid json/i.test(msg) || /unexpected token\s*</i.test(msg) || msg.includes("<!DOCTYPE") || msg.includes("<html");
}

// DSM File Station errors follow a documented shape: a top-level `error.code`
// and, for batch operations, per-item details under `error.errors[].code`.
// Walk only those paths instead of recursing through arbitrary nested objects
// so unrelated `code` properties on future response shapes cannot be misread
// as the operation's error code.
function toNumericCode(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function findFileStationErrorCode(error: unknown, matches?: (code: number) => boolean): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const record = error as Record<string, unknown>;
  const topCode = toNumericCode(record.code);
  const nestedCodes: number[] = [];
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      if (item && typeof item === "object") {
        const code = toNumericCode((item as Record<string, unknown>).code);
        if (code !== undefined) nestedCodes.push(code);
      }
    }
  }

  if (matches) {
    if (topCode !== undefined && matches(topCode)) return topCode;
    return nestedCodes.find(matches);
  }

  return topCode ?? nestedCodes[0];
}

async function requestUrlWithTimeout(options: Parameters<typeof requestUrl>[0], timeoutMs: number, label: string): Promise<RequestUrlResponse> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestUrl(options),
      new Promise<RequestUrlResponse>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

export class FileStation {
  private config: FileStationConfig;
  private sid: string | null = null;
  private lastAuthState: AuthState | null = null;

  constructor(config: FileStationConfig) {
    this.config = config;
  }

  getLastAuthState(): AuthState | null {
    return this.lastAuthState;
  }

  endpointKind(): AuthEndpointKind {
    if (this.config.quickConnectRelay) return "relay";
    if (/\.quickconnect\.to(?::|$)|\.direct\.quickconnect\.to(?::|$)/i.test(this.config.baseUrl)) return "direct";
    if (/^https?:\/\//i.test(this.config.baseUrl)) return "manual";
    return "unknown";
  }

  private setAuthState(state: AuthState): AuthState {
    this.lastAuthState = state;
    debugLog(`AUTH STATE: phase=${state.phase} endpoint=${state.endpointKind} response=${state.responseKind} token=${state.persistedTokenAction} next=${state.nextAction} message=${state.message}`);
    return state;
  }

  private url(api: string, params: Record<string, string>): string {
    const qs = new URLSearchParams(params);
    if (this.sid) qs.set("_sid", this.sid);
    // Replace + with %20 - Synology's API doesn't accept + for spaces in path params
    return `${this.config.baseUrl}/webapi/entry.cgi?${qs.toString().replace(/\+/g, "%20")}`;
  }

  private buildLoginParams(): Record<string, string> {
    const params: Record<string, string> = {
      api: "SYNO.API.Auth",
      version: "7",
      method: "login",
      account: this.config.username,
      passwd: this.config.password,
      session: "FileStation",
      format: "sid",
    };

    params.enable_device_token = "yes";

    if (this.config.deviceToken) {
      params.device_id = this.config.deviceToken;
      params.device_name = "Obsidian Synology Sync";
    } else if (this.config.otpCode) {
      params.otp_code = this.config.otpCode;
      params.device_name = "Obsidian Synology Sync";
    }

    return params;
  }

  private async requestLogin(params: Record<string, string>): Promise<RequestUrlResponse> {
    if (!this.config.quickConnectRelay) {
      return requestUrlWithTimeout({
        url: this.url("", params),
        method: "GET",
      }, LOGIN_TIMEOUT_MS, "direct login request");
    }

    debugLog("AUTH: QuickConnect relay mode; using entry.cgi POST auth flow");
    try {
      debugLog("AUTH: relay portal bootstrap start");
      await requestUrlWithTimeout({
        url: `${this.config.baseUrl}/`,
        method: "GET",
        throw: false,
      }, LOGIN_TIMEOUT_MS, "relay portal bootstrap");
      debugLog("AUTH: relay portal bootstrap complete");
    } catch (e) {
      debugLog(`AUTH: relay portal bootstrap did not return JSON (${(e as Error).message}); continuing to entry.cgi auth`);
    }

    const relayParams = {
      ...params,
      logintype: "local",
      client: "browser",
      enable_syno_token: "yes",
      rememberme: "0",
    };

    debugLog("AUTH: relay entry.cgi login request start");
    return requestUrlWithTimeout({
      url: `${this.config.baseUrl}/webapi/entry.cgi`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams(relayParams).toString(),
    }, LOGIN_TIMEOUT_MS, "relay entry.cgi login request");
  }

  /**
   * Inspect a login response for a HTML body (e.g. DSM portal login page returned
   * with HTTP 200 when a saved device token has expired). Returns the parsed JSON
   * data when the body is JSON; throws a clear, user-actionable error otherwise.
   *
   * Side effect: clears `this.config.deviceToken` when HTML is detected so the next
   * login attempt falls back to a fresh credential login.
   */
  private parseLoginResponse(resp: RequestUrlResponse): any {
    const text = resp.text ?? "";
    const ct = ((resp as any).headers?.["content-type"] ?? (resp as any).headers?.["Content-Type"] ?? "") as string;
    const looksHtml = /text\/html/i.test(ct) || /^\s*</.test(text);
    if (looksHtml) {
      const preview = text.slice(0, 120).replace(/\s+/g, " ");
      debugLog(`AUTH: NAS returned HTML on login (status=${resp.status}, content-type=${ct || "(unset)"}, body[0..120]=${preview})`);
      const state = this.setAuthState({
        phase: this.config.quickConnectRelay ? "repair_relay_session" : "fail",
        endpointKind: this.endpointKind(),
        responseKind: "html_portal",
        persistedTokenAction: "keep",
        message: this.config.quickConnectRelay
          ? "QuickConnect relay responded with a browser page instead of File Station API JSON. The relay/API session needs repair or a different endpoint."
          : "Synology login failed: endpoint returned a browser page instead of File Station API JSON. Choose a File Station API endpoint.",
        nextAction: this.config.quickConnectRelay ? "repair_relay_or_choose_endpoint" : "fail_actionable",
      });
      throw new AuthStateError(state);
    }
    try {
      return JSON.parse(text);
    } catch {
      // Fall back to resp.json in case the host runtime did not populate `text`
      // (the real Obsidian RequestUrlResponse always provides both, but tests/mocks
      // may only set one). If that also fails, throw a clear error.
      const j = (resp as any).json;
      if (j && typeof j === "object") return j;
      const state = this.setAuthState({ phase: "classify_response", endpointKind: this.endpointKind(), responseKind: "unexpected_response", persistedTokenAction: "none", message: "Synology login failed: response was not valid JSON", nextAction: "fail_actionable" });
      throw new AuthStateError(state);
    }
  }

  async login(): Promise<LoginResult> {
    let params = this.buildLoginParams();

    debugLog(`AUTH: baseUrl=${this.config.baseUrl}`);
    debugLog(`AUTH: user=${this.config.username}`);
    debugLog(`AUTH: password=${this.config.password ? "********" : "(empty)"}`);
    debugLog(`AUTH: config.deviceToken=${redact(this.config.deviceToken)}`);
    debugLog(`AUTH: config.deviceId=${redact(this.config.deviceId)}`);
    debugLog(`AUTH: config.otpCode=${this.config.otpCode ? "(set)" : "(empty)"}`);
    debugLog(`AUTH: params.device_id=${redact(params.device_id)}`);
    debugLog(`AUTH: params.device_name=${params.device_name || "(unset)"}`);
    debugLog(`AUTH: quickConnectRelay=${this.config.quickConnectRelay ? "true" : "false"}`);
    debugLog(`AUTH: params.enable_device_token=${params.enable_device_token}`);
    debugLog(`AUTH: params.otp_code=${params.otp_code ? "set" : "(unset)"}`);

    let resp: RequestUrlResponse;
    try {
      resp = await this.requestLogin(params);
    } catch (e) {
      const msg = (e as Error).message;
      if (/timed out/i.test(msg)) {
        this.setAuthState({ phase: "fail", endpointKind: this.endpointKind(), responseKind: "timeout", persistedTokenAction: "none", message: "Login timed out before DSM returned an auth response.", nextAction: this.config.quickConnectRelay ? "fail_actionable" : "try_relay" });
      } else if (isLikelyHtmlResponse(e)) {
        this.setAuthState({ phase: "repair_relay_session", endpointKind: this.endpointKind(), responseKind: "html_portal", persistedTokenAction: "keep", message: "QuickConnect relay responded with a browser page instead of File Station API JSON. The relay/API session needs repair or a different endpoint.", nextAction: "repair_relay_or_choose_endpoint" });
        throw new AuthStateError(this.lastAuthState!);
      } else {
        this.setAuthState({ phase: "fail", endpointKind: this.endpointKind(), responseKind: "network_error", persistedTokenAction: "none", message: `Network error during Synology login: ${msg}`, nextAction: "fail_actionable" });
      }
      debugLog(`AUTH: request failed: ${msg}`);
      throw e;
    }

    let data = this.parseLoginResponse(resp);
    if (!data || typeof data !== "object") {
      debugLog("AUTH: response was not JSON object");
      throw new Error("Synology login failed: File Station API returned a non-JSON response");
    }
    debugLog(`AUTH: response success=${data.success}`);
    this.setAuthState({
      phase: "classify_response",
      endpointKind: this.endpointKind(),
      responseKind: data.success ? "dsm_json_success" : "dsm_json_error",
      persistedTokenAction: "keep",
      message: data.success ? "DSM File Station authentication succeeded." : `DSM returned auth error code ${data.error?.code ?? "unknown"}.`,
      nextAction: data.success ? "authenticated" : (data.error?.code === 403 ? "prompt_for_otp" : "fail_actionable"),
    });

    // Fix B: one-shot retry when DSM rejects a saved device token (code 403 with
    // device_id present in the request). Without this we surface a confusing
    // "2FA code required" error to a user who expected their device to be trusted.
    if (!data.success && data.error?.code === 403 && this.config.deviceToken) {
      this.setAuthState({ phase: "retry_without_token", endpointKind: this.endpointKind(), responseKind: "dsm_json_error", persistedTokenAction: "clear_for_retry", message: "DSM rejected the saved device token. Re-enter OTP to trust this device again.", nextAction: "retry_without_token" });
      debugLog("AUTH: device token rejected (code 403); retrying without device token");
      this.config.deviceToken = undefined;
      params = this.buildLoginParams();
      let retryResp: RequestUrlResponse;
      try {
        retryResp = await this.requestLogin(params);
      } catch (e) {
        if (isLikelyHtmlResponse(e)) {
          debugLog("AUTH: retry login endpoint returned HTML/non-JSON");
          throw new Error("Synology login failed: selected QuickConnect endpoint returned HTML instead of File Station API JSON");
        }
        debugLog(`AUTH: retry request failed: ${(e as Error).message}`);
        throw e;
      }
      data = this.parseLoginResponse(retryResp);
      if (!data || typeof data !== "object") {
        throw new Error("Synology login failed: File Station API returned a non-JSON response");
      }
      debugLog(`AUTH: retry response success=${data.success}`);
      if (!data.success && data.error?.code === 403) {
        throw new Error("Synology login failed: 2FA code required (device token rejected; re-enter OTP)");
      }
    }

    if (data.success) {
      const keys = Object.keys(data.data || {});
      debugLog(`AUTH: response keys=${keys.join(",")}`);
      for (const k of keys) {
        const v = data.data[k];
        if (typeof v === "string") {
          debugLog(`AUTH: data.${k}=${k === "sid" || k === "synotoken" || k === "did" || k === "device_id" ? redact(v) : v}`);
        } else {
          debugLog(`AUTH: data.${k}=${JSON.stringify(v)}`);
        }
      }
    } else {
      debugLog(`AUTH: error=${JSON.stringify(data.error)}`);
    }

    if (!data.success) {
      const code = data.error?.code;
      const hasDeviceToken = !!this.config.deviceToken;
      const hasOtp = !!this.config.otpCode;
      const msg = code === 400 ? "Invalid credentials"
        : code === 401 ? "Account disabled"
        : code === 402 ? "Permission denied"
        : code === 403 ? `2FA code required (deviceToken saved: ${hasDeviceToken}, otp provided: ${hasOtp})`
        : code === 404 ? "2FA code failed"
        : `Error code ${code}`;
      throw new Error(`Synology login failed: ${msg}`);
    }

    this.sid = data.data.sid;

    // Query DSM version for debug
    try {
      const infoResp = await requestUrl({
        url: this.url("", {
          api: "SYNO.DSM.Info",
          version: "2",
          method: "getinfo",
        }),
        method: "GET",
      });
      if (infoResp.json?.success) {
        const info = infoResp.json.data;
        debugLog(`DSM: model=${info.model || "?"} version=${info.version_string || info.version || "?"} codepage=${info.codepage || "?"}`);
      }
    } catch {
      debugLog("DSM: could not query version info");
    }

    // DSM 7 returns the device token in different fields depending on version:
    // - 'did' (older DSM)
    // - 'device_id' (DSM 7.x)
    // Note: data.data.device_id is the DEVICE TOKEN for re-login, not our UUID.
    const deviceToken = data.data.did || data.data.device_id || data.data.device_token;
    debugLog(`AUTH: extracted deviceToken=${redact(deviceToken)} from response`);
    if (deviceToken && deviceToken !== this.config.deviceToken) {
      this.setAuthState({ phase: "persist_replacement_token", endpointKind: this.endpointKind(), responseKind: "dsm_json_success", persistedTokenAction: "replace", message: this.config.otpCode ? "OTP accepted and a replacement device token was saved." : "DSM returned a replacement device token to save.", nextAction: "save_token" });
    }

    return {
      sid: data.data.sid,
      deviceId: this.config.deviceId || "",
      deviceToken: deviceToken || undefined,
    };
  }

  /**
   * Parse a non-login FileStation response. Detects HTML bodies (DSM session
   * expiry returns a portal page with HTTP 200) and surfaces a clear error
   * instead of letting `resp.json` throw an opaque "Unrecognized token '<'".
   */
  private parseJson(resp: RequestUrlResponse, label: string): any {
    const text = resp.text ?? "";
    if (/^\s*</.test(text)) {
      debugLog(`${label}: NAS returned HTML (status=${resp.status}); session may have expired`);
      throw new Error(`${label}: NAS returned an HTML page — session may have expired`);
    }
    if (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        // Some test mocks supply only `json`. Fall back if parse of `text` failed.
        const j = (resp as any).json;
        if (j !== undefined) return j;
        throw new Error(`${label}: invalid JSON from NAS: ${(e as Error).message}`);
      }
    }
    // No `text` — defer to whatever the runtime parsed.
    return (resp as any).json;
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await requestUrl({
        url: this.url("", {
          api: "SYNO.API.Auth",
          version: "7",
          method: "logout",
          session: "FileStation",
        }),
        method: "GET",
      });
    } finally {
      this.sid = null;
    }
  }

  async listShares(): Promise<FileInfo[]> {
    const resp = await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.List",
        version: "2",
        method: "list_share",
        additional: '["time","size"]',
      }),
      method: "GET",
    });
    const data = this.parseJson(resp, "listShares");
    if (!data.success) throw new Error(`list_share failed: ${JSON.stringify(data.error)}`);
    return data.data.shares;
  }

  async listFolder(folderPath: string): Promise<FileInfo[]> {
    const resp = await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.List",
        version: "2",
        method: "list",
        folder_path: folderPath,
        additional: '["time","size"]',
        sort_by: "name",
        sort_direction: "asc",
      }),
      method: "GET",
    });
    const data = this.parseJson(resp, "listFolder");
    if (!data.success) throw new Error(`list failed: ${JSON.stringify(data.error)}`);
    return data.data.files;
  }

  async isBareGitRepo(folderPath: string): Promise<boolean> {
    try {
      const files = await this.listFolder(folderPath);
      const names = new Set(files.map((f) => f.name));
      const hasDir = (name: string) => files.some((f) => f.name === name && f.isdir);
      return names.has("HEAD") && hasDir("objects") && hasDir("refs");
    } catch (e) {
      throw new Error(`Could not validate bare Git repo: ${(e as Error).message}`);
    }
  }

  async listAllFiles(basePath: string): Promise<FileInfo[]> {
    const all: FileInfo[] = [];
    let frontier: string[] = [basePath];
    const BATCH = 5;

    while (frontier.length > 0) {
      const next: string[] = [];

      for (let i = 0; i < frontier.length; i += BATCH) {
        const slice = frontier.slice(i, i + BATCH);
        const settled = await Promise.allSettled(
          slice.map((folder) => this.listFolder(folder)),
        );

        for (let j = 0; j < settled.length; j++) {
          const folder = slice[j];
          const r = settled[j];
          if (r.status === "rejected") {
            // One folder failed — log it and continue. A single permission
            // hiccup or transient API error must not abort the whole scan.
            debugLog(`listAllFiles: skipping ${folder} after listFolder error: ${(r.reason as Error).message}`);
            continue;
          }
          for (const f of r.value) {
            if (f.isdir) {
              next.push(f.path);
            } else {
              all.push(f);
            }
          }
        }
      }

      frontier = next;
    }

    return all;
  }

  async download(filePath: string): Promise<ArrayBuffer> {
    // DSM may gzip File Station download responses on iOS/WebKit. Request
    // identity transfer encoding and trust arrayBuffer when its length matches
    // the declared content length. Only fall back to one-byte text
    // reconstruction when arrayBuffer length is wrong; decoding arbitrary Git
    // object bytes as text can corrupt high-bit bytes while preserving length.
    const started = Date.now();
    let resp: RequestUrlResponse;
    try {
      resp = await requestUrl({
        url: this.url("", {
          api: "SYNO.FileStation.Download",
          version: "2",
          method: "download",
          path: filePath,
          mode: "download",
        }),
        method: "GET",
        headers: { "Accept-Encoding": "identity" },
        throw: false,
      });
    } catch (e) {
      debugLog(`download failed before response path=${filePath} endpoint=${this.endpointKind()} elapsedMs=${Date.now() - started} error=${(e as Error).message}`);
      throw e;
    }
    if (resp.status !== 200) {
      throw new Error(`download failed for ${filePath}: HTTP ${resp.status}`);
    }
    const headers = (resp as unknown as { headers?: Record<string, string> }).headers;
    const ct = ((headers?.["content-type"] ?? headers?.["Content-Type"]) || "").toLowerCase();
    if (ct.includes("application/json") || ct.includes("text/html")) {
      const preview = new TextDecoder().decode(new Uint8Array(resp.arrayBuffer).slice(0, 200));
      throw new Error(`download for ${filePath} returned ${ct} instead of file bytes: ${preview}`);
    }

    const contentLength = Number(headers?.["content-length"] ?? headers?.["Content-Length"]);
    const bodyBytes = new Uint8Array(resp.arrayBuffer);
    if (bodyBytes.byteLength >= 1024 * 1024 || Date.now() - started > 10_000) {
      debugLog(`download complete path=${filePath} endpoint=${this.endpointKind()} status=${resp.status} bytes=${bodyBytes.byteLength} contentLength=${Number.isFinite(contentLength) ? contentLength : "absent"} elapsedMs=${Date.now() - started} contentType=${ct || "absent"}`);
    }
    if (!Number.isFinite(contentLength) || bodyBytes.byteLength === contentLength) {
      return resp.arrayBuffer;
    }

    const bodyText = (resp as unknown as { text?: string }).text;
    if (bodyText !== undefined && bodyText.length === contentLength) {
      const bytes = new Uint8Array(bodyText.length);
      for (let i = 0; i < bodyText.length; i++) bytes[i] = bodyText.charCodeAt(i) & 0xff;
      return bytes.buffer;
    }

    return resp.arrayBuffer;
  }

  async upload(destFolder: string, fileName: string, content: ArrayBuffer, createParents: boolean = true, mtime?: number): Promise<void> {
    // File Station upload uses multipart form data
    const boundary = "----SynologySync" + Date.now().toString(36);
    const encoder = new TextEncoder();

    const parts: Uint8Array[] = [];

    const addField = (name: string, value: string) => {
      parts.push(encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    };

    addField("api", "SYNO.FileStation.Upload");
    addField("version", "2");
    addField("method", "upload");
    addField("path", destFolder);
    addField("create_parents", createParents ? "true" : "false");
    addField("overwrite", "true");
    if (mtime) addField("mtime", Math.floor(mtime / 1000).toString());

    // File part
    parts.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    parts.push(new Uint8Array(content));
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

    // Combine parts
    let totalLen = 0;
    for (const p of parts) totalLen += p.length;
    const body = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      body.set(p, offset);
      offset += p.length;
    }

    const url = `${this.config.baseUrl}/webapi/entry.cgi?_sid=${this.sid}`;
    const resp = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.buffer,
    });

    const uploadData = this.parseJson(resp, "upload");
    if (!uploadData.success) {
      throw new Error(`Upload failed for ${fileName}: ${JSON.stringify(uploadData.error)}`);
    }
  }

  async createFolder(folderPath: string, name: string): Promise<void> {
    await this.createFolderInternal(folderPath, name, true, false);
  }

  // Strict create-if-absent intended as the lock-acquire primitive for the
  // Git-backed File Station write path. Atomicity is assumed to be provided by
  // DSM serializing concurrent CreateFolder calls with force_parent=false; this
  // assumption is not yet validated by a multi-writer concurrency test, and the
  // lease layer built on top must not treat it as a guarantee. Callers must
  // ensure the parent directory exists separately — when the parent is missing
  // DSM returns a non-exists error code which surfaces as a FileStationApiError
  // (distinct from FileStationPathExistsError) so lock contention can be told
  // apart from a missing lock directory without string-matching.
  async createFolderStrict(folderPath: string, name: string): Promise<void> {
    await this.createFolderInternal(folderPath, name, false, true);
  }

  private async createFolderInternal(folderPath: string, name: string, forceParent: boolean, failIfExists: boolean): Promise<void> {
    const label = failIfExists ? "createFolderStrict" : "createFolder";
    const resp = await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.CreateFolder",
        version: "2",
        method: "create",
        folder_path: JSON.stringify([folderPath]),
        name: JSON.stringify([name]),
        force_parent: forceParent ? "true" : "false",
      }),
      method: "GET",
      throw: false,
    });
    const cfData = this.parseJson(resp, label);
    if (cfData.success) return;

    const errCode = findFileStationErrorCode(cfData.error, (code) => code === 1100 || code === 414);
    const alreadyExists = errCode === 1100 || errCode === 414;
    if (alreadyExists) {
      if (failIfExists) {
        throw new FileStationPathExistsError(`${label} failed because ${folderPath}/${name} already exists`, errCode);
      }
      // Legacy idempotent path: ignore "already exists" (1100) / "folder
      // exists" (414) for non-strict callers.
      return;
    }
    const failureCode = findFileStationErrorCode(cfData.error);
    throw new FileStationApiError(`${label} failed: ${JSON.stringify(cfData.error)}`, failureCode);
  }

  async delete(path: string): Promise<void> {
    const resp = await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.Delete",
        version: "2",
        method: "delete",
        path,
        recursive: "true",
      }),
      method: "GET",
      throw: false,
    });
    const data = this.parseJson(resp, "delete");
    if (!data.success) {
      if (data.error?.code === 408) return; // 408 = no such file — already deleted
      throw new Error(`delete failed for ${path}: ${JSON.stringify(data.error)}`);
    }
  }

  isLoggedIn(): boolean {
    return this.sid !== null;
  }
}
