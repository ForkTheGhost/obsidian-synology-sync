import { requestUrl } from "obsidian";
import { probeQuickConnectCandidates, resolveQuickConnect, resolveQuickConnectCandidates } from "../src/quickconnect";

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
          relay_ip: "198.51.100.30",
          relay_dualstack: "relay-api.example.quickconnect.to",
          relay_dn: "relay-api.example.quickconnect.to",
          relay_port: 443,
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

function quickConnectResponseWithoutRelay() {
  return {
    status: 200,
    json: [
      {
        command: "get_server_info",
        env: {
          relay_region: "us",
          control_host: "example.control.quickconnect.to",
        },
        server: {
          serverID: "Example-NAS",
          interface: [{ ip: "192.0.2.10" }],
          external: { ip: "198.51.100.20" },
        },
        service: {
          port: 5001,
          ext_port: 0,
          pingpong: "DISCONNECTED",
          pingpong_desc: [],
        },
        smartdns: {
          host: "EXAMPLE-NAS.direct.quickconnect.to",
          external: "syn4-opaque-198-51-100-20.EXAMPLE-NAS.direct.quickconnect.to",
          lan: ["192-0-2-10.EXAMPLE-NAS.direct.quickconnect.to"],
        },
      },
    ],
  };
}

function quickConnectTunnelResponse() {
  return {
    status: 200,
    json: [
      {
        command: "request_tunnel",
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
          ext_port: 0,
          relay_ip: "198.51.100.30",
          relay_dualstack: "synr-us5.EXAMPLE-NAS.direct.quickconnect.to",
          relay_dn: "synr-us5.EXAMPLE-NAS.direct.quickconnect.to",
          relay_port: 32836,
        },
        smartdns: {
          host: "EXAMPLE-NAS.direct.quickconnect.to",
          external: "syn4-opaque-198-51-100-20.EXAMPLE-NAS.direct.quickconnect.to",
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

  it("prefers the SmartDNS LAN host when relay region is returned", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponse())
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true },
      });

    const resolved = await resolveQuickConnect("Example-NAS");

    expect(resolved).toEqual({
      host: "192-0-2-10.EXAMPLE-NAS.direct.quickconnect.to",
      port: 5001,
      https: true,
      relay: undefined,
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, {
      url: "https://192-0-2-10.EXAMPLE-NAS.direct.quickconnect.to:5001/webman/pingpong.cgi?action=cors&quickconnect=true",
      method: "GET",
      throw: false,
    });
  });

  it("uses the relay API tunnel instead of browser portal when no candidate passes ping-pong", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponse())
      .mockResolvedValue({
        status: 404,
        json: { success: false },
      });

    await expect(resolveQuickConnect("Example-NAS")).resolves.toEqual({
      host: "relay-api.example.quickconnect.to",
      port: 443,
      https: true,
      relay: undefined,
    });
  });


  it("uses the QuickConnect relay API tunnel before falling back to browser portal", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponse())
      .mockResolvedValueOnce({ status: 404, json: { success: false } })
      .mockResolvedValueOnce({ status: 404, json: { success: false } })
      .mockResolvedValueOnce({ status: 404, json: { success: false } })
      .mockResolvedValueOnce({ status: 404, json: { success: false } })
      .mockResolvedValueOnce({ status: 200, json: { success: true } });

    await expect(resolveQuickConnect("Example-NAS")).resolves.toEqual({
      host: "relay-api.example.quickconnect.to",
      port: 443,
      https: true,
      relay: undefined,
    });
    expect(mockedRequestUrl).toHaveBeenNthCalledWith(6, {
      url: "https://relay-api.example.quickconnect.to:443/webman/pingpong.cgi?action=cors&quickconnect=true",
      method: "GET",
      throw: false,
    });
  });

  it("requests tunnel metadata when server-info omits relay API fields", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponseWithoutRelay())
      .mockResolvedValueOnce(quickConnectTunnelResponse());

    const candidates = await resolveQuickConnectCandidates("Example-NAS");

    expect(mockedRequestUrl).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: "https://example.control.quickconnect.to/Serv.php",
      method: "POST",
    }));
    expect(candidates).toContainEqual(expect.objectContaining({
      host: "synr-us5.EXAMPLE-NAS.direct.quickconnect.to",
      port: 32836,
      https: true,
      kind: "relay-api",
      source: "relay-dualstack",
    }));
  });

  it("uses request_tunnel relay API when direct 5001 candidates fail", async () => {
    mockedRequestUrl.mockImplementation((opts: { url: string }) => {
      if (opts.url === "https://global.quickconnect.to/Serv.php") {
        return Promise.resolve(quickConnectResponseWithoutRelay());
      }
      if (opts.url === "https://example.control.quickconnect.to/Serv.php") {
        return Promise.resolve(quickConnectTunnelResponse());
      }
      if (opts.url === "https://synr-us5.EXAMPLE-NAS.direct.quickconnect.to:32836/webman/pingpong.cgi?action=cors&quickconnect=true") {
        return Promise.resolve({ status: 200, json: { success: true } });
      }
      return Promise.resolve({ status: 404, json: { success: false } });
    });

    await expect(resolveQuickConnect("Example-NAS")).resolves.toEqual({
      host: "synr-us5.EXAMPLE-NAS.direct.quickconnect.to",
      port: 32836,
      https: true,
      relay: undefined,
    });
  });

  it("orders portal/raw external after API-capable direct and relay candidates", async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(quickConnectResponse())
      .mockResolvedValueOnce(quickConnectTunnelResponse());

    const candidates = await resolveQuickConnectCandidates("Example-NAS");

    expect(candidates.map((c) => c.source)).toEqual([
      "smartdns-lan",
      "raw-lan",
      "smartdns-external",
      "smartdns-host",
      "relay-dualstack",
      "relay-ip",
      "portal",
      "raw-external",
    ]);
  });

  it("falls through to a later relay when an earlier LAN candidate hangs", async () => {
    jest.useFakeTimers();
    const lan = { host: "lan.example", port: 5001, https: true, kind: "api" as const, source: "smartdns-lan" as const };
    const relay = { host: "relay.example", port: 443, https: true, kind: "relay-api" as const, source: "relay-dn" as const };
    mockedRequestUrl.mockImplementation((opts: { url: string }) => {
      if (opts.url.includes("lan.example")) return new Promise(() => undefined);
      return Promise.resolve({ status: 200, json: { success: true } });
    });

    const probe = probeQuickConnectCandidates([lan, relay], 50);
    await jest.advanceTimersByTimeAsync(50);

    await expect(probe).resolves.toEqual(relay);
    jest.useRealTimers();
  });

  it("fails clearly when the server-info lookup times out", async () => {
    jest.useFakeTimers();
    mockedRequestUrl.mockReturnValueOnce(new Promise(() => undefined));

    const resolution = resolveQuickConnect("Example-NAS");
    const expectation = expect(resolution).rejects.toThrow("QuickConnect server-info lookup timed out");
    await jest.runAllTimersAsync();

    await expectation;
    jest.useRealTimers();
  });
});
