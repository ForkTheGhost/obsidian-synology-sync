import { requestUrl } from "obsidian";
import { FileStation, FileStationApiError, FileStationPathExistsError } from "../src/filestation";

const mockedRequestUrl = requestUrl as jest.Mock;

describe("FileStation", () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset();
  });

  it("uses POST auth flow for QuickConnect relay endpoints", async () => {
    mockedRequestUrl
      .mockRejectedValueOnce(new Error("invalid json '<'"))
      .mockResolvedValueOnce({
        status: 200,
        json: {
          success: true,
          data: {
            sid: "sid-123",
            device_id: "device-token-123",
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true, data: { model: "DS", version_string: "DSM 7" } },
      });

    const fs = new FileStation({
      baseUrl: "https://example-nas.us5.quickconnect.to:443",
      username: "user",
      password: "pass",
      otpCode: "123456",
      quickConnectRelay: true,
    });

    await expect(fs.login()).resolves.toEqual({
      sid: "sid-123",
      deviceId: "",
      deviceToken: "device-token-123",
    });

    expect(mockedRequestUrl).toHaveBeenNthCalledWith(1, {
      url: "https://example-nas.us5.quickconnect.to:443/",
      method: "GET",
      throw: false,
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, {
      url: "https://example-nas.us5.quickconnect.to:443/webapi/entry.cgi",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: expect.stringContaining("api=SYNO.API.Auth"),
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, expect.objectContaining({
      body: expect.stringContaining("client=browser"),
    }));
  });

  it("fails clearly when relay auth times out", async () => {
    jest.useFakeTimers();
    mockedRequestUrl
      .mockRejectedValueOnce(new Error("invalid json '<'"))
      .mockReturnValueOnce(new Promise(() => undefined));

    const fs = new FileStation({
      baseUrl: "https://example-nas.us5.quickconnect.to:443",
      username: "user",
      password: "pass",
      quickConnectRelay: true,
    });

    const login = fs.login();
    const expectation = expect(login).rejects.toThrow("relay entry.cgi login request timed out");
    await jest.runAllTimersAsync();

    await expectation;
    jest.useRealTimers();
  });

  describe("login HTML hardening", () => {
    it("throws an actionable error when direct login returns an HTML body with HTTP 200", async () => {
      // 200 OK with an HTML portal page — the failure mode we hit when a
      // device token expires after ~11 days idle. resp.json must NEVER be
      // touched on this path; if it were, this getter would throw and the
      // test would observe a different message.
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
        text: "<!DOCTYPE html><html><body>Login portal</body></html>",
        get json() {
          throw new Error("JSON Parse error: Unrecognized token '<'");
        },
      });

      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "user",
        password: "pass",
        deviceToken: "stale-token",
      });

      const err = await fs.login().then(
        () => { throw new Error("expected login() to reject"); },
        (e: Error) => e,
      );
      expect(err.message).toMatch(/browser page/);
      expect(err.message).toMatch(/File Station API JSON/);
      expect(fs.getLastAuthState()).toMatchObject({
        responseKind: "html_portal",
        persistedTokenAction: "keep",
      });
    });

    it("keeps the saved device token after an HTML endpoint/relay-shape response", async () => {
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "text/html" },
        text: "<!DOCTYPE html><html></html>",
      });

      const cfg = {
        baseUrl: "https://nas.local:5001",
        username: "user",
        password: "pass",
        deviceToken: "old-token",
      };
      const fs = new FileStation(cfg);

      await expect(fs.login()).rejects.toThrow(/browser page/);
      // HTML/browser portal is not proof of stale-token rejection. Keep it until DSM returns JSON 403.
      expect((fs as unknown as { config: { deviceToken?: string } }).config.deviceToken).toBe("old-token");
      expect(fs.getLastAuthState()).toMatchObject({
        responseKind: "html_portal",
        persistedTokenAction: "keep",
      });
    });

    it("retries without the device token when DSM rejects it with code 403", async () => {
      mockedRequestUrl
        // First attempt: 403 because the saved device_id is no longer trusted.
        .mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ success: false, error: { code: 403 } }),
          json: { success: false, error: { code: 403 } },
        })
        // Retry without device_id: success.
        .mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({
            success: true,
            data: { sid: "new-sid", device_id: "new-token" },
          }),
          json: {
            success: true,
            data: { sid: "new-sid", device_id: "new-token" },
          },
        })
        // DSM info probe (best-effort).
        .mockResolvedValueOnce({
          status: 200,
          json: { success: true, data: { model: "DS", version_string: "DSM 7" } },
        });

      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "user",
        password: "pass",
        deviceToken: "expired-token",
      });

      await expect(fs.login()).resolves.toEqual({
        sid: "new-sid",
        deviceId: "",
        deviceToken: "new-token",
      });
      // Verify the retry call did NOT include the stale device_id.
      const secondCall = mockedRequestUrl.mock.calls[1][0];
      expect(secondCall.url).not.toContain("device_id=expired-token");
    });

    it("throws a clear error when the post-403 retry also fails with 403", async () => {
      mockedRequestUrl
        .mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ success: false, error: { code: 403 } }),
          json: { success: false, error: { code: 403 } },
        })
        .mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ success: false, error: { code: 403 } }),
          json: { success: false, error: { code: 403 } },
        });

      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "user",
        password: "pass",
        deviceToken: "expired-token",
      });

      await expect(fs.login()).rejects.toThrow(/rejected/);
    });


    it("classifies relay HTML as relay repair without clearing token", async () => {
      mockedRequestUrl
        .mockResolvedValueOnce({ status: 200, text: "ok" })
        .mockResolvedValueOnce({
          status: 200,
          headers: { "content-type": "text/html" },
          text: "<!DOCTYPE html><html>Portal</html>",
        });

      const cfg = {
        baseUrl: "https://example-nas.us5.quickconnect.to:443",
        username: "user",
        password: "pass",
        deviceToken: "still-valid-until-json-403",
        quickConnectRelay: true,
      };
      const fs = new FileStation(cfg);

      await expect(fs.login()).rejects.toThrow(/browser page/);
      expect(cfg.deviceToken).toBe("still-valid-until-json-403");
      expect(fs.getLastAuthState()).toMatchObject({
        phase: "repair_relay_session",
        endpointKind: "relay",
        responseKind: "html_portal",
        persistedTokenAction: "keep",
        nextAction: "repair_relay_or_choose_endpoint",
      });
    });

    it("records replacement-token persistence state after OTP success", async () => {
      mockedRequestUrl
        .mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ success: true, data: { sid: "sid-otp", device_id: "replacement-token" } }),
        })
        .mockResolvedValueOnce({ status: 200, json: { success: true, data: { model: "DS" } } });

      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "user",
        password: "pass",
        otpCode: "123456",
      });

      await expect(fs.login()).resolves.toMatchObject({ deviceToken: "replacement-token" });
      expect(fs.getLastAuthState()).toMatchObject({
        phase: "persist_replacement_token",
        responseKind: "dsm_json_success",
        persistedTokenAction: "replace",
        nextAction: "save_token",
      });
    });

    it("parseJson helper surfaces a clear error when listFolder receives an HTML body", async () => {
      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "u",
        password: "p",
      });
      (fs as unknown as { sid: string }).sid = "test-sid";

      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        text: "<html><body>Login required</body></html>",
        // If this were touched, the test would see a different message.
        get json() {
          throw new Error("JSON Parse error: Unrecognized token '<'");
        },
      });

      await expect(fs.listFolder("/root")).rejects.toThrow(/NAS returned an HTML page/);
    });
  });

  describe("createFolderStrict", () => {
    function makeFs(): FileStation {
      const fs = new FileStation({ baseUrl: "https://nas.local:5001", username: "u", password: "p" });
      (fs as unknown as { sid: string }).sid = "test-sid";
      return fs;
    }

    function lastCreateFolderParams(): URLSearchParams {
      const call = mockedRequestUrl.mock.calls[mockedRequestUrl.mock.calls.length - 1][0] as { url: string };
      return new URL(call.url).searchParams;
    }

    it("fails on existing folder without forcing parent creation", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: 414 } },
      });

      await expect(fs.createFolderStrict("/repo.git/.synology-sync/locks", "main.lock")).rejects.toBeInstanceOf(FileStationPathExistsError);
      expect(mockedRequestUrl).toHaveBeenCalledWith(expect.objectContaining({
        method: "GET",
        throw: false,
      }));
      const params = lastCreateFolderParams();
      expect(params.get("force_parent")).toBe("false");
      expect(params.get("folder_path")).toBe(JSON.stringify(["/repo.git/.synology-sync/locks"]));
      expect(params.get("name")).toBe(JSON.stringify(["main.lock"]));
    });

    it("recognizes nested File Station already-exists detail codes under generic errors", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: 400, errors: [{ code: 1100 }] } },
      });

      await expect(fs.createFolderStrict("/repo.git/.synology-sync/locks", "main.lock")).rejects.toMatchObject({
        name: "FileStationPathExistsError",
        code: 1100,
      });
    });

    it("recognizes numeric string already-exists codes from File Station", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: "414" } },
      });

      await expect(fs.createFolderStrict("/repo.git/.synology-sync/locks", "main.lock")).rejects.toMatchObject({
        name: "FileStationPathExistsError",
        code: 414,
      });
    });

    it("preserves legacy createFolder behavior by forcing parents and ignoring already-exists", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: 414 } },
      });

      await expect(fs.createFolder("/repo.git/.synology-sync/locks", "main.lock")).resolves.toBeUndefined();
      const params = lastCreateFolderParams();
      expect(params.get("force_parent")).toBe("true");
    });

    it("throws FileStationApiError (not PathExists) when the parent directory is missing", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: 408 } },
      });

      const err = await fs.createFolderStrict("/missing/locks", "main.lock").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FileStationApiError);
      expect(err).not.toBeInstanceOf(FileStationPathExistsError);
      expect((err as FileStationApiError).code).toBe(408);
    });

    it("throws FileStationApiError with the surfaced code for other failure modes", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: 119 } }, // 119 = sid expired
      });

      const err = await fs.createFolderStrict("/repo.git/.synology-sync/locks", "main.lock").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FileStationApiError);
      expect((err as FileStationApiError).code).toBe(119);
    });

    it("does not treat unrelated nested `code` properties as the FileStation error code", async () => {
      const fs = makeFs();
      // A future response shape might include a `code` inside an unrelated
      // metadata field. The tightened extractor must only walk
      // `error.code` and `error.errors[].code`, so this is a generic failure
      // — not an already-exists.
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { success: false, error: { code: 400, metadata: { code: 1100 } } },
      });

      const err = await fs.createFolderStrict("/repo.git/.synology-sync/locks", "main.lock").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FileStationApiError);
      expect(err).not.toBeInstanceOf(FileStationPathExistsError);
      expect((err as FileStationApiError).code).toBe(400);
    });
  });

  describe("bare Git repo validation", () => {
    it("detects a valid bare repository by HEAD, objects, and refs", async () => {
      const fs = new FileStation({ baseUrl: "https://nas.local:5001", username: "u", password: "p" });
      jest.spyOn(fs, "listFolder").mockResolvedValue([
        { path: "/repo.git/HEAD", name: "HEAD", isdir: false },
        { path: "/repo.git/objects", name: "objects", isdir: true },
        { path: "/repo.git/refs", name: "refs", isdir: true },
      ]);

      await expect(fs.isBareGitRepo("/repo.git")).resolves.toBe(true);
    });

    it("rejects normal folders that are not bare repositories", async () => {
      const fs = new FileStation({ baseUrl: "https://nas.local:5001", username: "u", password: "p" });
      jest.spyOn(fs, "listFolder").mockResolvedValue([
        { path: "/Vault/Note.md", name: "Note.md", isdir: false },
        { path: "/Vault/.obsidian", name: ".obsidian", isdir: true },
      ]);

      await expect(fs.isBareGitRepo("/Vault")).resolves.toBe(false);
    });
  });

  describe("listAllFiles", () => {
    function makeListResp(files: Array<{ path: string; name: string; isdir: boolean }>) {
      return {
        status: 200,
        json: { success: true, data: { files } },
      };
    }

    function makeFs(): FileStation {
      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "u",
        password: "p",
      });
      // Skip login: stub a fake sid so url() doesn't blow up.
      // (sid is private; reach in for the test.)
      (fs as unknown as { sid: string }).sid = "test-sid";
      return fs;
    }

    function decodedFolderPath(url: string): string | null {
      const m = url.match(/folder_path=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }

    it("returns successful entries while skipping a folder whose listFolder rejects", async () => {
      const fs = makeFs();

      // Tree: /root → /root/ok (1 file), /root/bad (rejects)
      mockedRequestUrl.mockImplementation((opts: { url: string }) => {
        const fp = decodedFolderPath(opts.url);
        if (fp === "/root") {
          return Promise.resolve(makeListResp([
            { path: "/root/ok", name: "ok", isdir: true },
            { path: "/root/bad", name: "bad", isdir: true },
          ]));
        }
        if (fp === "/root/ok") {
          return Promise.resolve(makeListResp([
            { path: "/root/ok/note.md", name: "note.md", isdir: false },
          ]));
        }
        if (fp === "/root/bad") {
          return Promise.reject(new Error("permission denied"));
        }
        return Promise.reject(new Error(`unexpected url: ${opts.url}`));
      });

      const all = await fs.listAllFiles("/root");
      expect(all).toHaveLength(1);
      expect(all[0].path).toBe("/root/ok/note.md");
    });

    it("processes folders in parallel batches (does not abort on a single failure)", async () => {
      const fs = makeFs();

      mockedRequestUrl.mockImplementation((opts: { url: string }) => {
        const fp = decodedFolderPath(opts.url);
        if (fp === "/root") {
          // 7 child folders to force more than one BATCH=5 slice.
          const children = Array.from({ length: 7 }, (_, i) => ({
            path: `/root/c${i}`,
            name: `c${i}`,
            isdir: true,
          }));
          return Promise.resolve(makeListResp(children));
        }
        const m = fp ? fp.match(/^\/root\/c(\d+)$/) : null;
        if (m) {
          const i = parseInt(m[1], 10);
          if (i === 3) return Promise.reject(new Error("transient")); // one bad
          return Promise.resolve(makeListResp([
            { path: `/root/c${i}/n.md`, name: "n.md", isdir: false },
          ]));
        }
        return Promise.reject(new Error(`unexpected url: ${opts.url}`));
      });

      const all = await fs.listAllFiles("/root");
      // 6 files (one folder failed)
      expect(all).toHaveLength(6);
      expect(all.map((f) => f.path).sort()).toEqual([
        "/root/c0/n.md",
        "/root/c1/n.md",
        "/root/c2/n.md",
        "/root/c4/n.md",
        "/root/c5/n.md",
        "/root/c6/n.md",
      ]);
    });
  });

  describe("delete", () => {
    function makeFs(): FileStation {
      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "u",
        password: "p",
      });
      (fs as unknown as { sid: string }).sid = "test-sid";
      return fs;
    }

    it("succeeds (no throw) when data.success === true", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        text: JSON.stringify({ success: true }),
      });
      await expect(fs.delete("/foo/bar.md")).resolves.toBeUndefined();
    });

    it("throws on a non-408 error code (e.g. 500)", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        text: JSON.stringify({ success: false, error: { code: 500 } }),
      });
      await expect(fs.delete("/foo/bar.md")).rejects.toThrow(/delete failed/);
    });

    it("does NOT throw on error code 408 (already deleted)", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        text: JSON.stringify({ success: false, error: { code: 408 } }),
      });
      await expect(fs.delete("/foo/gone.md")).resolves.toBeUndefined();
    });
  });

  describe("download", () => {
    function makeFs(): FileStation {
      const fs = new FileStation({
        baseUrl: "https://nas.local:5001",
        username: "u",
        password: "p",
      });
      (fs as unknown as { sid: string }).sid = "test-sid";
      return fs;
    }

    it("throws when status !== 200", async () => {
      const fs = makeFs();
      mockedRequestUrl.mockResolvedValueOnce({
        status: 500,
        headers: { "content-type": "application/octet-stream" },
        arrayBuffer: new ArrayBuffer(0),
      });
      await expect(fs.download("/foo/bar.md")).rejects.toThrow(/HTTP 500/);
    });

    it("throws when content-type is application/json (error response)", async () => {
      const fs = makeFs();
      const errBody = new TextEncoder().encode(
        JSON.stringify({ success: false, error: { code: 408 } }),
      ).buffer;
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        arrayBuffer: errBody,
      });
      await expect(fs.download("/foo/bar.md")).rejects.toThrow(/instead of file bytes/);
    });

    it("throws when content-type is text/html (session expired portal)", async () => {
      const fs = makeFs();
      const html = new TextEncoder().encode("<!DOCTYPE html><html></html>").buffer;
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
        arrayBuffer: html,
      });
      await expect(fs.download("/foo/bar.md")).rejects.toThrow(/instead of file bytes/);
    });

    it("returns the arrayBuffer when content-type is application/octet-stream", async () => {
      const fs = makeFs();
      const payload = new TextEncoder().encode("hello world").buffer;
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        arrayBuffer: payload,
      });
      const result = await fs.download("/foo/bar.md");
      expect(result).toBe(payload);
      const text = new TextDecoder().decode(new Uint8Array(result));
      expect(text).toBe("hello world");
    });
    it("requests identity encoding and prefers arrayBuffer when content-length matches", async () => {
      const fs = makeFs();
      const payload = new Uint8Array([0x78, 0x01, 0xfb, 0xff, 0x00, 0x61]);
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.length),
        },
        // Text decoding arbitrary Git object bytes can corrupt high-bit bytes;
        // arrayBuffer is authoritative when its length matches content-length.
        text: "corrupt",
        arrayBuffer: payload.buffer,
      });

      const result = new Uint8Array(await fs.download("/repo.git/objects/aa/bb"));
      expect(result).toEqual(payload);
      expect(mockedRequestUrl).toHaveBeenCalledWith(expect.objectContaining({
        headers: { "Accept-Encoding": "identity" },
      }));
    });

    it("reconstructs binary bytes from one-byte response text only when arrayBuffer length mismatches", async () => {
      const fs = makeFs();
      const payload = new Uint8Array([0x78, 0x9c, 0xfb, 0xff, 0x00, 0x61]);
      mockedRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.length),
        },
        text: Array.from(payload, (b) => String.fromCharCode(b)).join(""),
        arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
      });

      const result = new Uint8Array(await fs.download("/repo.git/objects/aa/bb"));
      expect(result).toEqual(payload);
    });

  });
});
