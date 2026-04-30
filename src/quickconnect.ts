import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { debugLog } from "./debug";

interface QCServerInfo {
  command: string;
  env: {
    relay_region: string;
    control_host: string;
  };
  server: {
    serverID: string;
    interface: Array<{ ip: string; ipv6?: Array<{ address: string }> }>;
    external: { ip: string; ipv6?: string };
    fqdn?: string;
    ddns?: string;
  };
  service: {
    port: number;
    ext_port: number;
    relay_ip?: string;
    relay_port?: number;
    https_ip?: string;
    https_port?: number;
  };
  smartdns?: {
    host: string;
    external?: string;
    lan?: string[];
    lanv6?: string[];
  };
  errno?: number;
}

interface ResolvedNAS {
  host: string;
  port: number;
  https: boolean;
}

const PING_TIMEOUT_MS = 3000;

function normalizeQuickConnectId(quickConnectId: string): string {
  return quickConnectId.trim().toLowerCase();
}

function addCandidate(candidates: ResolvedNAS[], candidate: ResolvedNAS): void {
  if (!candidate.host || !candidate.port) return;
  const key = `${candidate.https ? "https" : "http"}://${candidate.host.toLowerCase()}:${candidate.port}`;
  const exists = candidates.some((c) =>
    `${c.https ? "https" : "http"}://${c.host.toLowerCase()}:${c.port}` === key
  );
  if (!exists) candidates.push(candidate);
}

async function requestUrlWithTimeout(url: string, timeoutMs: number): Promise<RequestUrlResponse> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestUrl({ url, method: "GET", throw: false }),
      new Promise<RequestUrlResponse>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error("QuickConnect ping timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

export async function resolveQuickConnect(quickConnectId: string): Promise<ResolvedNAS> {
  debugLog(`QC: resolving "${quickConnectId}"`);
  const normalizedQuickConnectId = normalizeQuickConnectId(quickConnectId);
  const body = JSON.stringify([
    {
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal_https",
      serverID: quickConnectId,
      is_gofile: false,
    },
    {
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal",
      serverID: quickConnectId,
      is_gofile: false,
    },
  ]);

  const resp = await requestUrl({
    url: "https://global.quickconnect.to/Serv.php",
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });

  const results: QCServerInfo[] = resp.json;
  if (!results || results.length === 0) {
    throw new Error("QuickConnect returned empty response");
  }

  // Build candidate list ordered by preference.
  // SmartDNS hostnames have valid wildcard certs under *.direct.quickconnect.to,
  // so HTTPS works without self-signed cert errors (even for LAN IPs).
  const candidates: ResolvedNAS[] = [];

  for (const info of results) {
    if (info.errno) continue;
    const svc = info.service;
    const srv = info.server;
    const dns = info.smartdns;

    // 1. Regional QuickConnect portal host. This is the same hostname Synology
    // redirects browsers to and can remain reachable when direct candidates are not.
    if (info.env?.relay_region) {
      addCandidate(candidates, {
        host: `${normalizedQuickConnectId}.${info.env.relay_region}.quickconnect.to`,
        port: 443,
        https: true,
      });
    }

    // 2. SmartDNS LAN hostnames (best: valid cert + LAN speed)
    //    e.g. 192-168-1-201.MY-NAS.direct.quickconnect.to
    if (dns?.lan) {
      for (const lanHost of dns.lan) {
        addCandidate(candidates, { host: lanHost, port: svc.port, https: true });
      }
    }

    // 3. SmartDNS external hostname (valid cert + WAN)
    if (dns?.external) {
      const port = svc.ext_port || svc.port;
      addCandidate(candidates, { host: dns.external, port, https: true });
    }

    // 4. SmartDNS base host (fallback)
    if (dns?.host) {
      addCandidate(candidates, { host: dns.host, port: svc.port, https: true });
    }

    // 5. HTTPS relay (tunnel through Synology's relay servers)
    if (svc.https_ip && svc.https_port) {
      addCandidate(candidates, { host: svc.https_ip, port: svc.https_port, https: true });
    }

    // 6. FQDN / DDNS
    if (srv.fqdn && srv.fqdn !== "NULL") {
      const port = svc.ext_port || svc.port;
      addCandidate(candidates, { host: srv.fqdn, port, https: true });
    }
    if (srv.ddns && srv.ddns !== "NULL") {
      const port = svc.ext_port || svc.port;
      addCandidate(candidates, { host: srv.ddns, port, https: true });
    }

    // 7. Raw LAN IPs over HTTP (no cert needed, but unencrypted)
    if (srv.interface) {
      for (const iface of srv.interface) {
        if (iface.ip) {
          addCandidate(candidates, { host: iface.ip, port: svc.port, https: false });
        }
      }
    }

    // 8. Raw external IP (last resort)
    if (srv.external?.ip && srv.external.ip !== "0.0.0.0") {
      const port = svc.ext_port || svc.port;
      if (port) {
        addCandidate(candidates, { host: srv.external.ip, port, https: false });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`QuickConnect could not resolve "${quickConnectId}"`);
  }

  debugLog(`QC: ${candidates.length} candidates built`);
  candidates.forEach((c, i) => debugLog(`QC:   [${i}] ${c.https ? "https" : "http"}://${c.host}:${c.port}`));

  // Ping-pong test candidates in parallel groups for speed.
  // Test SmartDNS candidates first (valid certs), then fallbacks.
  debugLog(`QC: ping-pong testing ${candidates.length} candidates...`);

  for (const c of candidates) {
    const proto = c.https ? "https" : "http";
    const url = `${proto}://${c.host}:${c.port}/webman/pingpong.cgi?action=cors&quickconnect=true`;
    try {
      const r = await requestUrlWithTimeout(url, PING_TIMEOUT_MS);
      if (r.status === 200 && r.json?.success) {
        debugLog(`QC: reachable: ${proto}://${c.host}:${c.port}`);
        return c;
      }
      debugLog(`QC: not reachable (status ${r.status}): ${c.host}`);
    } catch {
      debugLog(`QC: not reachable (timeout/error): ${c.host}`);
    }
  }

  // If ping-pong fails on all, return first candidate as best guess
  return candidates[0];
}
