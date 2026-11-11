import { xdr } from "@stellar/stellar-sdk";
import type { RawTransactionResponse, TransactionRecord } from "./types.js";

/**
 * Parse a raw `getTransaction` response into the resource record used by the
 * API. Returns null for NOT_FOUND responses or unparseable XDR; it never throws
 * so transaction enrichment cannot break event ingestion.
 */
export function parseTransactionResponse(
  txHash: string,
  raw: RawTransactionResponse,
  fallbackLedgerClosedAt?: string,
): TransactionRecord | null {
  if (
    raw.status === "NOT_FOUND" ||
    !raw.envelopeXdr ||
    !raw.resultXdr ||
    raw.ledger === undefined
  ) {
    return null;
  }

  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(raw.envelopeXdr, "base64");
    const inner =
      envelope.type === "envelopeTypeTx"
        ? envelope.v1.tx
        : envelope.type === "envelopeTypeTxV0"
          ? envelope.v0.tx
          : envelope.feeBump.tx.innerTx.v1.tx;

    const result = xdr.TransactionResult.fromXDR(raw.resultXdr, "base64");
    const successCodes = new Set(["txSuccess", "txFeeBumpInnerSuccess"]);
    const sorobanData = inner.ext.type === "sorobanData" ? inner.ext.sorobanData : null;

    const createdAt =
      raw.createdAt !== undefined && raw.createdAt > 0
        ? new Date(raw.createdAt * 1000).toISOString()
        : (fallbackLedgerClosedAt ?? new Date(0).toISOString());

    return {
      txHash,
      ledger: raw.ledger,
      ledgerClosedAt: createdAt,
      applicationOrder: raw.applicationOrder ?? 0,
      successful: successCodes.has(result.result.type),
      feeBump: raw.feeBump ?? envelope.type === "envelopeTypeTxFeeBump",
      feeCharged: result.feeCharged.toString(10),
      resourceFee: sorobanData ? sorobanData.resourceFee.toString(10) : null,
      cpuInstructions: sorobanData?.resources.instructions ?? null,
      memoryBytes: null,
      readBytes: sorobanData?.resources.diskReadBytes ?? null,
      writeBytes: sorobanData?.resources.writeBytes ?? null,
      envelopeSizeBytes: Buffer.from(raw.envelopeXdr, "base64").byteLength,
      operationCount: inner.operations.length,
      hasSorobanData: sorobanData !== null,
    };
  } catch {
    return null;
  }
}
