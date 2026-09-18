import path from "node:path";

import { FileCache } from "../cache.mjs";
import {
  HOME,
  bucketsToArray,
  dayKey,
  emptyBuckets,
  addToBucket,
  listFiles,
  readHead,
  readTail,
  lastJsonInTail,
  sumBuckets,
  topModels,
  num,
} from "../util.mjs";

const SESSIONS_DIR = path.join(HOME, ".codex", "sessions");
const ARCHIVE_DIR = path.join(HOME, ".codex", "archived_sessions");
const TAIL_BYTES = 512 * 1024;

function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return "Limit";
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "Weekly";
  if (minutes === 1440) return "Daily";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}

/** Codex reports whichever window it is currently enforcing as `primary`. */
function parseRateLimits(record) {
  const limits = record?.payload?.rate_limits ?? record?.rate_limits;
  if (!limits || typeof limits !== "object") return null;
  const out = [];
  for (const slot of [limits.primary, limits.secondary]) {
    if (!slot || !Number.isFinite(slot.used_percent)) continue;
    const usedPercent = Math.max(0, Math.min(100, slot.used_percent));
    out.push({
      label: windowLabel(slot.window_minutes),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes: slot.window_minutes ?? null,
      resetsAt: Number.isFinite(slot.resets_at) ? new Date(slot.resets_at * 1000).toISOString() : null,
    });
  }
  if (!out.length) return null;
  return { plan: limits.plan_type ?? null, metrics: out, at: record?.timestamp ?? null };
}

/**
 * A Codex rollout is append-only and can reach hundreds of MB, but everything
 * needed for a usage row sits in the first line and the last few records, so a
 * head plus tail read replaces a full scan of the 24 GB session tree.
 */
async function parseSession(file, stat) {
  const head = await readHead(file, 64 * 1024);
  const firstLine = head.split("\n", 1)[0];
  let meta = null;
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type === "session_meta") meta = parsed.payload;
  } catch {
    /* fall through to the tail-derived timestamp */
  }

  const tail = await readTail(file, TAIL_BYTES);
  const usageRecord = lastJsonInTail(tail, '"type":"token_usage_record"');
  const tokenCount = lastJsonInTail(tail, '"type":"token_count"');
  const rateRecord = lastJsonInTail(tail, '"plan_type"');
  // The model lives on turn_context; token_usage_record carries no model field,
  // which is why Codex used to drop out of the per-model table entirely.
  const turnContext = lastJsonInTail(tail, '"type":"turn_context"');

  const tokens =
    usageRecord?.payload?.thread_token_usage ??
    tokenCount?.payload?.info?.total_token_usage ??
    null;
  if (!tokens) return null;

  const startedAt = meta?.timestamp ?? usageRecord?.timestamp ?? new Date(stat.mtimeMs).toISOString();
  return {
    date: dayKey(new Date(startedAt)),
    startedAt,
    cwd: meta?.cwd ?? null,
    model: turnContext?.payload?.model ?? usageRecord?.payload?.model ?? null,
    tokens: {
      input: num(tokens.input_tokens),
      cached: num(tokens.cached_input_tokens),
      cacheWrite: num(tokens.cache_write_input_tokens),
      output: num(tokens.output_tokens),
      reasoning: num(tokens.reasoning_output_tokens),
      total: num(tokens.total_tokens),
    },
    rateLimits: parseRateLimits(rateRecord),
  };
}

export async function collect({ days = 60 } = {}) {
  const since = Date.now() - days * 86400_000;
  const cache = await new FileCache("codex").load();

  const [sessions, archived] = await Promise.all([
    listFiles(SESSIONS_DIR, { since, filter: (name) => name.endsWith(".jsonl") }),
    listFiles(ARCHIVE_DIR, { since, filter: (name) => name.endsWith(".jsonl") }),
  ]);
  const files = [...sessions, ...archived];

  const buckets = emptyBuckets(days);
  const models = new Map();
  const projects = new Map();
  let scanned = 0;
  let latestRate = null;
  let latestRateAt = 0;

  for (const file of files) {
    let value = cache.get(file.path, file);
    if (value === undefined) {
      value = await parseSession(file.path, file);
      cache.set(file.path, file, value);
    } else if (value === null) {
      continue;
    }
    if (!value) continue;
    scanned += 1;

    addToBucket(buckets, value.date, value.tokens.total, 1);

    if (value.model) {
      const entry = models.get(value.model) ?? { name: value.model, tokens: 0, requests: 0 };
      entry.tokens += value.tokens.total;
      entry.requests += 1;
      models.set(value.model, entry);
    }
    if (value.cwd) {
      const entry = projects.get(value.cwd) ?? { name: value.cwd, tokens: 0, requests: 0 };
      entry.tokens += value.tokens.total;
      entry.requests += 1;
      projects.set(value.cwd, entry);
    }
    if (value.rateLimits?.metrics?.length) {
      const at = Date.parse(value.startedAt) || 0;
      if (at >= latestRateAt) {
        latestRate = value.rateLimits;
        latestRateAt = at;
      }
    }
  }

  cache.prune(new Set(files.map((f) => f.path)));
  await cache.save();

  const totals = sumBuckets(buckets);
  const today = buckets.get(dayKey()) ?? { tokens: 0, requests: 0 };
  const last7 = [...buckets.entries()]
    .slice(-7)
    .reduce((acc, [, v]) => ({ tokens: acc.tokens + v.tokens, requests: acc.requests + v.requests }), { tokens: 0, requests: 0 });

  const quota = (latestRate?.metrics ?? []).map((m) => ({
    ...m,
    detail: m.detail ?? null,
  }));

  return {
    id: "codex",
    name: "Codex",
    subtitle: "OpenAI · rollout logs",
    kind: quota.length ? "subscription" : "metered",
    status: quota.length ? "ok" : "unavailable",
    sampledAt: latestRateAt ? new Date(latestRateAt).toISOString() : null,
    message: quota.length
      ? null
      : "No plan limits were recorded in this window. Sessions routed through codex-router do not carry OpenAI quota.",
    plan: latestRate?.plan ?? null,
    account: null,
    quota,
    balance: null,
    usage: {
      today,
      last7,
      window: totals,
      sessions: scanned,
      files: files.length,
    },
    daily: bucketsToArray(buckets),
    models: topModels(models, 8),
    projects: topModels(projects, 5),
    notes: [
      "Read from ~/.codex/sessions by head+tail, not a full scan.",
      quota.length
        ? null
        : "No rate_limits recorded in the window; sessions routed through codex-router do not carry OpenAI plan limits.",
    ].filter(Boolean),
    cache: { hits: cache.hits, misses: cache.misses },
  };
}
