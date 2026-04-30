import { requestUrl } from "obsidian";
import { resolveQuickConnect } from "../src/quickconnect";

const mockedRequestUrl = requestUrl as jest.Mock;

function quickConnectResponse() {
  return {
    status: 200,
    json: [
      {
        command: "get_server_info",
        env: {
          relay_region: "us5",
          control_host: "example.control.quickconnect.to",
        },
        server: {
          serverID: "Example-NAS",
          interface: [{ ip: "192.0.2.10" }],
          external: { ip: "198.51.100.20" },
        },
        service: {
          port: 5001,
          ext_port: 5001,
        },
        smartdns: {
          host: "EXAMPLE-NAS.direct.quickconnect.to",
          external: "external.example-nas.direct.quickconnect.to",
          lan: ["192-0-2-10.EXAMPLE-NAS.direct.quickconnect.to"],
        },
      },
    ],
  };
}

describe("resolveQuickConnect", () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset();
  });

  it("tries the regional QuickConnect portal host when relay region is returned", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponse())
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true },
      });

    const resolved = await resolveQuickConnect("Example-NAS");

    expect(resolved).toEqual({
      host: "example-nas.us5.quickconnect.to",
      port: 443,
      https: true,
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, {
      url: "https://example-nas.us5.quickconnect.to:443/webman/pingpong.cgi?action=cors&quickconnect=true",
      method: "GET",
      throw: false,
    });
  });

  it("fails clearly when no candidate passes ping-pong", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponse())
      .mockResolvedValue({
        status: 404,
        json: { success: false },
      });

    await expect(resolveQuickConnect("Example-NAS")).rejects.toThrow(
      'QuickConnect could not find a reachable API endpoint for "Example-NAS"'
    );
  });
});
