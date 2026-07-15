// SOQ-402 buyer: an autonomous agent that pays for its own inference.
// --------------------------------------------------------------------
// The buyer holds its own post-quantum wallet and Lightning channel. When a
// metered service answers 402 Payment Required, the buyer:
//
//   1. parses the invoice from the challenge,
//   2. checks it against its own spend guards (per-call cap, session budget),
//   3. pays it over the channel, in-flight,
//   4. retries the request with the payment attached,
//   5. verifies the ML-DSA-44 signed receipt that comes back.
//
// No human, no card, no processor in the loop. The guards exist because an
// agent that auto-pays anything it is asked to pay is a faucet for whoever
// it talks to; budget escapes are refused, not negotiated.

import { SoqLightning, mlDsaKeygen, onchain } from "soq-lightning-sdk";
import { EventBus } from "./events.js";
import { verifyReceipt, type SignedReceipt } from "./receipt.js";

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface BuyerOptions {
  lspUrl: string;
  /** Refuse any single invoice above this, in satoshis. */
  maxPerCallSat?: number;
  /** Refuse to spend more than this in total, in satoshis. */
  budgetSat?: number;
  capacitySat?: number;
  label?: string;
  bus?: EventBus;
  /** Pin the seller's public key after first contact (trust-on-first-use). */
  pinSellerKey?: boolean;
}

export interface PaidCompletion {
  content: string;
  model: string;
  paidSat: number;
  invoiceId: string;
  receipt: SignedReceipt;
  receiptOk: boolean;
  /** Wall-clock breakdown of the loop, milliseconds. */
  timings: { challenge: number; pay: number; retry: number; verify: number; total: number };
}

interface Challenge {
  payment: {
    scheme: string;
    invoice_id: string;
    uri: string;
    amount_sat: number;
    seller_pub: string;
    retry: { header: string };
  };
}

export class Soq402Buyer {
  private spentSat = 0;
  private calls = 0;
  private pinnedSellerPub: string | null = null;

  private constructor(
    readonly label: string,
    private readonly ln: SoqLightning,
    private readonly channelId: string,
    readonly pubKeyHex: string,
    private readonly opts: BuyerOptions,
    readonly bus: EventBus,
  ) {}

  static async create(opts: BuyerOptions): Promise<Soq402Buyer> {
    const label = opts.label ?? "buyer";
    const bus = opts.bus ?? new EventBus();
    const keys = mlDsaKeygen();
    const ln = new SoqLightning({ baseUrl: opts.lspUrl });
    const channel = await ln.openChannel({
      pubKeyHex: toHex(keys.publicKey),
      address: onchain.deriveAddress(keys.publicKey, "ssq"),
      capacitySat: opts.capacitySat ?? 100_000_000,
      name: `soq402-${label}`,
    });
    bus.emit({ type: "status", text: `${label}: channel ${channel.channel_id.slice(0, 12)} open` });
    return new Soq402Buyer(label, ln, channel.channel_id, toHex(keys.publicKey), opts, bus);
  }

  get sessionSpentSat(): number {
    return this.spentSat;
  }

  async balanceSat(): Promise<number> {
    const ch = await this.ln.channel(this.channelId);
    return ch.initiator_balance_sat;
  }

  async close(): Promise<void> {
    await this.ln.close(this.channelId);
  }

  /** Call a metered chat endpoint, paying the 402 challenge automatically. */
  async chat(
    serviceUrl: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens = 256,
  ): Promise<PaidCompletion> {
    const t0 = Date.now();
    const body = JSON.stringify({ messages, max_tokens: maxTokens });
    const endpoint = `${serviceUrl.replace(/\/$/, "")}/v1/chat/completions`;

    // 1. First attempt: expect the 402 challenge.
    const first = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const tChallenge = Date.now();
    if (first.status !== 402) {
      throw new Error(`expected 402 challenge, got ${first.status}`);
    }
    const challenge = (await first.json()) as Challenge;
    const pay = challenge.payment;
    if (pay?.scheme !== "soq402/1" || !pay.invoice_id) {
      throw new Error("402 response carried no soq402 payment challenge");
    }

    // 2. Spend guards. Refusal is the feature.
    const maxPerCall = this.opts.maxPerCallSat ?? 10_000;
    const budget = this.opts.budgetSat ?? 1_000_000;
    if (pay.amount_sat > maxPerCall) {
      throw new Error(`guard: invoice ${pay.amount_sat} sat exceeds per-call cap ${maxPerCall} sat`);
    }
    if (this.spentSat + pay.amount_sat > budget) {
      throw new Error(`guard: paying ${pay.amount_sat} sat would exceed session budget ${budget} sat`);
    }
    if (this.opts.pinSellerKey !== false) {
      if (this.pinnedSellerPub && this.pinnedSellerPub !== pay.seller_pub) {
        throw new Error("guard: seller key changed mid-session");
      }
      this.pinnedSellerPub = pay.seller_pub;
    }

    // 3. Pay the invoice over the channel, in-flight.
    await this.ln.payInvoice(pay.invoice_id, this.channelId);
    const tPay = Date.now();
    this.spentSat += pay.amount_sat;
    this.calls += 1;

    // 4. Retry the same request with the payment attached.
    const second = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", [pay.retry.header]: pay.invoice_id },
      body,
    });
    const tRetry = Date.now();
    if (!second.ok) {
      throw new Error(`paid but service refused: ${second.status} ${(await second.text()).slice(0, 200)}`);
    }
    const completion = (await second.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
      soq402?: { receipt: SignedReceipt };
    };

    // 5. Verify the signed receipt against the seller key from the challenge.
    const receipt = completion.soq402?.receipt;
    if (!receipt) throw new Error("paid response carried no receipt");
    const receiptOk =
      verifyReceipt(receipt, pay.seller_pub) && receipt.receipt.invoice_id === pay.invoice_id;
    const tVerify = Date.now();
    this.bus.emit({
      type: "receipt_verified",
      invoice_id: pay.invoice_id,
      ok: receiptOk,
      verify_ms: tVerify - tRetry,
      verifier: this.label,
    });

    const ch = await this.ln.channel(this.channelId);
    this.bus.emit({
      type: "meter",
      agent: this.label,
      spent_sat: this.spentSat,
      balance_sat: ch.initiator_balance_sat,
      calls: this.calls,
      state_index: ch.state_index,
    });

    return {
      content: completion.choices[0]?.message?.content ?? "",
      model: completion.model,
      paidSat: pay.amount_sat,
      invoiceId: pay.invoice_id,
      receipt,
      receiptOk,
      timings: {
        challenge: tChallenge - t0,
        pay: tPay - tChallenge,
        retry: tRetry - tPay,
        verify: tVerify - tRetry,
        total: tVerify - t0,
      },
    };
  }
}
