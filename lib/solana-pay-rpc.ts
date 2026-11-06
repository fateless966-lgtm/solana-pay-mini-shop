import { findReference, validateTransfer } from "@solana/pay";
import {
  PublicKey,
  type Connection,
  type SignaturesForAddressOptions,
} from "@solana/web3.js";

type FindReferenceRpc = Parameters<typeof findReference>[0];
type ValidateTransferRpc = Parameters<typeof validateTransfer>[0];

type SignatureQueryOptions = SignaturesForAddressOptions & {
  commitment?: "confirmed" | "finalized";
};

type TransactionConfig = {
  commitment?: "confirmed" | "finalized";
  maxSupportedTransactionVersion?: number;
};

/**
 * @solana/pay v1 expects a Kit-style RPC object. The app intentionally uses
 * @solana/web3.js, so this small adapter exposes the two RPC methods the
 * library needs while all chain access still goes through web3.js / DevNet.
 */
export function createFindReferenceRpc(
  connection: Connection,
): FindReferenceRpc {
  return {
    getSignaturesForAddress: (
      address: string,
      options: SignatureQueryOptions = {},
    ) => ({
      send: async () => {
        const { commitment, ...rest } = options;
        return connection.getSignaturesForAddress(
          new PublicKey(address),
          rest,
          commitment,
        );
      },
    }),
  } as unknown as FindReferenceRpc;
}

/**
 * validateTransfer needs the raw base64 transaction plus balance metadata.
 * Fetching the DevNet RPC response directly keeps the app on web3.js while
 * still using @solana/pay's transfer validator.
 */
export function createValidateTransferRpc(
  endpoint: string,
): ValidateTransferRpc {
  return {
    getTransaction: (signature: string, config: TransactionConfig = {}) => ({
      send: async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [
              signature,
              {
                commitment: config.commitment ?? "confirmed",
                maxSupportedTransactionVersion:
                  config.maxSupportedTransactionVersion ?? 0,
                encoding: "base64",
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`DevNet RPC returned HTTP ${response.status}`);
        }

        const payload = (await response.json()) as {
          error?: { message?: string };
          result?: {
            transaction?: [string, "base64"];
            meta?: {
              err?: unknown;
              preBalances?: number[];
              postBalances?: number[];
            } | null;
          } | null;
        };

        if (payload.error) {
          throw new Error(payload.error.message ?? "DevNet RPC request failed");
        }

        const result = payload.result;
        if (!result) return null;

        return {
          ...result,
          meta: result.meta
            ? {
                ...result.meta,
                preBalances: (result.meta.preBalances ?? []).map((value) =>
                  BigInt(value),
                ),
                postBalances: (result.meta.postBalances ?? []).map((value) =>
                  BigInt(value),
                ),
              }
            : null,
        };
      },
    }),
  } as unknown as ValidateTransferRpc;
}
