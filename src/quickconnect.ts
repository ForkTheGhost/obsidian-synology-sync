import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { debugLog } from "./debug";

interface QCServerInfo {
  command: string;
  env?: {
    relay_region?: string;
    control_host?: string;
  };
  server?: {
    serverID?: string;
    interface?: Array<{ ip: string; ipv6?: Array<{ address: string }> }>;
    external?: { ip?: string; ipv6?: string };
    fqdn?: string;
    ddns?: string;
  };
  service?: {
    port?: number;
    ext_port?: number;
    relay_ip?: string;
    relay_port?: number;
    relay_dualstack?: string;
    relay_dn?: string;
    relay_ipv6?: string;
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

export interface ResolvedNAS {
  host: string;
  port: number;
  https: boolean;
  relay?: boolean;
}

export interface QCCandidate extends ResolvedNAS {
  kind: "portal" | "api" | "relay-api";
  source?: "portal" | "smartdns-lan" | "smartdns-external" | "smartdns-host" | "relay-dualstack" | "relay-dn" | "relay-ip" | "relay-ipv6" | "https-ip" | "fqdn" | "ddns" | "raw-lan" | "raw-external";
}

const LOOKUP_TIMEOUT_MS = 10000;
const REQUEST_TUNNEL_TIMEOUT_MS = 10000;
const PING_FAST_TIMEOUT_MS = 5000;
const PING_SLOW_TIMEOUT_MS = 30000;
const QUICKCONNECT_SERVER_INFO_IDS = ["dsm_portal_https", "dsm_portal"];
const QUICKCONNECT_TUNNEL_IDS = ["dsm_portal_https", "mainapp_https"];

function normalizeQuickConnectId(quickConnectId: string): string {
  return quickConnectId.trim().toLowerCase();
}

function addCandidate(candidates: QCCandidate[], candidate: QCCandidate): void {
  if (!candidate.host || !candidate.port) return;
  const key = `${candidate.https ? "https" : "http"}://${candidate.host.toLowerCase()}:${candidate.port}`;
  const exists = candidates.some((c) =>
    `${c.https ? "https" : "http"}://${c.host.toLowerCase()}:${c.port}` === key
  );
  if (!exists) candidates.push(candidate);
}

function toResolvedNAS(candidate: QCCandidate): ResolvedNAS {
  return {
    host: candidate.host,
    port: candidate.port,
    https: candidate.https,
    relay: candidate.kind === "portal" || undefined,
  };
}

function buildServerInfoBody(quickConnectId: string): string {
  return JSON.stringify(QUICKCONNECT_SERVER_INFO_IDS.map((id) => ({
    version: 1,
    command: "get_server_info",
    stop_when_error: false,
    stop_when_success: false,
    id,
    serverID: quickConnectId,
    is_gofile: false,
  })));
}

function buildRequestTunnelBody(quickConnectId: string, id: string): string {
  return JSON.stringify([{
    version: 1,
    command: "request_tunnel",
    stop_when_error: false,
    stop_when_success: true,
    id,
    serverID: quickConnectId,
    is_gofile: false,
    path: "/",
  }]);
}

function hasServerInfoShape(info: QCServerInfo): boolean {
  return !info.errno && !!info.service && !!info.server && !!info.env?.control_host;
}

function hasRelayApiFields(info: QCServerInfo): boolean {
  return !!info.service?.relay_port && !!(
    info.service.relay_dualstack ||
    info.service.relay_dn ||
    info.service.relay_ip ||
    info.service.relay_ipv6
  );
}

function serviceKeys(info: QCServerInfo): string {
  return info.service ? Object.keys(info.service).sort().join(",") : "(none)";
}

function uniqueControlHosts(results: QCServerInfo[]): string[] {
  const hosts: string[] = [];
  for (const info of results) {
    const host = info.env?.control_host;
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function redactIpList(values: Array<string | undefined> | undefined): string {
  if (!values || values.length === 0) return "(none)";
  return values.filter(Boolean).map((value) => {
    const raw = String(value);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) return raw.replace(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/, "$1.$2.$3.x");
    return raw.replace(/^(\d+-\d+-\d+)-\d+(\..*)$/i, "$1-x$2");
  }).join(",");
}

function isPrivateIpv4(ip: string | undefined): boolean {
  if (!ip) return false;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254);
}

function candidateSourceRank(candidate: QCCandidate): number {
  switch (candidate.source) {
    case "smartdns-lan": return 0;
    case "raw-lan": return 1;
    case "smartdns-external": return 2;
    case "smartdns-host": return 3;
    case "fqdn":
    case "ddns": return 4;
    case "relay-dualstack":
    case "relay-dn":
    case "relay-ip":
    case "relay-ipv6": return 5;
    case "https-ip": return 6;
    case "portal": return 7;
    case "raw-external": return 8;
    default:
      if (candidate.kind === "relay-api") return 5;
      if (candidate.kind === "portal") return 7;
      return 4;
  }
}

export function compareQuickConnectCandidates(a: QCCandidate, b: QCCandidate): number {
  return candidateSourceRank(a) - candidateSourceRank(b);
}

function stableSortCandidates(candidates: QCCandidate[]): QCCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => compareQuickConnectCandidates(a.candidate, b.candidate) || a.index - b.index)
    .map((entry) => entry.candidate);
}

