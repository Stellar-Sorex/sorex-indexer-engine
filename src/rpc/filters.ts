import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  MAX_CONTRACT_IDS_PER_FILTER,
  MAX_FILTERS_PER_REQUEST,
  MAX_TOPIC_SEGMENTS,
  type AppConfig,
} from "../config.js";
import { ConfigError } from "../errors.js";

export interface FilterPlan {
  /** Suffix appended to the base stream id, e.g. `0`. */
  suffix: string;
  filters: rpc.Api.EventFilter[];
  description: string;
}

/**
 * Encode one topic segment. Wildcards pass through; `xdr:<base64>` and raw
 * base64 ScVal values are used verbatim; any other value is encoded as a
 * Soroban symbol (the common `["transfer", ...]` case).
 */
export function encodeTopicSegment(segment: string): string {
  if (segment === "*" || segment === "**") return segment;

  if (segment.startsWith("xdr:")) {
    const base64 = segment.slice(4);
    try {
      xdr.ScVal.fromXDR(base64, "base64");
    } catch (cause) {
      throw new ConfigError(`Invalid topic segment XDR: ${base64}`, { cause });
    }
    return base64;
  }

  // Accept a raw base64 ScVal (as used by the Stellar docs) when it parses.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(segment) && segment.length % 4 === 0) {
    try {
      xdr.ScVal.fromXDR(segment, "base64");
      return segment;
    } catch {
      // Not an ScVal; fall through and treat it as a symbol.
    }
  }

  return xdr.ScVal.scvSymbol(segment).toXDR("base64");
}

/** Encode every segment of every configured topic filter. */
export function encodeTopicFilters(topicFilters: string[][]): string[][] {
  return topicFilters.map((segments, index) => {
    if (segments.filter((segment) => segment !== "**").length > MAX_TOPIC_SEGMENTS) {
      throw new ConfigError(`Topic filter ${index} has more than ${MAX_TOPIC_SEGMENTS} segments`);
    }
    return segments.map(encodeTopicSegment);
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Build RPC filter plans that respect the node's documented limits:
 * at most 5 filters per request, at most 5 contract IDs per filter, and at
 * most 4 topic matchers (plus a final `**`) per topic filter.
 *
 * Each plan uses a single cursor, so when a configuration needs more than five
 * filters it is split into independent plans, each with its own persisted
 * cursor and stream id. Plans are OR-combined by the caller.
 */
export function buildFilterPlans(
  contractIds: string[],
  topicFilters: string[][],
  maxFilters: number = MAX_FILTERS_PER_REQUEST,
): FilterPlan[] {
  const encodedTopics = encodeTopicFilters(topicFilters);
  const contractChunks =
    contractIds.length > 0 ? chunk(contractIds, MAX_CONTRACT_IDS_PER_FILTER) : [];
  // Cap topic rows per filter conservatively at five; the RPC docs limit the
  // filters array rather than the topics array, but old nodes enforced five.
  const topicChunks: string[][][] =
    encodedTopics.length > 0 ? chunk(encodedTopics, MAX_FILTERS_PER_REQUEST) : [];

  const filters: rpc.Api.EventFilter[] = [];
  if (contractChunks.length === 0 && topicChunks.length === 0) {
    filters.push({ type: "contract" });
  } else if (contractChunks.length === 0) {
    for (const topics of topicChunks) filters.push({ type: "contract", topics });
  } else if (topicChunks.length === 0) {
    for (const contractIdsChunk of contractChunks) {
      filters.push({ type: "contract", contractIds: contractIdsChunk });
    }
  } else {
    for (const contractIdsChunk of contractChunks) {
      for (const topics of topicChunks) {
        filters.push({ type: "contract", contractIds: contractIdsChunk, topics });
      }
    }
  }

  const plans: FilterPlan[] = [];
  for (let index = 0; index < filters.length; index += maxFilters) {
    plans.push({
      suffix: String(plans.length),
      filters: filters.slice(index, index + maxFilters),
      description: `${Math.min(index + maxFilters, filters.length)} filter(s) [${index}..${Math.min(index + maxFilters, filters.length) - 1}]`,
    });
  }
  return plans;
}

/** Convenience wrapper for the configured contract/topic filters. */
export function plansFromConfig(
  config: Pick<AppConfig, "contractIdFilters" | "topicFilters">,
): FilterPlan[] {
  return buildFilterPlans(config.contractIdFilters, config.topicFilters);
}
