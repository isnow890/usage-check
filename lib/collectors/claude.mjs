import path from "node:path";

import { FileCache } from "../cache.mjs";
import {
  HOME,
  bucketsToArray,
  dayKey,
  emptyBuckets,
  addToBucket,
  listFiles,
  parseJsonlLines,
  readJson,
  sumBuckets,
  topModels,
  num,
} from "../util.mjs";

const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const CONFIG_PATH = path.join(HOME, ".claude.json");

function parseUsage(usage) {
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  return {
    input,
    cached: cacheRead,
    cacheWrite,
    output,
    reasoning: num(usage.output_tokens_details?.thinking_tokens),
    total: input + cacheRead + cacheWrite + output,
  };
}

/**
 * One transcript aggregates into the daily buckets it touches. Returns null when
 * the file holds no assistant usage, so the cache can remember "nothing here".
 */
async function parseTranscript(file) {
  const records = await parseJsonlLines(file, ['"usage":{']);
  const days = new Map();
  const models = new Map();
  let sessions = 0;
  for (const record of records) {
    const usage = record?.message?.usage;
    if (!usage) continue;
    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const tokens = parseUsage(usage);
    const date = dayKey(at);
    const entry = days.get(date) ?? { tokens: 0, requests: 0 };
    entry.tokens += tokens.total;
    entry.requests += 1;
    days.set(date, entry);

    const model = record.message?.model ?? "unknown";
    const m = models.get(model) ?? { name: model, tokens: 0, requests: 0 };
    m.tokens += tokens.total;
    m.requests += 1;
    models.set(model, m);
    sessions += 1;
  }
  if (!sessions) return null;
  return {
    days: [...days.entries()].map(([date, v]) => ({ date, ...v })),
    models: [...models.values()],
    requests: sessions,
  };
}

function parseQuota(config) {
  const util = config?.cachedUsageUtilization;
  if (!util) return { quota: [], fetchedAt: null, plan: null };
  const quota = [];
  const limits = Array.isArray(util.limits) ? util.limits : [];
  for (const limit of limits) {
    if (!Number.isFinite(limit.percent)) continue;
    const label =
      limit.kind === "session" ? "5-hour" : limit.kind === "weekly_all" ? "Weekly" : limit.kind;
    quota.push({
      label,
      usedPercent: Math.max(0, Math.min(100, limit.percent)),
      remainingPercent: 100 - Math.max(0, Math.min(100, limit.percent)),
      resetsAt: limit.resets_at ?? null,
      severity: limit.severity ?? null,
      detail: limit.scope?.model?.display_name ? `${limit.scope.model.display_name} only` : null,
    });
  }
  return {
    quota,
    fetchedAt: Number.isFinite(util.fetchedAtMs) ? new Date(util.fetchedAtMs).toISOString() : null,
    plan: config?.oauthAccount?.seatTier ?? null,
  };
}

export async function collect({ days = 60 } = {}) {
  const since = Date.now() - days * 86400_000;
  const cache = await new FileCache("claude").load();
  const files = await listFiles(PROJECTS_DIR, { since, filter: (name) => name.endsWith(".jsonl") });

  const buckets = emptyBuckets(days);
  const models = new Map();
  let requests = 0;

  for (const file of files) {
    let value = cache.get(file.path, file);
    if (value === undefined) {
      value = await parseTranscript(file.path);
      cache.set(file.path, file, value);
    }
    if (!value) continue;
    for (const day of value.days) addToBucket(buckets, day.date, day.tokens, day.requests);
    for (const model of value.models) {
      const entry = models.get(model.name) ?? { name: model.name, tokens: 0, requests: 0 };
      entry.tokens += model.tokens;
      entry.requests += model.requests;
      models.set(model.name, entry);
    }
    requests += value.requests;
  }

  cache.prune(new Set(files.map((f) => f.path)));
  await cache.save();

  const config = await readJson(CONFIG_PATH);
  const { quota, fetchedAt, plan } = parseQuota(config);
  const totals = sumBuckets(buckets);
  const today = buckets.get(dayKey()) ?? { tokens: 0, requests: 0 };
  const last7 = [...buckets.entries()]
    .slice(-7)
    .reduce((a, [, v]) => ({ tokens: a.tokens + v.tokens, requests: a.requests + v.requests }), { tokens: 0, requests: 0 });

  return {
    id: "claude",
    name: "Claude",
    subtitle: "Anthropic · transcripts",
    kind: "subscription",
    plan,
    account: config?.oauthAccount?.emailAddress ?? null,
    status: quota.length ? "ok" : "unavailable",
    sampledAt: fetchedAt,
    message: quota.length
      ? null
      : "No plan limits are cached. This account has no active Claude subscription, so there is nothing to meter.",
    quota,
    balance: null,
    usage: { today, last7, window: totals, requests, files: files.length },
    daily: bucketsToArray(buckets),
    models: topModels(models, 8),
    notes: [
      quota.length
        ? "Quota is a cached snapshot written by Claude Code, not a live fetch."
        : "No cachedUsageUtilization in ~/.claude.json; open Claude Code once to refresh it.",
    ],
    cache: { hits: cache.hits, misses: cache.misses },
  };
}