async function requestUrlWithTimeout(
  request: Parameters<typeof requestUrl>[0],
  timeoutMs: number,
  message: string
): Promise<RequestUrlResponse> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestUrl(request),
      new Promise<RequestUrlResponse>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

async function requestTunnelServerInfo(quickConnectId: string, results: QCServerInfo[]): Promise<QCServerInfo[]> {
  if (results.some(hasRelayApiFields)) return [];

  const useful = results.filter(hasServerInfoShape);
  for (const info of useful) {
    debugLog(`QC: server-info has no relay API fields (controlHost=${info.env?.control_host ? "present" : "missing"} relayRegion=${info.env?.relay_region || "(missing)"} serviceKeys=${serviceKeys(info)})`);
  }

  const controlHosts = uniqueControlHosts(useful);
  if (controlHosts.length === 0) {
    debugLog("QC: cannot request QuickConnect relay tunnel; server-info did not include a control host");
    return [];
  }

  for (const controlHost of controlHosts) {
    for (const id of QUICKCONNECT_TUNNEL_IDS) {
      debugLog(`QC: requesting relay tunnel metadata from ${controlHost} (${id})`);
      try {
        const resp = await requestUrlWithTimeout({
          url: `https://${controlHost}/Serv.php`,
          method: "POST",
          body: buildRequestTunnelBody(quickConnectId, id),
          headers: { "Content-Type": "application/json" },
        }, REQUEST_TUNNEL_TIMEOUT_MS, "QuickConnect request_tunnel lookup timed out");

        const tunnelResults: QCServerInfo[] = resp.json;
        if (!Array.isArray(tunnelResults) || tunnelResults.length === 0) {
          debugLog("QC: relay tunnel metadata returned an empty response");
          continue;
        }
        if (tunnelResults.some(hasRelayApiFields)) {
          debugLog("QC: relay tunnel metadata includes relay API fields");
          return tunnelResults;
        }
        debugLog(`QC: relay tunnel metadata did not include relay API fields (serviceKeys=${tunnelResults.map(serviceKeys).join(";")})`);
      } catch (e) {
        debugLog(`QC: relay tunnel metadata lookup failed: ${(e as Error).message}`);
      }
    }
  }

  return [];
}

