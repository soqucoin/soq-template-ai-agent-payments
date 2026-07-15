// SOQ-402 seller: a metered AI service behind HTTP 402.
// ------------------------------------------------------
// Wraps any OpenAI-compatible chat endpoint with pay-per-call Lightning
// billing. The flow is the one HTTP reserved status 402 for:
//
//   1. Client POSTs /v1/chat/completions with no payment.
//      Seller replies 402 Payment Required + a Lightning invoice (soqln: URI).
//   2. Client pays the invoice over its channel (sub-second on stagenet).
//   3. Client retries the SAME request with header  X-SOQ-Invoice: <invoice_id>.
//      Seller checks the invoice is paid and unredeemed, runs the inference,
//      and returns the completion PLUS an ML-DSA-44 signed receipt.
//
// Each invoice unlocks exactly one inference (one-shot redemption). No API
// keys, no card on file, no subscription: the payment IS the authentication.
//
// Upstream: set OPENAI_BASE_URL (+ OPENAI_API_KEY, MODEL) to bill for a real
// model. Leave it unset and a clearly-labelled built-in mock answers instead,
// so the payment loop runs with zero external dependencies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { SoqLightning, mlDsaKeygen, onchain } from "soq-lightning-sdk";
import { EventBus } from "./events.js";
import { sha256Hex, signReceipt, type Receipt, type SignedReceipt } from "./receipt.js";

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export interface SellerOptions {
  /** Stagenet LSP base URL, e.g. https://lsp.soqu.org */
  lspUrl: string;
  port?: number;
  /** Flat price per inference, in shors. Ignored if pricePer1kTokensSat is set. */
  pricePerCallSat?: number;
  /** Per-1K-token pricing: the quote covers estimated prompt tokens + max_tokens. */
  pricePer1kTokensSat?: number;
  /** OpenAI-compatible upstream. Unset = built-in mock. */
  upstream?: { baseUrl: string; apiKey?: string; model?: string };
  /** Channel capacity in shors. */
  capacitySat?: number;
  /** Serve this HTML file at / (the live console). */
  consolePath?: string;
  bus?: EventBus;
  label?: string;
  /** Extra HTTP routes, keyed "METHOD /path". Used by the hosted live demo. */
  extraRoutes?: Record<
    string,
    (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>
  >;
  /** Cap unpaid 402 challenges per IP per minute (public deployments: every
   *  challenge creates an LSP invoice, so unmetered issuance is a spam vector). */
  challengesPerIpPerMin?: number;
  /** Trust X-Forwarded-For (set only behind a reverse proxy you control). */
  trustProxy?: boolean;
  /** Extra fields merged into /.well-known/soq402 (e.g. { ask: true }). */
  wellKnownExtra?: Record<string, unknown>;
}

interface IssuedInvoice {
  amount_sat: number;
  issued_at: number;
  redeemed: boolean;
}

interface ChatRequest {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
}

/** Rough token estimate (4 chars per token) for prepaid quoting. */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export class Soq402Seller {
  private issued = new Map<string, IssuedInvoice>();
  private server: Server | null = null;
  private earnedSat = 0;
  private callsServed = 0;
  private challengeHits = new Map<string, { count: number; windowStart: number }>();

  private constructor(
    readonly label: string,
    private readonly ln: SoqLightning,
    private readonly channelId: string,
    private readonly keys: { publicKey: Uint8Array; secretKey: Uint8Array },
    private readonly opts: SellerOptions,
    readonly bus: EventBus,
  ) {}

  get pubKeyHex(): string {
    return toHex(this.keys.publicKey);
  }

  static async create(opts: SellerOptions): Promise<Soq402Seller> {
    const label = opts.label ?? "seller";
    const bus = opts.bus ?? new EventBus();
    const keys = mlDsaKeygen();
    const ln = new SoqLightning({ baseUrl: opts.lspUrl });
    const channel = await ln.openChannel({
      pubKeyHex: toHex(keys.publicKey),
      address: onchain.deriveAddress(keys.publicKey, "ssq"),
      capacitySat: opts.capacitySat ?? 100_000_000,
      name: `soq402-${label}`,
    });
    const seller = new Soq402Seller(label, ln, channel.channel_id, keys, opts, bus);
    bus.emit({ type: "status", text: `${label}: channel ${channel.channel_id.slice(0, 12)} open` });
    return seller;
  }

  /** Quote a price in shors for one request. */
  quoteSat(req: ChatRequest): number {
    if (this.opts.pricePer1kTokensSat) {
      const promptTokens = estimateTokens(req.messages.map((m) => m.content).join(" "));
      const cap = req.max_tokens ?? 256;
      return Math.max(1, Math.ceil(((promptTokens + cap) / 1000) * this.opts.pricePer1kTokensSat));
    }
    return this.opts.pricePerCallSat ?? 250;
  }

  async listen(): Promise<number> {
    const port = this.opts.port ?? 4020;
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
    this.bus.emit({ type: "status", text: `${this.label}: listening on :${port}` });
    return port;
  }

  async close(): Promise<void> {
    this.server?.close();
    await this.ln.close(this.channelId);
  }

  async balanceSat(): Promise<number> {
    const ch = await this.ln.channel(this.channelId);
    return ch.initiator_balance_sat;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/.well-known/soq402") return this.wellKnown(res);
    if (req.method === "GET" && url === "/events") return this.sse(res);
    if (req.method === "GET" && (url === "/" || url === "/console") && this.opts.consolePath) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(this.opts.consolePath, "utf8"));
      return;
    }
    if (req.method === "POST" && url === "/v1/chat/completions") return this.completions(req, res);
    const extra = this.opts.extraRoutes?.[`${req.method} ${url}`];
    if (extra) {
      const body = req.method === "POST" ? await readBody(req) : "";
      return extra(req, res, body);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }

  /** Client IP for rate limiting; first X-Forwarded-For hop when behind our proxy. */
  clientIp(req: IncomingMessage): string {
    if (this.opts.trustProxy) {
      const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  private challengeAllowed(ip: string): boolean {
    const limit = this.opts.challengesPerIpPerMin;
    if (!limit) return true;
    const now = Date.now();
    const hit = this.challengeHits.get(ip);
    if (!hit || now - hit.windowStart > 60_000) {
      this.challengeHits.set(ip, { count: 1, windowStart: now });
      if (this.challengeHits.size > 10_000) this.challengeHits.clear(); // bounded memory
      return true;
    }
    hit.count += 1;
    return hit.count <= limit;
  }

  private wellKnown(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        soq402: 1,
        seller_pub: this.pubKeyHex,
        pricing: this.opts.pricePer1kTokensSat
          ? { mode: "per-1k-tokens", sat: this.opts.pricePer1kTokensSat }
          : { mode: "per-call", sat: this.opts.pricePerCallSat ?? 250 },
        lsp: this.opts.lspUrl,
        network: "stagenet",
        ...this.opts.wellKnownExtra,
      }),
    );
  }

  private sse(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    for (const e of this.bus.history) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = this.bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    res.on("close", off);
  }

  private async completions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: ChatRequest;
    try {
      body = JSON.parse(raw);
      if (!Array.isArray(body.messages)) throw new Error("messages missing");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid chat request" } }));
      return;
    }

    const invoiceId = (req.headers["x-soq-invoice"] as string | undefined)?.trim();

    // No payment attached: challenge with 402 + a fresh invoice.
    if (!invoiceId) {
      if (!this.challengeAllowed(this.clientIp(req))) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ error: { message: "too many unpaid challenges, slow down" } }));
        return;
      }
      const amount = this.quoteSat(body);
      const inv = await this.ln.createInvoice(this.channelId, amount, {
        memo: `soq402 inference (${body.messages.length} msgs)`,
        expirySeconds: 300,
      });
      this.issued.set(inv.invoice_id, { amount_sat: amount, issued_at: Date.now(), redeemed: false });
      this.bus.emit({ type: "challenge", invoice_id: inv.invoice_id, amount_sat: amount, memo: inv.memo });
      res.writeHead(402, {
        "content-type": "application/json",
        "x-soq-invoice": inv.invoice_id,
        "x-soq-amount-sat": String(amount),
      });
      res.end(
        JSON.stringify({
          error: { message: "payment required", type: "soq402_payment_required" },
          payment: {
            scheme: "soq402/1",
            invoice_id: inv.invoice_id,
            uri: inv.uri,
            amount_sat: amount,
            expires_at: inv.expires_at,
            seller_pub: this.pubKeyHex,
            lsp: this.opts.lspUrl,
            retry: { header: "X-SOQ-Invoice" },
          },
        }),
      );
      return;
    }

    // Payment attached: verify and redeem, exactly once.
    const record = this.issued.get(invoiceId);
    if (!record) return reject(res, 402, "unknown invoice (not issued by this seller)");
    if (record.redeemed) return reject(res, 402, "invoice already redeemed");
    const inv = await this.ln.invoice(invoiceId);
    if (inv.status !== "paid") return reject(res, 402, `invoice is ${inv.status}, not paid`);
    record.redeemed = true; // mark before inference: one payment, one completion
    this.earnedSat += record.amount_sat;
    this.callsServed += 1;
    this.bus.emit({
      type: "paid",
      invoice_id: invoiceId,
      amount_sat: record.amount_sat,
      settle_ms: Date.now() - record.issued_at,
      payer: inv.payer_channel_id?.slice(0, 12) ?? "unknown",
    });
    const chNow = await this.ln.channel(this.channelId);
    this.bus.emit({
      type: "meter",
      agent: this.label,
      earned_sat: this.earnedSat,
      balance_sat: chNow.initiator_balance_sat,
      calls: this.callsServed,
      state_index: chNow.state_index,
    });

    // Run the inference (upstream or built-in mock).
    const t0 = Date.now();
    const out = await this.infer(body);
    const upstreamMs = Date.now() - t0;
    this.bus.emit({
      type: "inference",
      invoice_id: invoiceId,
      model: out.model,
      prompt_tokens: out.promptTokens,
      completion_tokens: out.completionTokens,
      upstream_ms: upstreamMs,
    });

    // Sign the receipt: this seller did this work for this payment.
    const receipt: Receipt = {
      v: 1,
      invoice_id: invoiceId,
      amount_sat: record.amount_sat,
      model: out.model,
      request_sha256: sha256Hex(raw),
      response_sha256: sha256Hex(out.content),
      prompt_tokens: out.promptTokens,
      completion_tokens: out.completionTokens,
      issued_at: new Date().toISOString(),
      seller_pub: this.pubKeyHex,
    };
    const tSign = Date.now();
    const signed: SignedReceipt = signReceipt(receipt, this.keys.secretKey);
    this.bus.emit({ type: "receipt", invoice_id: invoiceId, sign_ms: Date.now() - tSign });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `soq402-${invoiceId.slice(0, 12)}`,
        object: "chat.completion",
        model: out.model,
        choices: [
          { index: 0, message: { role: "assistant", content: out.content }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: out.promptTokens,
          completion_tokens: out.completionTokens,
          total_tokens: out.promptTokens + out.completionTokens,
        },
        soq402: { receipt: signed },
      }),
    );
  }

  private async infer(
    req: ChatRequest,
  ): Promise<{ content: string; model: string; promptTokens: number; completionTokens: number }> {
    const up = this.opts.upstream;
    if (!up) {
      // Built-in mock, clearly labelled. The demo is the payment rail, not the model.
      const last = req.messages[req.messages.length - 1]?.content ?? "";
      const content = mockReply(last);
      return {
        content,
        model: "soq402-mock",
        promptTokens: estimateTokens(req.messages.map((m) => m.content).join(" ")),
        completionTokens: estimateTokens(content),
      };
    }
    const resp = await fetch(`${up.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(up.apiKey ? { authorization: `Bearer ${up.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: up.model ?? req.model ?? "default",
        messages: req.messages,
        max_tokens: req.max_tokens ?? 256,
      }),
    });
    if (!resp.ok) throw new Error(`upstream ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as {
      model?: string;
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices[0]?.message?.content ?? "";
    return {
      content,
      model: data.model ?? up.model ?? "upstream",
      promptTokens: data.usage?.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join(" ")),
      completionTokens: data.usage?.completion_tokens ?? estimateTokens(content),
    };
  }
}

function reject(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "soq402_payment_rejected" } }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject_) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject_(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject_);
  });
}

/** Deterministic stand-in when no upstream model is configured. */
function mockReply(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim().slice(0, 120);
  return (
    `[soq402-mock] Considered: "${trimmed}". ` +
    `This reply was unlocked by a Lightning payment and is covered by a signed receipt. ` +
    `Point OPENAI_BASE_URL at any OpenAI-compatible endpoint to bill for a real model.`
  );
}
