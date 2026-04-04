import { requestUrl, RequestUrlResponse } from "obsidian";
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
}

export interface LoginResult {
  sid: string;
  deviceId: string;
  deviceToken?: string; // returned on first OTP login; save this for future logins
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
    return `${this.config.baseUrl}/webapi/entry.cgi?${qs.toString()}`;
  }

  async login(): Promise<LoginResult> {
    // Build login params
    const params: Record<string, string> = {
      api: "SYNO.API.Auth",
      version: "7",
      method: "login",
      account: this.config.username,
      passwd: this.config.password,
      session: "FileStation",
      format: "sid",
    };

    // Always request device token capability
    params.enable_device_token = "yes";

    // If we have a saved device token, pass it as device_id to skip 2FA
    if (this.config.deviceToken) {
      params.device_id = this.config.deviceToken;
      params.device_name = "Obsidian Synology Sync";
    }
    // If an OTP code was provided (first-time 2FA setup)
    else if (this.config.otpCode) {
      // DSM 7 two-step auth: first we need the JWT token from a 403 response,
      // then we send OTP + JWT token together.
      if (!this.config.twoFaToken) {
        debugLog("AUTH: Step 1 - getting 2FA JWT token from initial login attempt");
        const step1Resp = await requestUrl({
          url: this.url("", params),
          method: "GET",
        });
        const step1Data = step1Resp.json;
        if (!step1Data.success && step1Data.error?.code === 403) {
          this.config.twoFaToken = step1Data.error.errors?.token;
          debugLog(`AUTH: Got 2FA JWT token: ${redact(this.config.twoFaToken, 10)}`);
        }
      }

      params.otp_code = this.config.otpCode;
      params.device_name = "Obsidian Synology Sync";
      if (this.config.deviceId) {
        params.device_id = this.config.deviceId;
      }
      if (this.config.twoFaToken) {
        params["2FA_token"] = this.config.twoFaToken;
      }
    }

    debugLog(`AUTH: baseUrl=${this.config.baseUrl}`);
    debugLog(`AUTH: user=${this.config.username}`);
    debugLog(`AUTH: password=${redact(this.config.password)}`);
    debugLog(`AUTH: config.deviceToken=${redact(this.config.deviceToken)}`);
    debugLog(`AUTH: config.deviceId=${redact(this.config.deviceId)}`);
    debugLog(`AUTH: config.otpCode=${redact(this.config.otpCode)}`);
    debugLog(`AUTH: params.device_id=${redact(params.device_id)}`);
    debugLog(`AUTH: params.device_name=${params.device_name || "(unset)"}`);
    debugLog(`AUTH: params.enable_device_token=${params.enable_device_token}`);
    debugLog(`AUTH: params.otp_code=${params.otp_code ? "set" : "(unset)"}`);

    const resp = await requestUrl({
      url: this.url("", params),
      method: "GET",
    });

    const data = resp.json;
    debugLog(`AUTH: response success=${data.success}`);
    if (data.success) {
      debugLog(`AUTH: response keys=${Object.keys(data.data || {}).join(",")}`);
      debugLog(`AUTH: sid=${redact(data.data?.sid)}`);
      debugLog(`AUTH: did=${redact(data.data?.did)}`);
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

    // DSM returns device token as 'did' in the response
    const did = data.data.did || data.data.device_id || data.data.device_token;

    return {
      sid: data.data.sid,
      deviceId: params.device_id || this.config.deviceId || "",
      deviceToken: did || undefined,
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
        folder_path: folderPath,
        name,
      }),
      method: "GET",
    });
    // Ignore "already exists" errors
    if (!resp.json.success && resp.json.error?.code !== 1100) {
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
