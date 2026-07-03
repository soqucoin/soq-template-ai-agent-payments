# AI Agent Micropayments

A Soqucoin Builders League starter template. An AI agent pays a metered AI service per inference, instantly, over a post-quantum Lightning channel. Clone it, swap in your model, and you have pay-per-call payments for agents.

This is the frontier use case almost nobody has built yet: agents paying each other per call, per inference, or per token, in real time, sub-cent, machine to machine, with no card network in the loop.

## Quickstart

```bash
npm install
npm start
```

That runs the demo in LOCAL simulation, no network required, so you can see the metering logic immediately. To make real payments on stagenet, copy the env file and set the LSP:

```bash
cp .env.example .env
# edit .env and set LSP_URL=https://lsp.soqu.org
npm start
```

> This template depends on `soq-lightning-sdk` from npm, so a plain `npm install` works.

## What it does

A client agent calls a service that charges per output token and pays for each call over a Lightning channel. The output looks like this:

```
> Summarize the post-quantum threat in one line.
  Echo: ... this is where your model's response goes.
  paid 900 sat for 9 tokens  |  balance 999999100 sat  |  state 1
```

## How it works

The whole pattern is one small class, `PayPerCallAgent` (see `src/agent.ts`):

```ts
import { PayPerCallAgent } from "./agent.js";

// Open a channel once (faucet-funded on stagenet).
const client = await PayPerCallAgent.create({ lspUrl: process.env.LSP_URL });

// Pay for each unit of work. One call, one eLTOO state update.
await client.pay(costSat);

// When you are done.
await client.close();
```

Under the hood that wraps the Soqucoin Lightning SDK:

- `mlDsaKeygen()` gives the agent a post-quantum (ML-DSA-44) identity, generated client-side.
- `ln.fundAndOpen(...)` opens a channel, funded by the stagenet faucet.
- `ln.pay(channelId, amountSat)` settles a payment in a single state update. This is the micropayment.
- `ln.channel(id)` and `ln.close(id)` read state and settle on L1.

Amounts are always in satoshis. 1 SOQ is 100,000,000 satoshis.

## Make it yours

Replace `mockInference()` in `src/demo.ts` with a real model or API call, and set `PRICE_PER_TOKEN_SAT` to your price. The same shape works for:

- Pay-per-inference for an AI model endpoint.
- Pay-per-request API monetization, instead of subscriptions.
- Device-to-device and IoT micropayments.
- Pay-on-delivery, where payment only releases when the work is verifiably done (uses the SDK's HTLC layer; see "What is next").

## Agents billing agents (LIVE mode)

An agent can now get PAID, not just pay. `bill()` creates an LSP invoice and hands
back its `soqln:` URI; the counterparty settles it with `payInvoice()` and the
biller's channel balance grows:

```ts
// worker agent invoices for a completed job
const { invoiceId, uri } = await worker.bill(5_000, "inference batch #42");

// hiring agent settles it (URI can travel over any channel — HTTP, queue, QR)
await hirer.payInvoice(uri);

// worker confirms settlement before releasing the result
if (await worker.awaitPaid(invoiceId)) deliver();
```

Settlement is custodial on the hosted beta: the LSP hub atomically debits the
payer's channel and credits the biller's. This is the request-to-pay half of
agent-to-agent commerce, live today; trust-minimized multi-hop settlement is the
HTLC layer below.

> Running TWO live agents on one machine: `PayPerCallAgent.create` funds via the
> stagenet faucet, which allows one drip per IP per 10 minutes — stagger the two
> creates, or open the second agent's channel directly with the SDK's
> `ln.openChannel(...)` (no faucet, instant).

## The honest boundary

This template targets the current stagenet SDK (v0.1.0-alpha), which settles single-hop payments between an agent and the Lightning service provider — including agent-to-agent invoices, which the LSP hub settles custodially. True agent-to-agent routing across the network uses the SDK's HTLC and routing layer, which is built at the construction level and lights up as the forwarding endpoints ship. The LOCAL simulation mode is a teaching aid: it exercises the metering and balance logic without touching the network, and is clearly labelled as a simulation in the output. For real payments, point it at the stagenet LSP.

## What is next

- Swap the mock service for your real model.
- Add pay-on-delivery with hash-locked (HTLC) payments, so the service only gets paid when it returns a valid result.
- Meter by real token counts from your model's usage data.

## Legal

This template is provided for educational use on a test network, "AS IS" and without warranty, under the MIT License. It is a technical illustration, not a recommendation to pursue any particular business or use case, and it is not legal, financial, or tax advice. You are solely responsible for ensuring that anything you build with it complies with all applicable laws and regulations, including securities, money-transmission/MSB, AML/KYC, sanctions, tax, consumer-protection, and data-privacy laws. Some use cases are heavily regulated and may require licensing. Obtain your own legal advice before launching. See the Builders League terms: https://soqu.org/terms

Build something with this and apply to the Builders League at soqu.org/build/apply.
