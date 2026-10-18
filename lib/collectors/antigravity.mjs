import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../cache.mjs";
import { HOME } from "../util.mjs";

/**
 * Two hosts serve the same schema and neither is a superset, so both are read
 * and merged per bucket instead of picking one winner.
 *
 * 2026-09-18: the canary carried real consumption while production returned
 * placeholder buckets (everything full) for consumer subscriptions, so canary
 * won. Repeated calls on 2026-10-18 show the opposite shape: the canary answers
 * with only the third-party group at a flat 0%, while production returns the
 * Gemini group (weekly 16.1%) plus that same third-party group. Reading either
 * host alone is what made the Gemini rows vanish from the card.
 *
 * Merging is safe because the hosts agree on every bucket they both return.
 * Where they disagree the larger used-percent wins: a host missing consumption
 * is far likelier than one inventing it, so a stale host can never make the
 * card look emptier than it really is.
 */
const CLOUD_CODE_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

/**
 * The desktop app's own public OAuth client. It ships inside Antigravity and is
 * reproduced by every third-party client, so it is a stable identifier rather
 * than a secret. The refresh token stays on this machine; only the short-lived
 * access token is derived from it.
 */
const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

const TOKEN_SOURCES = [
  path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  path.join(HOME, ".gemini", "jetski-standalone-oauth-token"),
];

const TOKEN_CACHE = path.join(DATA_DIR, "antigravity-token.json");
const QUOTA_TTL_MS = 60_000;
const REQUEST_MS = 20_000;

let quotaMemo = { at: 0, value: null };

function base(overrides = {}) {
  return {
    id: "antigravity",
    name: "Gemini / Antigravity",
    subtitle: "Google AI",
    kind: "subscription",
    plan: null,
    account: null,
    quota: [],
    balance: null,
    usage: null,
    daily: [],
    models: [],
    notes: [],
    ...overrides,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    /* a failed cache write only costs one extra refresh */
  }
}

async function refreshToken() {
  for (const source of TOKEN_SOURCES) {
    const doc = await readJson(source);
    const refresh = doc?.token?.refresh_token ?? doc?.refresh_token;
    if (!refresh) continue;

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) continue;
    const token = await response.json();
    return token.access_token;
  }
  return null;
}

async function accessToken() {
  const cached = await readJson(TOKEN_CACHE);
  const at = Date.parse(cached?.expiresAt ?? "");
  if (cached?.accessToken && Number.isFinite(at) && at - 60_000 > Date.now()) {
    return cached.accessToken;
  }
  const fresh = await refreshToken();
  if (!fresh) return null;
  await writeJson(TOKEN_CACHE, {
    accessToken: fresh,
    expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
  });
  return fresh;
}

