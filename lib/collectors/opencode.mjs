import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  HOME,
  bucketsToArray,
  dayKey,
  emptyBuckets,
  addToBucket,
  sumBuckets,
  round,
} from "../util.mjs";

const DB_PATH = path.join(HOME, ".local", "share", "opencode", "opencode.db");

const QUERY = `
  SELECT
    json_extract(data, '$.time.created')       AS created,
    json_extract(data, '$.tokens.total')       AS total,
    json_extract(data, '$.tokens.input')       AS input,
    json_extract(data, '$.tokens.output')      AS output,
    json_extract(data, '$.tokens.reasoning')   AS reasoning,
    json_extract(data, '$.tokens."cache"."read"')  AS cache_read,
    json_extract(data, '$.tokens."cache"."write"') AS cache_write,
    json_extract(data, '$.cost')               AS cost,
    json_extract(data, '$.modelID')            AS model,
    json_extract(data, '$.providerID')         AS provider,
    json_extract(data, '$.path.cwd')           AS cwd
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.time.created') >= ?
`;

export async function collect({ days = 60 } = {}) {
  if (!existsSync(DB_PATH)) {
    return {
      id: "opencode",
      name: "OpenCode",
      subtitle: "opencode-go",
      kind: "metered",
      plan: null,
      account: null,
      quota: [],
      balance: null,
      usage: null,
      daily: [],
      models: [],
      notes: [`No database at ${DB_PATH}.`],
    };
  }

  const since = Date.now() - days * 86400_000;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(QUERY).all(since);
  } finally {
    db.close();
  }

  const buckets = emptyBuckets(days);
  const models = new Map();
  const projects = new Map();
  let cost = 0;
  let lastUsed = 0;

  for (const row of rows) {
    const total = Number(row.total) || 0;
    const at = Number(row.created) || 0;
    if (!at) continue;
    addToBucket(buckets, dayKey(at), total, 1);
    cost += Number(row.cost) || 0;
    if (at > lastUsed) lastUsed = at;

    const key = `${row.provider ?? "?"}/${row.model ?? "?"}`;
    const m = models.get(key) ?? {
      name: row.model ?? "unknown",
      provider: row.provider ?? null,
      tokens: 0,
      requests: 0,
      cost: 0,
      input: 0,
      output: 0,
      cached: 0,
    };
    m.tokens += total;
    m.requests += 1;
    m.cost += Number(row.cost) || 0;
    m.input += Number(row.input) || 0;
    m.output += Number(row.output) || 0;
    m.cached += (Number(row.cache_read) || 0) + (Number(row.cache_write) || 0);
    models.set(key, m);

    if (row.cwd) {
      const p = projects.get(row.cwd) ?? { name: row.cwd, tokens: 0, requests: 0 };
      p.tokens += total;
      p.requests += 1;
      projects.set(row.cwd, p);
    }
  }

  const totals = sumBuckets(buckets);
  const today = buckets.get(dayKey()) ?? { tokens: 0, requests: 0 };
  const last7 = [...buckets.entries()]
    .slice(-7)
    .reduce((a, [, v]) => ({ tokens: a.tokens + v.tokens, requests: a.requests + v.requests }), { tokens: 0, requests: 0 });

  return {
    id: "opencode",
    name: "OpenCode",
    subtitle: "local sqlite",
    kind: "metered",
    plan: null,
    account: null,
    quota: [],
    balance: { label: "Cost", value: round(cost), currency: "USD" },
    usage: {
      today,
      last7,
      window: totals,
      requests: totals.requests,
      lastUsedAt: lastUsed ? new Date(lastUsed).toISOString() : null,
    },
    daily: bucketsToArray(buckets),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    projects: [...projects.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    notes: ["Per-message cost is stored by OpenCode itself, so this is measured spend, not an estimate."],
  };
}
