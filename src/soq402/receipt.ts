// Signed payment receipts for SOQ-402.
// -------------------------------------
// After a paid inference, the seller returns a receipt signed with its
// ML-DSA-44 (post-quantum) identity key. The buyer can verify, offline and
// forever, that THIS seller performed THIS work for THIS payment:
// the receipt binds the invoice id, the request and response hashes, the
// token counts, and the amount paid.
//
// Verification needs only the seller's public key, which the seller
// advertises in every 402 challenge and at /.well-known/soq402.

import { createHash } from "node:crypto";
import { nobleMlDsa } from "soq-lightning-sdk";

export interface Receipt {
  /** Receipt format version. */
  v: 1;
  /** The LSP invoice this receipt settles. */
  invoice_id: string;
  /** Amount actually paid, in shors. */
  amount_sat: number;
  /** Model that served the request. */
  model: string;
  /** sha256 (hex) of the raw request body. */
  request_sha256: string;
  /** sha256 (hex) of the response content. */
  response_sha256: string;
  prompt_tokens: number;
  completion_tokens: number;
  /** ISO-8601 issue time. */
  issued_at: string;
  /** Seller's ML-DSA-44 public key, hex (1312 bytes). */
  seller_pub: string;
}

export interface SignedReceipt {
  receipt: Receipt;
  /** ML-DSA-44 signature, hex (2420 bytes), over sha256 of the canonical receipt. */
  sig: string;
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** Canonical bytes: JSON with keys in fixed order (the order of the Receipt
 *  interface above), no whitespace. Both sides must derive the same bytes. */
function canonicalBytes(r: Receipt): Uint8Array {
  const ordered = {
    v: r.v,
    invoice_id: r.invoice_id,
    amount_sat: r.amount_sat,
    model: r.model,
    request_sha256: r.request_sha256,
    response_sha256: r.response_sha256,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    issued_at: r.issued_at,
    seller_pub: r.seller_pub,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** Sign a receipt with the seller's ML-DSA-44 secret key (2560-byte expanded form). */
export function signReceipt(receipt: Receipt, secretKey: Uint8Array): SignedReceipt {
  const digest = createHash("sha256").update(canonicalBytes(receipt)).digest();
  const sig = nobleMlDsa.sign(digest, secretKey);
  return { receipt, sig: Buffer.from(sig).toString("hex") };
}

/** Verify a signed receipt against the seller public key embedded in it.
 *  Returns false on any mismatch; never throws on malformed input. */
export function verifyReceipt(signed: SignedReceipt, expectedSellerPubHex?: string): boolean {
  try {
    const { receipt, sig } = signed;
    if (receipt.v !== 1) return false;
    if (expectedSellerPubHex && receipt.seller_pub !== expectedSellerPubHex) return false;
    const digest = createHash("sha256").update(canonicalBytes(receipt)).digest();
    return nobleMlDsa.verify(
      digest,
      Uint8Array.from(Buffer.from(sig, "hex")),
      Uint8Array.from(Buffer.from(receipt.seller_pub, "hex")),
    );
  } catch {
    return false;
  }
}
