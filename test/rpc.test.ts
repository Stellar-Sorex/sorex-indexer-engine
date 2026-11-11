import { describe, expect, it, vi } from "vitest";
import { SourceUnavailableError } from "../src/errors.js";
import {
  FixtureLedgerSource,
  GalexieLedgerSource,
  RpcLedgerSource,
  parseFixturePayload,
} from "../src/ledger-source/index.js";
import type { SorobanRpcClient } from "../src/rpc/client.js";
import { isRetryableError, withRetry } from "../src/rpc/retry.js";
import { loadRawEvents } from "./helpers/fixtures.js";

describe("withRetry", () => {
  const policy = { retries: 2, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 200 };

  it("retries retryable failures and returns the result", async () => {
    let attempts = 0;
    const result = await withRetry(
      "test",
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("network timeout");
        return "ok";
      },
      policy,
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry validation errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        "test",
        async () => {
          attempts += 1;
          throw new Error("invalid startLedger");
        },
        policy,
      ),
    ).rejects.toThrow(/invalid startLedger/);
    expect(attempts).toBe(1);
  });

  it("throws the last error after exhausting retries", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        "test",
        async () => {
          attempts += 1;
          throw new Error("socket hang up");
        },
        policy,
      ),
    ).rejects.toThrow(/socket hang up/);
    expect(attempts).toBe(3);
  });

  it("enforces a per-attempt timeout", async () => {
    await expect(
      withRetry("slow", () => new Promise((resolve) => setTimeout(resolve, 100)), {
        ...policy,
        retries: 0,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("reports retry attempts through hooks", async () => {
    const onRetry = vi.fn();
    await withRetry(
      "hooked",
      async () => {
        throw new Error("rate limit exceeded");
      },
      { ...policy, retries: 1 },
      { onRetry },
    ).catch(() => undefined);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("classifies connection reset errors as retryable", () => {
    const error = new Error("connect failed") as NodeJS.ErrnoException;
    error.code = "ECONNRESET";
    expect(isRetryableError(error)).toBe(true);
    expect(isRetryableError("not an error")).toBe(false);
  });
});

describe("RpcLedgerSource", () => {
  const page = {
    events: loadRawEvents().slice(0, 2),
    cursor: "cursor-2",
    latestLedger: 100,
    oldestLedger: 50,
    latestLedgerCloseTime: "1",
    oldestLedgerCloseTime: "2",
  };

  it("passes filters, cursors and limits through to the RPC client", async () => {
    const getEvents = vi.fn(async () => page);
    const getHealth = vi.fn(async () => ({
      status: "healthy",
      latestLedger: 100,
      oldestLedger: 50,
      ledgerRetentionWindow: 120960,
    }));
    const client = { getEvents, getHealth } as unknown as SorobanRpcClient;
    const filters = [{ type: "contract" as const, contractIds: ["CABC"] }];
    const source = new RpcLedgerSource(client, filters);

    const result = await source.fetchPage({ cursor: "cursor-1", limit: 7 });
    expect(result.events).toHaveLength(2);
    expect(result.cursor).toBe("cursor-2");
    expect(getEvents).toHaveBeenCalledWith({ filters, cursor: "cursor-1", limit: 7 });

    await source.fetchPage({ startLedger: 55, endLedger: 60, limit: 7 });
    expect(getEvents).toHaveBeenLastCalledWith({
      filters,
      startLedger: 55,
      endLedger: 60,
      limit: 7,
    });

    expect(await source.getRetention()).toEqual({
      latestLedger: 100,
      oldestLedger: 50,
      ledgerRetentionWindow: 120960,
    });
  });
});

describe("fixture and archival sources", () => {
  it("replays fixtures in event-id order with cursor pagination", async () => {
    const events = loadRawEvents().slice(0, 4);
    const source = new FixtureLedgerSource(events);
    const first = await source.fetchPage({ limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.events[0]!.id < first.events[1]!.id).toBe(true);
    const second = await source.fetchPage({ cursor: first.cursor, limit: 10 });
    expect(second.events).toHaveLength(2);
    expect(second.events[0]!.id > first.events[1]!.id).toBe(true);
  });

  it("parses captured RPC responses, arrays and rejects invalid payloads", () => {
    const events = loadRawEvents();
    expect(parseFixturePayload({ result: { events } })).toHaveLength(events.length);
    expect(parseFixturePayload(events)).toHaveLength(events.length);
    expect(() => parseFixturePayload({ nope: true })).toThrow(/array of events/);
    expect(() => parseFixturePayload([{ id: 1 }])).toThrow(/missing id/);
    expect(() => parseFixturePayload(["x"])).toThrow(/not an object/);
  });

  it("fails to construct the Galexie source with an actionable error", async () => {
    expect(() => new GalexieLedgerSource()).toThrow(SourceUnavailableError);
    expect(() => new GalexieLedgerSource()).toThrow(/not implemented/);
    const source = Object.create(GalexieLedgerSource.prototype) as GalexieLedgerSource;
    await expect(source.fetchPage({ limit: 1 })).rejects.toThrow(/seed issue/);
    await expect(source.getRetention()).rejects.toThrow(/seed issue/);
  });

  it("rejects empty fixture sources", () => {
    expect(() => new FixtureLedgerSource([])).toThrow(/at least one event/);
  });
});
