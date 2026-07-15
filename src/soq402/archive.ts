// Conversation archive for the SOQ-402 live demo.
// -------------------------------------------------
// Every completed conversation (an ambient exchange or a visitor Q&A) is
// written to disk as one JSON file, so history survives restarts and
// visitors can browse what the machines talked about last week. Files are
// a few KB each; at the demo's cadence that is well under a MB a day.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArchivedMessage {
  from: string;
  to: string;
  text: string;
  model?: string;
  paid_sat: number;
  total_ms: number;
}

export interface Conversation {
  id: string;
  kind: "ambient" | "visitor";
  started_at: string;
  ended_at: string;
  /** The opening topic or the visitor's question. */
  opener: string;
  messages: ArchivedMessage[];
  total_sat: number;
}

export interface ConversationSummary {
  id: string;
  kind: "ambient" | "visitor";
  started_at: string;
  opener: string;
  message_count: number;
  total_sat: number;
}

const ID_RE = /^[a-z0-9-]+$/;

export class ArchiveStore {
  private index: ConversationSummary[] = [];

  constructor(private readonly dir: string) {
    mkdirSync(join(dir, "conversations"), { recursive: true });
    const indexPath = join(dir, "index.json");
    if (existsSync(indexPath)) {
      try {
        this.index = JSON.parse(readFileSync(indexPath, "utf8"));
      } catch {
        // Rebuild from the conversation files if the index is unreadable.
        this.index = readdirSync(join(dir, "conversations"))
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            const c = JSON.parse(readFileSync(join(dir, "conversations", f), "utf8")) as Conversation;
            return summarize(c);
          })
          .sort((a, b) => a.started_at.localeCompare(b.started_at));
      }
    }
  }

  save(c: Conversation): void {
    if (!ID_RE.test(c.id)) throw new Error(`bad conversation id: ${c.id}`);
    writeFileSync(join(this.dir, "conversations", `${c.id}.json`), JSON.stringify(c));
    this.index.push(summarize(c));
    writeFileSync(join(this.dir, "index.json"), JSON.stringify(this.index));
  }

  /** Newest-first summaries, paged: offset 0 is the most recent. */
  list(limit = 10, offset = 0): ConversationSummary[] {
    const end = Math.max(0, this.index.length - offset);
    const start = Math.max(0, end - limit);
    return this.index.slice(start, end).reverse();
  }

  get(id: string): Conversation | null {
    if (!ID_RE.test(id)) return null;
    const path = join(this.dir, "conversations", `${id}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }

  get count(): number {
    return this.index.length;
  }
}

function summarize(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    kind: c.kind,
    started_at: c.started_at,
    opener: c.opener.slice(0, 140),
    message_count: c.messages.length,
    total_sat: c.total_sat,
  };
}
