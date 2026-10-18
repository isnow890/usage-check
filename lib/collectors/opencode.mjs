import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import {
  HOME,
  bucketsToArray,
  dayKey,
  emptyBuckets,
  addToBucket,
  sumBuckets,
  round,
} from "../util.mjs";

const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode");
const DB_PATH = path.join(DATA_DIR, "opencode.db");
const AUTH_PATH = path.join(DATA_DIR, "auth.json");
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const QUOTA_TTL_MS = 60_000;
let quotaMemo = { at: 0, key: null, value: null };

export function parseQuota(payload) {
  const windows = [["rolling", "5-hour limit"], ["weekly", "Weekly limit"], ["monthly", "Monthly limit"]];
  return windows.flatMap(([key, label]) => {
    const window = payload?.usage?.[key];
    const percent = window?.percent;
    if (typeof percent !== "number" && (typeof percent !== "string" || !percent.trim())) return [];
    if (!Number.isFinite(Number(percent))) return [];
    const usedPercent = Math.max(0, Math.min(100, Number(percent)));
    const reset = window.resetsAt ?? window.reset_at;
    const resetMs = typeof reset === "string" ? Date.parse(reset) : NaN;
    return [{
      label,
      usedPercent: round(usedPercent, 2),
      remainingPercent: round(100 - usedPercent, 2),
      resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      live: true,
    }];
  });
}

export async function collectQuota({ authPath = AUTH_PATH, fetchImpl = fetch, now = Date.now() } = {}) {
  const explicitKey = process.env.OPENCODE_API_KEY?.trim() || process.env.OPENCODE_GO_API_KEY?.trim();
  let keys = explicitKey ? [explicitKey] : [];
  if (!keys.length) {
    try {
      const auth = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ authPath, "utf8"));
      // Current CLI logins use opencode; older Go logins use opencode-go.
      keys = [...new Set([auth.opencode?.key, auth["opencode-go"]?.key]
        .filter((key) => typeof key === "string" && key.trim()).map((key) => key.trim()))];
    } catch { /* A missing login must not hide the local usage database. */ }
  }
  if (!keys.length) return { quotaStatus: "unavailable", quotaMessage: "No OpenCode Go API key found on this machine.", quota: [] };
  const credentialSet = JSON.stringify(keys);
  if (quotaMemo.key === credentialSet && quotaMemo.value && now - quotaMemo.at < QUOTA_TTL_MS) return quotaMemo.value;

  let value;
  for (const key of keys) {
    try {
      // Fixed vendor origin and no redirects: the key never goes to a collector service.
      const response = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${key}`, "x-opencode-session": "usage-check", "User-Agent": "usage-check" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const expired = payload?.error?.code === "api_key_expired";
        value = {
          quotaStatus: "unavailable",
          quota: [],
          quotaMessage: expired
            ? "OpenCode Go API key expired. Create a new key in OpenCode Console, then update it with opencode auth login."
            : `OpenCode Go quota request failed (HTTP ${response.status}).`,
        };
        if (response.status === 401 || response.status === 403) continue;
      } else {
        const quota = parseQuota(payload);
        value = quota.length
          ? { quotaStatus: "ok", quota, sampledAt: new Date(now).toISOString() }
          : { quotaStatus: "unavailable", quota: [], quotaMessage: "OpenCode Go returned no readable plan limits." };
      }
    } catch {
      value = { quotaStatus: "unavailable", quota: [], quotaMessage: "OpenCode Go quota could not be reached." };
    }
    break;
  }
  quotaMemo = { at: now, key: credentialSet, value };
  return value;
}

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

function empty(notes) {
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
    notes,
  };
}

export async function collect({ days = 60 } = {}) {
  const limits = await collectQuota();
  if (!existsSync(DB_PATH)) {
    return { ...empty([`No database at ${DB_PATH}.`]), ...limits, sources: [USAGE_URL] };
  }

  // `node:sqlite` is only flag-free from Node 22.13. Loading it lazily keeps an
  // older runtime from throwing during import and taking every other collector
  // down with it; this way only the OpenCode card goes unavailable.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ...empty([
      "This Node runtime has no node:sqlite module, so the OpenCode database cannot be read.",
      "OpenCode support needs Node 22.13 or newer.",
    ]), ...limits, sources: [USAGE_URL] };
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
    subtitle: "Go API · local sqlite",
    kind: "metered",
    plan: null,
    account: null,
    ...limits,
    balance: { label: "Recorded cost", value: round(cost), currency: "USD" },
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
    notes: ["Tokens and recorded cost cover this machine's OpenCode database, not every client using the account. Recorded cost is not the subscription invoice or plan utilization."],
    sources: [DB_PATH, USAGE_URL],
  };
}
