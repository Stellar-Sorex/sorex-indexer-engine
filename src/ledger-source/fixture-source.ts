import type { RawSorobanEvent } from "../decoder/types.js";
import type { EventPage, FetchPageRequest, LedgerSource, RetentionInfo } from "./types.js";

/**
 * Replays a captured `getEvents` payload. Used by the `replay` CLI command and
 * by integration tests; it never touches the network.
 */
export class FixtureLedgerSource implements LedgerSource {
  readonly kind = "fixture" as const;
  readonly label = "fixture";
  readonly #events: RawSorobanEvent[];

  constructor(events: RawSorobanEvent[]) {
    this.#events = [...events].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (this.#events.length === 0)
      throw new Error("FixtureLedgerSource requires at least one event");
  }

  async fetchPage(request: FetchPageRequest): Promise<EventPage> {
    let candidates = this.#events;
    if (request.cursor) {
      candidates = candidates.filter((event) => event.id > request.cursor!);
    } else if (request.startLedger !== undefined) {
      candidates = candidates.filter(
        (event) =>
          event.ledger >= request.startLedger! &&
          (request.endLedger === undefined || event.ledger < request.endLedger),
      );
    }
    const page = candidates.slice(0, request.limit);
    const retention = await this.getRetention();
    return {
      events: page,
      cursor: page.at(-1)?.id ?? request.cursor,
      latestLedger: retention.latestLedger,
      oldestLedger: retention.oldestLedger,
    };
  }

  async getRetention(): Promise<RetentionInfo> {
    const ledgerNumbers = this.#events.map((event) => event.ledger);
    return {
      latestLedger: Math.max(...ledgerNumbers),
      oldestLedger: Math.min(...ledgerNumbers),
    };
  }
}

/** Extract raw events from a captured RPC response, an array, or a fixture file. */
export function parseFixturePayload(payload: unknown): RawSorobanEvent[] {
  const candidate =
    payload && typeof payload === "object" && "result" in payload
      ? (payload as { result?: unknown }).result
      : payload;
  const events =
    candidate && typeof candidate === "object" && "events" in candidate
      ? (candidate as { events?: unknown }).events
      : candidate;

  if (!Array.isArray(events)) {
    throw new Error("Fixture must be an array of events or a captured getEvents response");
  }

  return events.map((event, index) => {
    if (!event || typeof event !== "object") {
      throw new Error(`Fixture event ${index} is not an object`);
    }
    const value = event as Record<string, unknown>;
    for (const key of ["id", "txHash", "value", "ledgerClosedAt"] as const) {
      if (typeof value[key] !== "string")
        throw new Error(`Fixture event ${index} is missing ${key}`);
    }
    if (typeof value.ledger !== "number")
      throw new Error(`Fixture event ${index} is missing ledger`);
    const ledger = value.ledger;
    const topic = Array.isArray(value.topic)
      ? value.topic.filter((t): t is string => typeof t === "string")
      : [];
    return {
      id: value.id as string,
      type: typeof value.type === "string" ? value.type : "contract",
      ledger,
      ledgerClosedAt: value.ledgerClosedAt as string,
      contractId: typeof value.contractId === "string" ? value.contractId : "",
      txHash: value.txHash as string,
      transactionIndex: typeof value.transactionIndex === "number" ? value.transactionIndex : 0,
      operationIndex: typeof value.operationIndex === "number" ? value.operationIndex : 0,
      topic,
      value: value.value as string,
      inSuccessfulContractCall:
        typeof value.inSuccessfulContractCall === "boolean" ? value.inSuccessfulContractCall : true,
    };
  });
}