async function callHost(base, token, method, payload) {
  const response = await fetch(`${base}/v1internal:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "antigravity",
      "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** First host that answers, for calls where only one reply is meaningful. */
async function call(token, method, payload) {
  const failures = [];
  for (const base of CLOUD_CODE_ENDPOINTS) {
    try {
      return { payload: await callHost(base, token, method, payload), host: new URL(base).host };
    } catch (error) {
      failures.push(`${new URL(base).host} ${error.message}`);
    }
  }
  throw new Error(`cloudcode ${method} failed (${failures.join("; ")})`);
}

/** Every host that answers, so quota buckets missing from one are recovered. */
async function callAllHosts(token, method, payload) {
  const settled = await Promise.all(
    CLOUD_CODE_ENDPOINTS.map(async (base) => {
      try {
        return { host: new URL(base).host, payload: await callHost(base, token, method, payload) };
      } catch (error) {
        return { host: new URL(base).host, error: error.message };
      }
    }),
  );
  return settled;
}

function windowLabel(window) {
  if (window === "5h") return "5-hour";
  if (window === "weekly") return "Weekly";
  return window ?? "Limit";
}

/** Shortest window first, so the row order matches how the limit runs out. */
const WINDOW_RANK = { "5h": 0, weekly: 1, monthly: 2 };

function shortGroup(name) {
  if (/gemini/i.test(name)) return "Gemini";
  if (/claude|gpt/i.test(name)) return "Claude/GPT";
  return name;
}

/**
 * Antigravity meters two shared pools — Gemini and third-party (Claude/GPT) —
 * each with a weekly and a rolling 5-hour bucket. `retrieveUserQuotaSummary`
 * is the same call the app's Models & Usage screen renders, including its
 * reset copy, so this reports one quota row per group bucket.
 */
async function fetchQuota(token) {
  const replies = await callAllHosts(token, "retrieveUserQuotaSummary", {});
  const answered = replies.filter((reply) => reply.payload);
  if (!answered.length) {
    throw new Error(`cloudcode retrieveUserQuotaSummary failed (${replies.map((r) => `${r.host} ${r.error}`).join("; ")})`);
  }

  const groups = new Map();
  const hosts = new Set();
  for (const reply of answered) {
    hosts.add(reply.host);
    for (const group of reply.payload.groups ?? []) {
      const key = shortGroup(group.displayName);
      const entry = groups.get(key) ?? { displayName: group.displayName, buckets: new Map() };
      for (const bucket of group.buckets ?? []) {
        const remaining = Number(bucket.remainingFraction);
        if (!Number.isFinite(remaining)) continue;
        const used = 100 - Math.max(0, Math.min(100, remaining * 100));
        const prior = entry.buckets.get(bucket.window);
        // Keep the largest used-percent: a host that is behind can only
        // under-report, so the fuller reading is the safer one to show.
        if (!prior || used > prior.usedPercent) {
          entry.buckets.set(bucket.window, {
            usedPercent: used,
            remainingPercent: 100 - used,
            resetsAt: bucket.resetTime ?? null,
            detail: bucket.description ?? null,
          });
        }
      }
      groups.set(key, entry);
    }
  }

  const quota = [];
  for (const entry of groups.values()) {
    const buckets = [...entry.buckets.entries()].sort(
      ([a], [b]) => (WINDOW_RANK[a] ?? 9) - (WINDOW_RANK[b] ?? 9),
    );
    for (const [window, bucket] of buckets) {
      quota.push({
        label: `${shortGroup(entry.displayName)} · ${windowLabel(window)}`,
        group: entry.displayName,
        window: windowLabel(window),
        usedPercent: bucket.usedPercent,
        remainingPercent: bucket.remainingPercent,
        resetsAt: bucket.resetsAt,
        detail: bucket.detail,
      });
    }
  }

  return { quota, note: answered[0].payload?.description ?? null, hosts: [...hosts] };
}

export async function collect() {
  if (quotaMemo.value && Date.now() - quotaMemo.at < QUOTA_TTL_MS) {
    return quotaMemo.value;
  }

  let token;
  try {
    token = await accessToken();
  } catch (error) {
    return base({
      status: "unavailable",
      message: `Could not refresh the Antigravity token: ${error.message}`,
    });
  }
  if (!token) {
    return base({
      status: "unavailable",
      message:
        "No Antigravity refresh token on this machine. Sign in to the Antigravity app once to create one.",
    });
  }

  try {
    const quota = await fetchQuota(token);
    const plan = await call(token, "loadCodeAssist", {
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    })
      .then((r) => r.payload)
      .catch(() => null);

    const value = base({
      status: quota.quota.length ? "ok" : "unavailable",
      message: quota.quota.length
        ? null
        : "Antigravity reported no quota buckets.",
      plan: plan?.paidTier?.name ?? plan?.currentTier?.name ?? null,
      account: null,
      sampledAt: new Date().toISOString(),
      quota: quota.quota,
      notes: [
        `Live from ${quota.hosts.join(" + ")}/v1internal:retrieveUserQuotaSummary, merged per bucket.`,
        quota.note,
      ].filter(Boolean),
      sources: quota.hosts.map((host) => `${host}:retrieveUserQuotaSummary`),
    });
    quotaMemo = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = base({
      status: "unavailable",
      message: `Antigravity quota request failed: ${error.message}`,
    });
    return value;
  }
}
