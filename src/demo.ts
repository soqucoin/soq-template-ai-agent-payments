// Demo: a client AI agent paying a metered AI service per inference, over Lightning.
//
//   LOCAL (default):   npm start                    in-memory simulation, no network
//   LIVE (stagenet):   LSP_URL=... npm start         real channel + real payments
//
// The pattern: the service charges per output token, and the client pays instantly
// over a Lightning channel. Swap mockInference() for a real model or API call and
// you have pay-per-inference for AI agents.

import "dotenv/config";
import { PayPerCallAgent } from "./agent.js";

// Price the service charges per output token, in satoshis. 1 SOQ = 100,000,000 sat,
// so 100 sat per token is 0.000001 SOQ per token. Set your own price.
const PRICE_PER_TOKEN_SAT = 100;

// Stand-in for a real AI service. Replace this with an actual model or API call.
function mockInference(prompt: string): string {
  return `Echo: ${prompt} -- this is where your model's response goes.`;
}

async function main(): Promise<void> {
  const lspUrl = process.env.LSP_URL;
  console.log(
    lspUrl
      ? `LIVE mode. Stagenet LSP: ${lspUrl}\n`
      : "LOCAL simulation. Set LSP_URL in .env to make real stagenet payments.\n",
  );

  // The client agent opens a channel once. In LIVE mode it is funded by the
  // stagenet faucet; in LOCAL mode it is simulated.
  const client = await PayPerCallAgent.create({
    lspUrl,
    label: "client",
    capacitySat: 1_000_000_000, // 10 SOQ
  });
  console.log(`client agent ready. identity ${client.pubKeyHex.slice(0, 16)}...\n`);

  const prompts = [
    "Summarize the post-quantum threat in one line.",
    "Write a haiku about Lightning payments.",
    "List three uses for machine-to-machine payments.",
  ];

  let totalPaidSat = 0;
  for (const prompt of prompts) {
    // 1. Call the metered AI service.
    const response = mockInference(prompt);
    const tokens = response.split(/\s+/).length;
    const costSat = tokens * PRICE_PER_TOKEN_SAT;

    // 2. Pay for that call instantly over the channel.
    const r = await client.pay(costSat);
    totalPaidSat += costSat;

    console.log(`> ${prompt}`);
    console.log(`  ${response}`);
    console.log(
      `  paid ${costSat} sat for ${tokens} tokens` +
        `  |  balance ${r.remainingSat} sat` +
        `  |  state ${r.stateIndex === -1 ? "(local)" : r.stateIndex}\n`,
    );
  }

  console.log(`Total paid: ${totalPaidSat} sat across ${prompts.length} calls.`);
  console.log(`Remaining balance: ${await client.balanceSat()} sat.`);
  await client.close();
  console.log(lspUrl ? "Channel closed and settled on L1." : "Done (no channel to close in local mode).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
