import { moveCandidateToFront } from "../src/main";
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
});