export async function resolveQuickConnectCandidates(quickConnectId: string, debugResolution = false): Promise<QCCandidate[]> {
  debugLog(`QC: resolving "${quickConnectId}"`);
  const normalizedQuickConnectId = normalizeQuickConnectId(quickConnectId);
  const body = buildServerInfoBody(quickConnectId);

  debugLog("QC: requesting server info from global.quickconnect.to");
  let resp: RequestUrlResponse;
  try {
    resp = await requestUrlWithTimeout({
      url: "https://global.quickconnect.to/Serv.php",
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    }, LOOKUP_TIMEOUT_MS, "QuickConnect server-info lookup timed out");
  } catch (e) {
    debugLog(`QC: server-info lookup failed: ${(e as Error).message}`);
    throw e;
  }
  debugLog("QC: server-info response received");

  let results: QCServerInfo[] = resp.json;
  if (!results || results.length === 0) {
    throw new Error("QuickConnect returned empty response");
  }

  const tunnelResults = await requestTunnelServerInfo(quickConnectId, results);
  if (tunnelResults.length > 0) {
    results = [...tunnelResults, ...results];
  }

  // Build candidate list ordered by preference.
  // SmartDNS hostnames have valid wildcard certs under *.direct.quickconnect.to,
  // so HTTPS works without self-signed cert errors (even for LAN IPs).
  const candidates: QCCandidate[] = [];

  results.forEach((info, index) => {
    if (!debugResolution) return;
    const svc = info.service || {} as QCServerInfo["service"];
    const srv = info.server || {} as QCServerInfo["server"];
    const dns = info.smartdns;
    const interfaceIps = srv.interface?.map((iface) => iface.ip) || [];
    const privateInterfaceCount = interfaceIps.filter(isPrivateIpv4).length;
    const lanDnsPrivateHintCount = (dns?.lan || []).filter((host) => /(^|\.)\d+-\d+-\d+-\d+\./.test(host) || /^192-168-|^10-|^172-(1[6-9]|2\d|3[01])-/.test(host)).length;
    debugLog([
      `QC: server-info[${index}] fields`,
      `errno=${info.errno ?? 0}`,
      `command=${info.command || "(unset)"}`,
      `relay_region=${info.env?.relay_region || "absent"}`,
      `control_host=${info.env?.control_host ? "present" : "absent"}`,
      `service.port=${svc.port || "absent"}`,
      `service.ext_port=${svc.ext_port || "absent"}`,
      `service.relay_port=${svc.relay_port || "absent"}`,
      `service.relay_dn=${svc.relay_dn || "absent"}`,
      `service.relay_ip=${redactIpList([svc.relay_ip])}`,
      `service.relay_dualstack=${svc.relay_dualstack || "absent"}`,
      `service.relay_ipv6=${svc.relay_ipv6 ? "present" : "absent"}`,
      `service.https_ip=${redactIpList([svc.https_ip])}`,
      `service.https_port=${svc.https_port || "absent"}`,
      `smartdns.host=${dns?.host || "absent"}`,
      `smartdns.external=${dns?.external || "absent"}`,
      `smartdns.lan_count=${dns?.lan?.length || 0}`,
      `smartdns.lan=${redactIpList(dns?.lan)}`,
      `server.fqdn=${srv.fqdn && srv.fqdn !== "NULL" ? srv.fqdn : "absent"}`,
      `server.ddns=${srv.ddns && srv.ddns !== "NULL" ? srv.ddns : "absent"}`,
      `server.interface_count=${srv.interface?.length || 0}`,
      `server.private_interface_count=${privateInterfaceCount}`,
      `server.interface_ips=${redactIpList(interfaceIps)}`,
      `server.external=${redactIpList([srv.external?.ip && srv.external.ip !== "0.0.0.0" ? srv.external.ip : undefined])}`,
      `wifi_lan_hint=${privateInterfaceCount > 0 || lanDnsPrivateHintCount > 0 ? "available_lan_candidates" : "none_from_server_info"}`,
    ].join(" "));
  });

  for (const info of results) {
    if (info.errno) continue;
    const svc = info.service;
    const srv = info.server;
    if (!svc || !srv) continue;
    const dns = info.smartdns;

    // 1. Regional QuickConnect portal host. This is the same hostname Synology
    // redirects browsers to and can remain reachable when direct candidates are not.
    if (info.env?.relay_region) {
      addCandidate(candidates, {
        host: `${normalizedQuickConnectId}.${info.env.relay_region}.quickconnect.to`,
        port: 443,
        https: true,
        kind: "portal",
        source: "portal",
      });
    }

    // 2. SmartDNS LAN hostnames (best: valid cert + LAN speed)
    //    e.g. 192-168-1-201.MY-NAS.direct.quickconnect.to
    if (dns?.lan && svc.port) {
      for (const lanHost of dns.lan) {
        addCandidate(candidates, { host: lanHost, port: svc.port, https: true, kind: "api", source: "smartdns-lan" });
      }
    }

    // 3. SmartDNS external hostname (valid cert + WAN)
    if (dns?.external) {
      const port = svc.ext_port || svc.port;
      addCandidate(candidates, { host: dns.external, port, https: true, kind: "api", source: "smartdns-external" });
    }

    // 4. SmartDNS base host (fallback)
    if (dns?.host && svc.port) {
      addCandidate(candidates, { host: dns.host, port: svc.port, https: true, kind: "api", source: "smartdns-host" });
    }

    // 5. QuickConnect relay API tunnel. This is different from the browser
    // portal host. Remote clients often cannot reach any direct endpoint, but
    // File Station APIs can still work through the relay_ip/relay_port tunnel.
    if (svc.relay_port) {
      if (svc.relay_dualstack) addCandidate(candidates, { host: svc.relay_dualstack, port: svc.relay_port, https: true, kind: "relay-api", source: "relay-dualstack" });
      if (svc.relay_dn) addCandidate(candidates, { host: svc.relay_dn, port: svc.relay_port, https: true, kind: "relay-api", source: "relay-dn" });
      if (svc.relay_ip) addCandidate(candidates, { host: svc.relay_ip, port: svc.relay_port, https: true, kind: "relay-api", source: "relay-ip" });
      if (svc.relay_ipv6) addCandidate(candidates, { host: svc.relay_ipv6, port: svc.relay_port, https: true, kind: "relay-api", source: "relay-ipv6" });
    }

    // 6. HTTPS relay / portal-provided API tunnel fallback.
    if (svc.https_ip && svc.https_port) {
      addCandidate(candidates, { host: svc.https_ip, port: svc.https_port, https: true, kind: "api", source: "https-ip" });
    }

    // 7. FQDN / DDNS
    if (srv.fqdn && srv.fqdn !== "NULL") {
      const port = svc.ext_port || svc.port;
      addCandidate(candidates, { host: srv.fqdn, port, https: true, kind: "api", source: "fqdn" });
    }
    if (srv.ddns && srv.ddns !== "NULL") {
      const port = svc.ext_port || svc.port;
      addCandidate(candidates, { host: srv.ddns, port, https: true, kind: "api", source: "ddns" });
    }

    // 8. Raw LAN IPs over HTTP (no cert needed, but unencrypted)
    if (srv.interface && svc.port) {
      for (const iface of srv.interface) {
        if (iface.ip) {
          addCandidate(candidates, { host: iface.ip, port: svc.port, https: false, kind: "api", source: "raw-lan" });
        }
      }
    }

    // 9. Raw external IP (last resort)
    if (srv.external?.ip && srv.external.ip !== "0.0.0.0") {
      const port = svc.ext_port || svc.port;
      if (port) {
        addCandidate(candidates, { host: srv.external.ip, port, https: false, kind: "api", source: "raw-external" });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`QuickConnect could not resolve "${quickConnectId}"`);
  }

  const orderedCandidates = stableSortCandidates(candidates);
  debugLog(`QC: ${orderedCandidates.length} candidates built`);
  orderedCandidates.forEach((c, i) => debugLog(`QC:   [${i}] ${c.https ? "https" : "http"}://${c.host}:${c.port} (${c.kind}${c.source ? ` source=${c.source}` : ""})`));

  return orderedCandidates;
}

async function pingCandidate(candidate: QCCandidate, timeoutMs: number): Promise<boolean> {
  const proto = candidate.https ? "https" : "http";
  const url = `${proto}://${candidate.host}:${candidate.port}/webman/pingpong.cgi?action=cors&quickconnect=true`;
  try {
    const r = await requestUrlWithTimeout({
      url,
      method: "GET",
      throw: false,
    }, timeoutMs, "QuickConnect ping timed out");
    const ok = r.status === 200 && r.json?.success;
    debugLog(`QC: ${ok ? "reachable" : `not reachable (status ${r.status})`}: ${proto}://${candidate.host}:${candidate.port}`);
    return ok;
  } catch {
    debugLog(`QC: not reachable (timeout/error): ${candidate.host}`);
    return false;
  }
}

export async function probeQuickConnectCandidates(candidates: QCCandidate[], timeoutMs = PING_FAST_TIMEOUT_MS): Promise<QCCandidate | null> {
  debugLog(`QC: parallel ping-pong testing ${candidates.length} candidates with ${timeoutMs}ms timeout...`);
  if (candidates.length === 0) return null;

  // Start every probe immediately, but do not wait for all of them when we do
  // not have to. As soon as the earliest still-possible candidate is known to
  // be reachable, return it. Example: if candidate [0] succeeds quickly on LAN,
  // move forward immediately instead of waiting for remote candidates to hit
  // their timeout. If [4] succeeds first, wait only for [0..3] to settle so the
  // original candidate-order preference is preserved.
  const results: Array<boolean | undefined> = new Array(candidates.length);
  let settled = 0;

  return new Promise((resolve) => {
    let done = false;
    const finish = (candidate: QCCandidate | null) => {
      if (done) return true;
      done = true;
      resolve(candidate);
      return true;
    };
    const tryResolve = () => {
      if (done) return true;
      for (let i = 0; i < candidates.length; i++) {
        if (results[i] === true) {
          const candidate = candidates[i];
          debugLog(`QC: selected first reachable candidate [${i}] ${candidate.https ? "https" : "http"}://${candidate.host}:${candidate.port}`);
          return finish(candidate);
        }
        if (results[i] === undefined) return false;
      }
      if (settled === candidates.length) return finish(null);
      return false;
    };

    candidates.forEach((candidate, index) => {
      void pingCandidate(candidate, timeoutMs).then((ok) => {
        if (results[index] !== undefined) return;
        results[index] = ok;
        settled++;
        tryResolve();
      });
    });
  });
}

export async function resolveQuickConnect(quickConnectId: string): Promise<ResolvedNAS> {
  const candidates = await resolveQuickConnectCandidates(quickConnectId);

  let candidate = await probeQuickConnectCandidates(candidates, PING_FAST_TIMEOUT_MS);
  if (!candidate) {
    debugLog(`QC: no candidate passed fast ping-pong; retrying all candidates with ${PING_SLOW_TIMEOUT_MS}ms timeout...`);
    candidate = await probeQuickConnectCandidates(candidates, PING_SLOW_TIMEOUT_MS);
  }
  if (candidate) return toResolvedNAS(candidate);

  const relayApi = candidates.find((c) => c.kind === "relay-api");
  if (relayApi) {
    debugLog(`QC: no candidate passed ping-pong; trying QuickConnect relay API tunnel anyway: ${relayApi.https ? "https" : "http"}://${relayApi.host}:${relayApi.port}`);
    return toResolvedNAS(relayApi);
  }

  const relay = candidates.find((c) => c.kind === "portal");
  if (relay) {
    debugLog(`QC: no direct candidate passed ping-pong; using QuickConnect relay portal: https://${relay.host}:${relay.port}`);
    return toResolvedNAS(relay);
  }

  debugLog("QC: no candidate passed ping-pong; no reachable File Station API endpoint found");
  throw new Error(`QuickConnect could not find a reachable API endpoint for "${quickConnectId}"`);
}
