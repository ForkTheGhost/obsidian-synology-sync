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
});
