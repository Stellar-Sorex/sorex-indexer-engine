import { describe, expect, it } from "vitest";
import { buildFilterPlans, encodeTopicFilters, encodeTopicSegment } from "../src/rpc/filters.js";

function contractId(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let suffix = "";
  let value = index;
  for (let i = 0; i < 55; i += 1) {
    suffix = alphabet[value % 32]! + suffix;
    value = Math.floor(value / 32);
  }
  return `C${suffix}`;
}

describe("topic filter encoding", () => {
  it("encodes symbols exactly like the Stellar docs", () => {
    expect(encodeTopicSegment("transfer")).toBe("AAAADwAAAAh0cmFuc2Zlcg==");
    expect(encodeTopicSegment("mint")).toBe("AAAADwAAAARtaW50");
  });

  it("passes wildcards and explicit XDR through", () => {
    expect(encodeTopicSegment("*")).toBe("*");
    expect(encodeTopicSegment("**")).toBe("**");
    expect(encodeTopicSegment("xdr:AAAADwAAAAh0cmFuc2Zlcg==")).toBe("AAAADwAAAAh0cmFuc2Zlcg==");
    expect(encodeTopicSegment("AAAADwAAAAh0cmFuc2Zlcg==")).toBe("AAAADwAAAAh0cmFuc2Zlcg==");
  });

  it("rejects invalid explicit XDR", () => {
    expect(() => encodeTopicSegment("xdr:not-xdr")).toThrow(/Invalid topic segment XDR/);
  });

  it("encodes multiple filters and rejects too many segments", () => {
    expect(encodeTopicFilters([["transfer", "*", "**"]])).toEqual([
      ["AAAADwAAAAh0cmFuc2Zlcg==", "*", "**"],
    ]);
    expect(() => encodeTopicFilters([["a", "b", "c", "d", "e", "**"]])).toThrow(
      /more than 4 segments/,
    );
  });
});

describe("filter plan chunking", () => {
  it("chunks contract IDs into groups of five", () => {
    const contracts = Array.from({ length: 12 }, (_, index) => contractId(index));
    const plans = buildFilterPlans(contracts, []);
    const filters = plans.flatMap((plan) => plan.filters);
    expect(filters).toHaveLength(3);
    expect(filters.every((filter) => (filter.contractIds?.length ?? 0) <= 5)).toBe(true);
    expect(filters.flatMap((filter) => filter.contractIds ?? [])).toHaveLength(12);
  });

  it("splits plans so no RPC request exceeds five filters", () => {
    const contracts = Array.from({ length: 12 }, (_, index) => contractId(index));
    const topics = [["transfer"], ["mint"], ["burn"], ["approve"], ["clawback"], ["fee"]];
    const plans = buildFilterPlans(contracts, topics);
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.every((plan) => plan.filters.length <= 5)).toBe(true);
    const filters = plans.flatMap((plan) => plan.filters);
    // 12 contracts / 5 = 3 chunks, 6 topic rows / 5 = 2 chunks => 6 filters.
    expect(filters).toHaveLength(6);
    expect(new Set(plans.map((plan) => plan.suffix)).size).toBe(plans.length);
  });

  it("queries all contract events when no filters are configured", () => {
    expect(buildFilterPlans([], [])).toEqual([
      { suffix: "0", filters: [{ type: "contract" }], description: "1 filter(s) [0..0]" },
    ]);
  });

  it("builds topic-only filters", () => {
    const plans = buildFilterPlans([], [["transfer", "**"]]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.filters[0]!.topics).toEqual([["AAAADwAAAAh0cmFuc2Zlcg==", "**"]]);
  });
});
