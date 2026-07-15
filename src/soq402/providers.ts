// Upstream model providers for the SOQ-402 demo.
// -----------------------------------------------
// The gateway speaks the OpenAI chat-completions shape, which every major
// vendor now exposes, so "swap in your model" is one base URL + one key:
//
//   Grok      https://api.x.ai/v1                                    XAI_API_KEY
//   Gemini    https://generativelanguage.googleapis.com/v1beta/openai GEMINI_API_KEY
//   Claude    https://api.anthropic.com/v1  (OpenAI SDK compat layer) ANTHROPIC_API_KEY
//   OpenAI    https://api.openai.com/v1                               OPENAI_API_KEY
//   Ollama    http://localhost:11434/v1                               (no key)
//
// detectProviders() returns whichever of these have keys in the environment,
// so the demo bills for real models when you have them and falls back to the
// labelled mock when you have none.

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Human display name for an agent backed by this provider ("Grok", "Claude").
 *  The vendor IS the identity: "Claude just paid Grok" lands, "ada paid bit"
 *  does not. Mock agents get distinct fallback names. */
export function providerDisplay(p: Provider | undefined, fallback: string): string {
  if (!p) return fallback;
  const known: Record<string, string> = {
    grok: "Grok",
    claude: "Claude",
    gemini: "Gemini",
    openai: "OpenAI",
  };
  return known[p.name] ?? p.name.charAt(0).toUpperCase() + p.name.slice(1);
}

/** Two display names, disambiguated if both agents run the same vendor. */
export function agentNames(a: Provider | undefined, b: Provider | undefined): [string, string] {
  let nameA = providerDisplay(a, "Mock-A");
  let nameB = providerDisplay(b, "Mock-B");
  if (nameA === nameB) {
    nameA = `${nameA}-A`;
    nameB = `${nameB}-B`;
  }
  return [nameA, nameB];
}

export function detectProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const found: Provider[] = [];
  if (env.XAI_API_KEY) {
    found.push({
      name: "grok",
      baseUrl: "https://api.x.ai/v1",
      apiKey: env.XAI_API_KEY,
      model: env.XAI_MODEL ?? "grok-4.20-non-reasoning",
    });
  }
  if (env.GEMINI_API_KEY) {
    found.push({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL ?? "gemini-2.5-flash",
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    found.push({
      name: "claude",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
    });
  }
  if (env.OPENAI_API_KEY) {
    found.push({
      name: "openai",
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-4o-mini",
    });
  }
  // Generic override: point at anything OpenAI-compatible (Ollama, vLLM, your own).
  if (env.UPSTREAM_BASE_URL) {
    found.unshift({
      name: env.UPSTREAM_NAME ?? "custom",
      baseUrl: env.UPSTREAM_BASE_URL,
      apiKey: env.UPSTREAM_API_KEY,
      model: env.UPSTREAM_MODEL ?? "default",
    });
  }
  return found;
}
