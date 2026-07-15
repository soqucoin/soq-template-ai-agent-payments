// SOQ-402 demo: two AI agents conversing, paying each other per message.
// -----------------------------------------------------------------------
// Ada and Bit are autonomous agents. Each SELLS its intelligence behind a
// metered 402 gateway and BUYS the other's, one Lightning micropayment per
// message, with an ML-DSA-44 signed receipt for every exchange.
//
//   npm run soq402
//
// With XAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY set, the two agents
// run on real (different!) vendor models. With no keys, a clearly-labelled
// mock answers so the payment loop still runs end to end.
//
// Everything here is stagenet: test coins, hosted-beta custodial settlement.

import "dotenv/config";
import { EventBus } from "./events.js";
import { Soq402Seller } from "./seller.js";
import { Soq402Buyer } from "./buyer.js";
import { agentNames, detectProviders, type Provider } from "./providers.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LSP = process.env.LSP_URL ?? "https://lsp.soqu.org";
const ROUNDS = Number(process.env.SOQ402_ROUNDS ?? 3);
const PRICE_SAT = Number(process.env.SOQ402_PRICE_SAT ?? 333);

interface Persona {
  name: string;
  system: string;
  provider?: Provider;
}

async function main(): Promise<void> {
  const providers = detectProviders();
  const bus = new EventBus();

  // Agents go by their model vendor's name: "Claude paid Grok" lands,
  // "ada paid bit" does not.
  const [nameA, nameB] = agentNames(providers[0], providers[1] ?? providers[0]);
  const ada: Persona = {
    name: nameA,
    system:
      `You are ${nameA}, a terse, sharp AI agent in a paid conversation with ${nameB}: every ` +
      "message costs the asker real micropayments, so give value. Two sentences max.",
    provider: providers[0],
  };
  const bit: Persona = {
    name: nameB,
    system:
      `You are ${nameB}, a curious, playful AI agent in a paid conversation with ${nameA}: every ` +
      "message costs the asker real micropayments, so give value. Two sentences max.",
    provider: providers[1] ?? providers[0],
  };

  console.log(`SOQ-402: machine-to-machine payments demo (stagenet)`);
  console.log(`LSP: ${LSP}`);
  console.log(`${ada.name}: ${ada.provider?.model ?? "built-in mock"}  |  ${bit.name}: ${bit.provider?.model ?? "built-in mock"}`);
  console.log(`price: ${PRICE_SAT} shors per message, ${ROUNDS} rounds\n`);

  // Optional live console (built in a later step); served if present.
  const consolePath = join(dirname(fileURLToPath(import.meta.url)), "../../public/console.html");

  // Each agent sells its brain behind a 402 gateway...
  const sellerAda = await Soq402Seller.create({
    lspUrl: LSP,
    port: 4020,
    pricePerCallSat: PRICE_SAT,
    upstream: ada.provider,
    label: "ada-service",
    bus,
    consolePath: existsSync(consolePath) ? consolePath : undefined,
  });
  const sellerBit = await Soq402Seller.create({
    lspUrl: LSP,
    port: 4021,
    pricePerCallSat: PRICE_SAT,
    upstream: bit.provider,
    label: "bit-service",
    bus,
  });
  await sellerAda.listen();
  await sellerBit.listen();

  // ...and buys the other's with its own wallet, capped and budgeted.
  const buyerAda = await Soq402Buyer.create({
    lspUrl: LSP,
    label: ada.name,
    maxPerCallSat: 5_000,
    budgetSat: 100_000,
    bus,
  });
  const buyerBit = await Soq402Buyer.create({
    lspUrl: LSP,
    label: bit.name,
    maxPerCallSat: 5_000,
    budgetSat: 100_000,
    bus,
  });

  const transcript: Array<{ speaker: string; text: string }> = [];
  const opener =
    `${ada.name}, you and I are settling this conversation over post-quantum Lightning, ` +
    `${PRICE_SAT} shors a message, machine to machine. What should machines buy from each other first?`;
  transcript.push({ speaker: bit.name, text: opener });
  bus.emit({ type: "message", from: bit.name, to: ada.name, text: opener, paid_sat: 0, total_ms: 0 });
  console.log(`${bit.name} > ${opener}\n`);

  let totalSat = 0;
  let totalMsgs = 0;
  let receiptsOk = 0;
  const settleTimes: number[] = [];

  // Alternating turns: the asker PAYS the answerer's gateway for the reply.
  for (let round = 0; round < ROUNDS * 2; round++) {
    const askerIsBit = round % 2 === 0; // bit asked first, so ada answers first
    const answerer = askerIsBit ? ada : bit;
    const buyer = askerIsBit ? buyerBit : buyerAda;
    const sellerUrl = askerIsBit ? "http://localhost:4020" : "http://localhost:4021";

    const messages = [
      { role: "system", content: answerer.system },
      ...transcript.map((m) => ({
        role: m.speaker === answerer.name ? "assistant" : "user",
        content: m.text,
      })),
    ];

    const r = await buyer.chat(sellerUrl, messages, 160);
    transcript.push({ speaker: answerer.name, text: r.content });
    totalSat += r.paidSat;
    totalMsgs += 1;
    if (r.receiptOk) receiptsOk += 1;
    settleTimes.push(r.timings.pay);

    bus.emit({
      type: "message",
      from: answerer.name,
      to: buyer.label,
      text: r.content,
      model: r.model,
      paid_sat: r.paidSat,
      total_ms: r.timings.total,
    });
    console.log(`${answerer.name.padEnd(8)}> ${r.content}`);
    console.log(
      `      paid ${r.paidSat} shors by ${buyer.label}  |  settle ${r.timings.pay}ms  |  ` +
        `receipt ${r.receiptOk ? "verified (ML-DSA-44)" : "FAILED"}  |  loop ${r.timings.total}ms\n`,
    );
  }

  const avgSettle = Math.round(settleTimes.reduce((a, b) => a + b, 0) / settleTimes.length);
  console.log("----------------------------------------------------------------");
  console.log(`${totalMsgs} messages billed machine-to-machine: ${totalSat} shors total.`);
  console.log(`receipts verified: ${receiptsOk}/${totalMsgs}  |  avg payment settle: ${avgSettle}ms`);
  console.log(`${ada.name} spent ${buyerAda.sessionSpentSat} shors, ${bit.name} spent ${buyerBit.sessionSpentSat} shors.`);
  console.log(`zero cards, zero chargebacks, zero human sign-offs. stagenet test coins.`);

  if (process.env.SOQ402_HOLD === "1") {
    console.log("\nSOQ402_HOLD=1: seller gateways stay up (console at http://localhost:4020/). Ctrl-C to exit.");
    return; // leave servers and channels open for the console
  }

  await Promise.all([buyerAda.close(), buyerBit.close(), sellerAda.close(), sellerBit.close()]);
  console.log("\nall channels closed and settled on L1.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
