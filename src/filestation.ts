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

function isLikelyHtmlResponse(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /invalid json/i.test(msg) || /unexpected token\s*</i.test(msg) || msg.includes("<!DOCTYPE") || msg.includes("<html");
}

export class FileStation {
  private config: FileStationConfig;
  private sid: string | null = null;

  constructor(config: FileStationConfig) {
    this.config = config;
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
      return requestUrl({
        url: this.url("", params),
        method: "GET",
      });
    }

    debugLog("AUTH: QuickConnect relay mode; using portal-compatible POST auth flow");
    try {
      await requestUrl({
        url: `${this.config.baseUrl}/`,
        method: "GET",
        throw: false,
      });
    } catch {
      debugLog("AUTH: relay portal bootstrap returned non-JSON/HTML; continuing to auth endpoint");
    }

    return requestUrl({
      url: `${this.config.baseUrl}/webapi/auth.cgi`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams(params).toString(),
    });
  }

  async login(): Promise<LoginResult> {
    const params = this.buildLoginParams();

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
      if (isLikelyHtmlResponse(e)) {
        debugLog("AUTH: login endpoint returned HTML/non-JSON; selected baseUrl is not a File Station API endpoint");
        throw new Error("Synology login failed: selected QuickConnect endpoint returned HTML instead of File Station API JSON");
      }
      debugLog(`AUTH: request failed: ${(e as Error).message}`);
      throw e;
    }

    const data = resp.json;
    if (!data || typeof data !== "object") {
      debugLog("AUTH: response was not JSON object");
      throw new Error("Synology login failed: File Station API returned a non-JSON response");
    }
    debugLog(`AUTH: response success=${data.success}`);
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

    return {
      sid: data.data.sid,
      deviceId: this.config.deviceId || "",
      deviceToken: deviceToken || undefined,
    };
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
    if (!resp.json.success) throw new Error(`list_share failed: ${JSON.stringify(resp.json.error)}`);
    return resp.json.data.shares;
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
    if (!resp.json.success) throw new Error(`list failed: ${JSON.stringify(resp.json.error)}`);
    return resp.json.data.files;
  }

  async listAllFiles(basePath: string): Promise<FileInfo[]> {
    const all: FileInfo[] = [];
    const queue: string[] = [basePath];

    while (queue.length > 0) {
      const folder = queue.shift()!;
      const files = await this.listFolder(folder);
      for (const f of files) {
        if (f.isdir) {
          queue.push(f.path);
        } else {
          all.push(f);
        }
      }
    }
    return all;
  }

  async download(filePath: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.Download",
        version: "2",
        method: "download",
        path: filePath,
        mode: "download",
      }),
      method: "GET",
    });
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

    if (!resp.json.success) {
      throw new Error(`Upload failed for ${fileName}: ${JSON.stringify(resp.json.error)}`);
    }
  }

  async createFolder(folderPath: string, name: string): Promise<void> {
    const resp = await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.CreateFolder",
        version: "2",
        method: "create",
        folder_path: JSON.stringify([folderPath]),
        name: JSON.stringify([name]),
        force_parent: "true",
      }),
      method: "GET",
    });
    // Ignore "already exists" (1100) and "folder exists" (414) errors
    const errCode = resp.json.error?.code;
    if (!resp.json.success && errCode !== 1100 && errCode !== 414) {
      throw new Error(`createFolder failed: ${JSON.stringify(resp.json.error)}`);
    }
  }

  async delete(path: string): Promise<void> {
    await requestUrl({
      url: this.url("", {
        api: "SYNO.FileStation.Delete",
        version: "2",
        method: "delete",
        path,
        recursive: "true",
      }),
      method: "GET",
    });
  }

  isLoggedIn(): boolean {
    return this.sid !== null;
  }
}
