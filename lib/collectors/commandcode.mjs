import path from "node:path";

import {
  HOME,
  bucketsToArray,
  dayKey,
  emptyBuckets,
  addToBucket,
  parseJsonlLines,
  sumBuckets,
  topModels,
} from "../util.mjs";

const EVENTS_PATH = path.join(HOME, ".codex", "codex-router", "usage-events.jsonl");

export async function collect({ days = 60 } = {}) {
  const since = Date.now() - days * 86400_000;
  const records = await parseJsonlLines(EVENTS_PATH, ['"provider":"commandcode"']);

  const buckets = emptyBuckets(days);
  const models = new Map();
  let requests = 0;
  let failures = 0;
  let firstTokenSum = 0;
  let firstTokenCount = 0;

  for (const r of records) {
    const at = Date.parse(r.at ?? "");
    if (!Number.isFinite(at) || at < since) continue;
    const total = Number(r.totalTokens) || 0;
    requests += 1;
    if (Number(r.status) >= 400) failures += 1;
    if (Number.isFinite(r.firstTokenMs) && r.firstTokenMs > 0) {
      firstTokenSum += r.firstTokenMs;
      firstTokenCount += 1;
    }
    addToBucket(buckets, dayKey(at), total, 1);

    const name = r.model ?? "unknown";
    const m = models.get(name) ?? { name, tokens: 0, requests: 0, output: 0, reasoning: 0 };
    m.tokens += total;
    m.requests += 1;
    m.output += Number(r.outputTokens) || 0;
    m.reasoning += Number(r.reasoningTokens) || 0;
    models.set(name, m);
  }

  const totals = sumBuckets(buckets);
  const today = buckets.get(dayKey()) ?? { tokens: 0, requests: 0 };
  const last7 = [...buckets.entries()]
    .slice(-7)
    .reduce((a, [, v]) => ({ tokens: a.tokens + v.tokens, requests: a.requests + v.requests }), { tokens: 0, requests: 0 });

  return {
    id: "commandcode",
    name: "CommandCode",
    subtitle: "router metering",
    kind: "subscription",
    plan: null,
    account: null,
    quota: [],
    balance: null,
    usage: {
      today,
      last7,
      window: totals,
      requests,
      failures,
      medianFirstTokenMs: firstTokenCount ? Math.round(firstTokenSum / firstTokenCount) : null,
    },
    daily: bucketsToArray(buckets),
    models: topModels(models, 8),
    notes: [
      "Output-only metering: CommandCode reports inputTokens as 0 and exposes estimatedInputTokens separately.",
    ],
  };
}
