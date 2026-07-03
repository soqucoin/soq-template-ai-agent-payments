// PayPerCallAgent
// ----------------
// A small, reusable wrapper for AI agents that pay per unit of work over a
// Soqucoin Lightning channel: instant, sub-cent, post-quantum micropayments.
//
// One agent opens a channel once, then calls pay() for each piece of work
// (one inference, one API call, one batch of tokens). Under the hood that is a
// single eLTOO state update on the Lightning SDK.
//
// Two modes, same interface:
//   LIVE  (pass an lspUrl): opens a real channel on stagenet via the faucet and
//          settles each pay() through the SDK.
//   LOCAL (no lspUrl): an in-memory simulation so you can see the metering logic
//          immediately, with no network. Clearly labelled in output.

import { SoqLightning, mlDsaKeygen, onchain } from "soq-lightning-sdk";

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface AgentOptions {
  /** Stagenet LSP base URL. If omitted, the agent runs a LOCAL simulation. */
  lspUrl?: string;
  /** Channel capacity in satoshis. 1 SOQ = 100,000,000 sat. Default 10 SOQ. */
  capacitySat?: number;
  /** Explicit L1 settlement address. Defaults to one derived from the agent key. */
  settlementAddress?: string;
  /** Human label for logs. */
  label?: string;
}

export interface PaymentResult {
  amountSat: number;
  /** Remaining spendable balance in the channel after the payment. */
  remainingSat: number;
  /** Monotonic channel state index. -1 in LOCAL simulation. */
  stateIndex: number;
  live: boolean;
}

export class PayPerCallAgent {
  private constructor(
    readonly label: string,
    readonly live: boolean,
    private readonly ln: SoqLightning | null,
    private readonly channelId: string | null,
    /** post-quantum (ML-DSA-44) identity, hex public key */
    readonly pubKeyHex: string,
    private localBalance: number,
    private localState: number,
  ) {}

  /** Create an agent. Opens a channel in LIVE mode; allocates a simulated one in LOCAL mode. */
  static async create(opts: AgentOptions = {}): Promise<PayPerCallAgent> {
    const label = opts.label ?? "agent";
    const capacity = opts.capacitySat ?? 1_000_000_000; // 10 SOQ
    const wallet = mlDsaKeygen(); // ephemeral post-quantum identity
    const pubKeyHex = toHex(wallet.publicKey);

    if (!opts.lspUrl) {
      // LOCAL simulation: no network, same surface.
      return new PayPerCallAgent(label, false, null, null, pubKeyHex, capacity, 0);
    }

    const ln = new SoqLightning({ baseUrl: opts.lspUrl });
    const address = opts.settlementAddress ?? onchain.deriveAddress(wallet.publicKey, "ssq");
    const channel = await ln.fundAndOpen({
      pubKeyHex,
      address,
      capacitySat: capacity,
    });
    return new PayPerCallAgent(
      label,
      true,
      ln,
      channel.channel_id,
      pubKeyHex,
      channel.initiator_balance_sat,
      channel.state_index,
    );
  }

  /** Pay for one unit of work. Returns the channel state after settlement. */
  async pay(amountSat: number): Promise<PaymentResult> {
    if (!Number.isInteger(amountSat) || amountSat <= 0) {
      throw new Error("amount must be a positive integer number of satoshis");
    }

    if (!this.live) {
      if (this.localBalance < amountSat) throw new Error("insufficient channel balance, top up");
      this.localBalance -= amountSat;
      this.localState += 1;
      return { amountSat, remainingSat: this.localBalance, stateIndex: -1, live: false };
    }

    const current = await this.ln!.channel(this.channelId!);
    if (current.initiator_balance_sat < amountSat) {
      throw new Error("insufficient channel balance, top up");
    }
    const after = await this.ln!.pay(this.channelId!, amountSat);
    return {
      amountSat,
      remainingSat: after.initiator_balance_sat,
      stateIndex: after.state_index,
      live: true,
    };
  }

  /**
   * Bill another agent: create an LSP invoice for a unit of work and hand back
   * its `soqln:` URI. The payer settles it with payInvoice(); this agent's
   * channel balance grows when it does (custodial hub-hop on the hosted beta).
   * LIVE mode only — LOCAL simulation has no counterparty to bill.
   */
  async bill(amountSat: number, memo = ""): Promise<{ invoiceId: string; uri: string }> {
    if (!this.live) throw new Error("billing requires LIVE mode (pass an lspUrl)");
    if (!Number.isInteger(amountSat) || amountSat <= 0) {
      throw new Error("amount must be a positive integer number of satoshis");
    }
    const inv = await this.ln!.createInvoice(this.channelId!, amountSat, { memo });
    return { invoiceId: inv.invoice_id, uri: inv.uri };
  }

  /** Settle another agent's `soqln:` invoice from this agent's channel. */
  async payInvoice(uri: string): Promise<PaymentResult> {
    if (!this.live) throw new Error("invoice settlement requires LIVE mode (pass an lspUrl)");
    const id = SoqLightning.parseInvoiceUri(uri);
    if (!id) throw new Error(`not a soqln: invoice URI: ${uri.slice(0, 24)}…`);
    const { channel, invoice } = await this.ln!.payInvoice(id, this.channelId!);
    return {
      amountSat: invoice.amount_sat,
      remainingSat: channel.initiator_balance_sat,
      stateIndex: channel.state_index,
      live: true,
    };
  }

  /** Wait for an invoice this agent issued to settle (paid or expired). */
  async awaitPaid(invoiceId: string, timeoutMs = 60_000): Promise<boolean> {
    if (!this.live) throw new Error("billing requires LIVE mode (pass an lspUrl)");
    const inv = await this.ln!.awaitInvoicePaid(invoiceId, { timeoutMs });
    return inv.status === "paid";
  }

  /** Current spendable balance in satoshis. */
  async balanceSat(): Promise<number> {
    if (!this.live) return this.localBalance;
    const ch = await this.ln!.channel(this.channelId!);
    return ch.initiator_balance_sat;
  }

  /** Cooperatively close the channel and settle on L1 (LIVE mode only). */
  async close(): Promise<void> {
    if (this.live && this.ln && this.channelId) {
      await this.ln.close(this.channelId);
    }
  }
}
