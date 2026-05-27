import { moveCandidateToFront, prioritizeCachedQuickConnectCandidates } from "../src/main";
import type { QCCandidate } from "../src/quickconnect";

describe("QuickConnect candidate prioritization", () => {
  it("keeps every candidate after moving a ping-reachable candidate first", () => {
    const candidates: QCCandidate[] = [
      { host: "portal.example", port: 443, https: true, kind: "portal" },
      { host: "lan.example", port: 5001, https: true, kind: "api" },
      { host: "relay-api.example", port: 32836, https: true, kind: "relay-api" },
    ];

    expect(moveCandidateToFront(candidates, candidates[0])).toEqual(candidates);
    expect(moveCandidateToFront(candidates, candidates[1])).toEqual([candidates[1], candidates[0], candidates[2]]);
  });

  it("tries recently successful QuickConnect candidates before rediscovered candidates", () => {
    const now = Date.UTC(2026, 4, 27);
    const portal: QCCandidate = { host: "portal.example", port: 443, https: true, kind: "portal" };
    const direct: QCCandidate = { host: "direct.example", port: 5001, https: true, kind: "api" };
    const relay: QCCandidate = { host: "relay.example", port: 32836, https: true, kind: "relay-api" };

    expect(prioritizeCachedQuickConnectCandidates([portal, direct], [{
      candidate: relay,
      quickConnectId: "example-nas",
      successCount: 2,
      lastSuccessAt: now - 60_000,
    }], "Example-NAS", now)).toEqual([relay, portal, direct]);
  });

  it("drops stale cached QuickConnect candidates from priority order", () => {
    const now = Date.UTC(2026, 4, 27);
    const portal: QCCandidate = { host: "portal.example", port: 443, https: true, kind: "portal" };
    const staleRelay: QCCandidate = { host: "relay.example", port: 32836, https: true, kind: "relay-api" };

    expect(prioritizeCachedQuickConnectCandidates([portal], [{
      candidate: staleRelay,
      quickConnectId: "example-nas",
      successCount: 10,
      lastSuccessAt: now - 15 * 24 * 60 * 60 * 1000,
    }], "Example-NAS", now)).toEqual([portal]);
  });
});
