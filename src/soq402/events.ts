import type { SignedReceipt } from "./receipt.js";

// Event bus for the SOQ-402 live console.
// ----------------------------------------
// Every interesting moment in the payment loop (challenge issued, invoice
// paid, receipt verified, message exchanged) is emitted here. The seller
// exposes the stream over Server-Sent Events at /events, which is what the
// split-screen console renders. In a CLI run the same events drive stdout.

export type Soq402Event =
  | { type: "challenge"; invoice_id: string; amount_sat: number; memo: string }
  | { type: "paid"; invoice_id: string; amount_sat: number; settle_ms: number; payer: string }
  | {
      type: "inference";
      invoice_id: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      upstream_ms: number;
    }
  | { type: "receipt"; invoice_id: string; sign_ms: number }
  | { type: "receipt_verified"; invoice_id: string; ok: boolean; verify_ms: number; verifier: string }
  | {
      type: "message";
      from: string;
      to: string;
      text: string;
      /** Model that produced the message; empty for the unpaid opener. */
      model?: string;
      /** 0 for the unpaid conversation opener. */
      paid_sat: number;
      total_ms: number;
      /** The signed receipt for this message, so anyone can verify it. */
      receipt?: SignedReceipt;
    }
  | {
      type: "meter";
      agent: string;
      /** Buyer side: total spent this session. */
      spent_sat?: number;
      /** Seller side: total earned this session. */
      earned_sat?: number;
      balance_sat: number;
      calls: number;
      state_index: number;
    }
  | { type: "status"; text: string }
  /** When the next ambient conversation starts (ISO); drives the countdown. */
  | { type: "schedule"; next_ambient_at: string };

export type Stamped = Soq402Event & { at: string; seq: number };

type Listener = (e: Stamped) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private seq = 0;
  /** Ring buffer so a console that connects mid-run can backfill. */
  readonly history: Stamped[] = [];

  emit(e: Soq402Event): Stamped {
    const stamped: Stamped = { ...e, at: new Date().toISOString(), seq: this.seq++ };
    this.history.push(stamped);
    if (this.history.length > 500) this.history.shift();
    for (const fn of this.listeners) fn(stamped);
    return stamped;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
