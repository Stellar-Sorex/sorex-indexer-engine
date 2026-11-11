import { rpc } from "@stellar/stellar-sdk";
import type { SorobanRpcClient } from "../rpc/client.js";
import type { EventPage, FetchPageRequest, LedgerSource, RetentionInfo } from "./types.js";

/** Live/backfill source backed by Soroban RPC `getEvents`. */
export class RpcLedgerSource implements LedgerSource {
  readonly kind = "rpc" as const;
  readonly label: string;

  constructor(
    private readonly client: SorobanRpcClient,
    private readonly filters: rpc.Api.EventFilter[],
  ) {
    this.label = `soroban-rpc (${filters.length} filter${filters.length === 1 ? "" : "s"})`;
  }

  async fetchPage(request: FetchPageRequest): Promise<EventPage> {
    const page = await this.client.getEvents({
      filters: this.filters,
      limit: request.limit,
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      ...(request.startLedger !== undefined ? { startLedger: request.startLedger } : {}),
      ...(request.endLedger !== undefined ? { endLedger: request.endLedger } : {}),
    });
    return {
      events: page.events,
      cursor: page.cursor,
      latestLedger: page.latestLedger,
      oldestLedger: page.oldestLedger,
    };
  }

  async getRetention(): Promise<RetentionInfo> {
    const health = await this.client.getHealth();
    return {
      latestLedger: health.latestLedger,
      oldestLedger: health.oldestLedger,
      ledgerRetentionWindow: health.ledgerRetentionWindow,
    };
  }
}
