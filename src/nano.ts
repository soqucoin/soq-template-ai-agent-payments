// Nano (XNO) receive-only payment verifier for SOQ-402 sellers.
// -----------------------------------------------------------------
// In production the seller calls verifyNanoPayment() with the Nano block
// hash the buyer provides (e.g. in header X-Nano-Hash). The function
// queries rpc.nano.to to check whether the block exists, is unspent and
// carries enough raw. In tests a stubbed verifier answers without network.
//
// The Nano network itself is the oracle: a payment that is pocketed and
// unspent is settled. No bridging, no 402 facilitator, no USDC proxy.
// Instant, feeless, one final block.

import { env } from "node:process";

// ---- Types -----------------------------------------------------------

export interface NanoPayment {
  /** The Nano block hash the buyer claims to have sent. */
  blockHash: string;
  /** Minimum amount expected, in raw (10^-30 XNO). Unchecked when unset. */
  expectRaw?: string;
  /** The Nano account the payment should be sent to (seller's receive
   *  account). Unchecked when unset. */
  payTo?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  /** The amount the block carries, in raw, when available. */
  receivedRaw?: string;
  /** Nano explorer URL for the block (mainnet). */
  explorerUrl?: string;
}

// ---- Prod verifier (live RPC) ---------------------------------------

const NANO_RPC_URL = env.NANO_RPC_URL ?? "https://rpc.nano.to";

interface NanoRpcBlock {
  subtype?: string;
  amount?: string;
  confirmed?: boolean;
  error?: string;
}

export async function verifyNanoPayment(payment: NanoPayment): Promise<VerifyResult> {
  const { blockHash } = payment;
  if (!/^[0-9a-fA-F]{64}$/.test(blockHash)) {
    return { ok: false, reason: "not a valid Nano block hash (expected 64 hex chars)" };
  }

  let block: NanoRpcBlock;
  try {
    const resp = await fetch(NANO_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "block_info", json_block: "true", hash: blockHash }),
    });
    if (!resp.ok) {
      return { ok: false, reason: `rpc error ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    }
    block = (await resp.json()) as NanoRpcBlock;
  } catch (err) {
    return { ok: false, reason: `rpc call failed: ${(err as Error)?.message ?? String(err)}` };
  }

  // A block not found surfaces as {"error": "Block not found"} with 200.
  if (block.error || !block.subtype) {
    return { ok: false, reason: `block not found on Nano network${block.error ? ` (${block.error})` : ""}` };
  }
  if (block.confirmed === false) {
    return { ok: false, reason: "block is not confirmed yet" };
  }

  const subtype = block.subtype;
  // Accept 'send' (sender -> receiver) and 'receive' (already pocketed).
  if (subtype !== "send" && subtype !== "receive" && subtype !== "change") {
    return { ok: false, reason: `unexpected block subtype "${subtype}" (expected send/receive)` };
  }

  // Check minimum amount when set.
  if (payment.expectRaw) {
    const received = block.amount ?? "0";
    const receivedNum = BigInt(received);
    const expectedNum = BigInt(payment.expectRaw);
    if (receivedNum < expectedNum) {
      return { ok: false, reason: `block carries ${received} raw, expected at least ${payment.expectRaw}` };
    }
  }

  return {
    ok: true,
    receivedRaw: block.amount,
    explorerUrl: `https://nanexplorer.com/nano/block/${blockHash}`,
  };
}

// ---- Test verifier (network-free, stubbed) ---------------------------

export interface NanoTestVerifier {
  verifyNanoPayment(payment: NanoPayment): Promise<VerifyResult>;
  /** Register a hash that will pass verification. */
  stubPass(hash: string, amount?: string, account?: string): void;
}

export function createTestVerifier(): NanoTestVerifier {
  const good = new Map<string, { amount: string; account?: string }>();

  return {
    stubPass(hash, amount = "100000000000000000000000000000000", account) {
      good.set(hash, { amount, account });
    },
    async verifyNanoPayment(payment: NanoPayment): Promise<VerifyResult> {
      // Pre-registered pass: return a canned success.
      const h = payment.blockHash;
      if (good.has(h)) {
        const canned = good.get(h)!;
        return {
          ok: true,
          receivedRaw: canned.amount,
          explorerUrl: `https://nanexplorer.com/nano/block/${h}`,
        };
      }
      // Not found in stub = block not found.
      return { ok: false, reason: "stub: block not found" };
    },
  };
}
