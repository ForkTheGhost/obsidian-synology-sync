import { requestUrl } from "obsidian";
import { FileStation } from "../src/filestation";

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
      expect(err.message).toMatch(/HTML page/);
      expect(err.message).toMatch(/device token/);
    });

    it("clears the saved device token after detecting an HTML login response", async () => {
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

      await expect(fs.login()).rejects.toThrow(/HTML page/);
      // The constructor stored a reference; verify the internal config was cleared.
      expect((fs as unknown as { config: { deviceToken?: string } }).config.deviceToken).toBeUndefined();
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
  });
});
