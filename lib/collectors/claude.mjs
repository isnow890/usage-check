import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
const CRED_PATH = path.join(HOME, ".claude", ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const QUOTA_TTL_MS = 60_000;
const REQUEST_MS = 20_000;

const execFileAsync = promisify(execFile);
let quotaMemo = { at: 0, value: null };

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

/**
 * Claude Code keeps its OAuth token in the login keychain. `~/.claude/.credentials.json`
 * is left behind by older installs and is no longer rewritten, so reading only
 * that file found an expired token and the card showed no subscription at all.
 * Both sources are read and the later expiry wins. The token is used and
 * discarded; it is never copied anywhere.
 *
 * The refresh token is deliberately not used. Refreshing can rotate it out from
 * under the running Claude Code session, so an expired access token is reported
 * instead of silently trading the user's login for a number on a dashboard.
 */
async function readCredential() {
  const sources = [];

  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    if (parsed?.claudeAiOauth?.accessToken) sources.push(parsed.claudeAiOauth);
  } catch {
    /* not macOS, no keychain entry, or access was declined */
  }

  const file = await readJson(CRED_PATH);
  if (file?.claudeAiOauth?.accessToken) sources.push(file.claudeAiOauth);

  if (!sources.length) return null;
  return sources.sort((a, b) => num(b.expiresAt) - num(a.expiresAt))[0];
}

async function fetchLiveQuota() {
  if (quotaMemo.value && Date.now() - quotaMemo.at < QUOTA_TTL_MS) return quotaMemo.value;

  const credential = await readCredential();
  if (!credential) {
    return { ok: false, reason: "no stored Claude Code credential was found" };
  }
  if (num(credential.expiresAt) <= Date.now()) {
    return {
      ok: false,
      reason: "the stored Claude Code token has expired; run Claude Code once so it refreshes",
    };
  }

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: `the usage endpoint answered HTTP ${response.status}` };
    }

    const payload = await response.json();
    const value = {
      ok: true,
      limits: Array.isArray(payload.limits) ? payload.limits : [],
      fetchedAt: new Date().toISOString(),
      plan: credential.subscriptionType ?? null,
    };
    quotaMemo = { at: Date.now(), value };
    return value;
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function toQuotaRows(limits) {
  const quota = [];
  for (const limit of limits) {
    if (!Number.isFinite(limit.percent)) continue;
    const used = Math.max(0, Math.min(100, limit.percent));
    quota.push({
      label:
        limit.kind === "session" ? "5-hour" : limit.kind === "weekly_all" ? "Weekly" : limit.kind,
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: limit.resets_at ?? null,
      severity: limit.severity ?? null,
      detail: limit.scope?.model?.display_name ? `${limit.scope.model.display_name} only` : null,
    });
  }
  return quota;
}

function parseQuota(config, live) {
  const seatTier = config?.oauthAccount?.seatTier ?? null;

  if (live?.ok && live.limits.length) {
    const plan = live.plan ?? seatTier;
    return {
      quota: toQuotaRows(live.limits),
      fetchedAt: live.fetchedAt,
      plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null,
      source: "live",
    };
  }

  const util = config?.cachedUsageUtilization;
  if (util) {
    return {
      quota: toQuotaRows(Array.isArray(util.limits) ? util.limits : []),
      fetchedAt: Number.isFinite(util.fetchedAtMs) ? new Date(util.fetchedAtMs).toISOString() : null,
      plan: seatTier,
      source: "cached",
    };
  }

  return { quota: [], fetchedAt: null, plan: seatTier, source: "none", reason: live?.reason ?? null };
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
  const live = await fetchLiveQuota();
  const { quota, fetchedAt, plan, source, reason } = parseQuota(config, live);
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
    status: quota.length ? (source === "live" ? "ok" : "stale") : "unavailable",
    sampledAt: fetchedAt,
    message: quota.length
      ? null
      : `No Claude plan limits are available. ${reason ?? "No usage snapshot was found."}`,
    quota,
    balance: null,
    usage: { today, last7, window: totals, requests, files: files.length },
    daily: bucketsToArray(buckets),
    models: topModels(models, 8),
    notes: [
      quota.length
        ? source === "live"
          ? "Limits read live from api.anthropic.com/api/oauth/usage using the token Claude Code stores in the login keychain."
          : "Limits are the cachedUsageUtilization snapshot in ~/.claude.json; Claude Code no longer refreshes it."
        : `Live usage unavailable: ${reason ?? "no credential"}.`,
    ],
    cache: { hits: cache.hits, misses: cache.misses },
  };
}
