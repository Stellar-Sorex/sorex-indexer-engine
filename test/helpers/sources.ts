import type { RawSorobanEvent } from "../../src/decoder/types.js";
import type {
  EventPage,
  FetchPageRequest,
  LedgerSource,
  RetentionInfo,
} from "../../src/ledger-source/types.js";

/** In-memory source with overridable retention, used for gap/backfill tests. */
export class TestLedgerSource implements LedgerSource {
  readonly kind: "rpc" | "fixture" | "galexie";
  readonly label = "test-source";
  #failures: number;

  constructor(
    private readonly events: RawSorobanEvent[],
    private readonly retention: RetentionInfo,
    options: { kind?: "rpc" | "fixture"; failures?: number } = {},
  ) {
    this.kind = options.kind ?? "fixture";
    this.#failures = options.failures ?? 0;
  }

  async fetchPage(request: FetchPageRequest): Promise<EventPage> {
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new Error("simulated RPC outage");
    }
    let candidates = [...this.events].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (request.cursor) {
      candidates = candidates.filter((event) => event.id > request.cursor!);
    } else if (request.startLedger !== undefined) {
      candidates = candidates.filter((event) => event.ledger >= request.startLedger!);
    }
    if (request.endLedger !== undefined) {
      candidates = candidates.filter((event) => event.ledger < request.endLedger!);
    }
    const page = candidates.slice(0, request.limit);
    return {
      events: page,
      cursor: page.at(-1)?.id ?? request.cursor,
      latestLedger: this.retention.latestLedger,
      oldestLedger: this.retention.oldestLedger,
    };
  }

  async getRetention(): Promise<RetentionInfo> {
    return this.retention;
  }
}
