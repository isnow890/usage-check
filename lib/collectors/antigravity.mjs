import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../cache.mjs";
import { HOME } from "../util.mjs";

/**
 * Two hosts serve the same schema. The production host answers consumer
 * subscriptions with placeholder buckets (everything full), while the canary
 * host carries the real consumption, so the canary is tried first and
 * production is only a fallback. Verified against the app's own Models & Usage
 * panel: canary reported Gemini weekly 59.1% / 5-hour 2.0% while production
 * reported 98.1% / 100% for the same account and moment.
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

async function call(token, method, payload) {
  const failures = [];
  for (const base of CLOUD_CODE_ENDPOINTS) {
    try {
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
      if (!response.ok) {
        failures.push(`${new URL(base).host} HTTP ${response.status}`);
        continue;
      }
      return { payload: await response.json(), host: new URL(base).host };
    } catch (error) {
      failures.push(`${new URL(base).host} ${error.message}`);
    }
  }
  throw new Error(`cloudcode ${method} failed (${failures.join("; ")})`);
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
  const { payload: summary, host } = await call(token, "retrieveUserQuotaSummary", {});
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];

  const quota = [];
  for (const group of groups) {
    const buckets = [...(group.buckets ?? [])].sort(
      (a, b) => (WINDOW_RANK[a.window] ?? 9) - (WINDOW_RANK[b.window] ?? 9),
    );
    for (const bucket of buckets) {
      const remaining = Number(bucket.remainingFraction);
      if (!Number.isFinite(remaining)) continue;
      const remainingPct = Math.max(0, Math.min(100, remaining * 100));
      quota.push({
        label: `${shortGroup(group.displayName)} · ${windowLabel(bucket.window)}`,
        group: group.displayName,
        window: windowLabel(bucket.window),
        usedPercent: 100 - remainingPct,
        remainingPercent: remainingPct,
        resetsAt: bucket.resetTime ?? null,
        detail: bucket.description ?? null,
      });
    }
  }
  return { quota, note: summary?.description ?? null, host };
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
        `Live from ${quota.host}/v1internal:retrieveUserQuotaSummary.`,
        quota.note,
      ].filter(Boolean),
      sources: [`${quota.host}:retrieveUserQuotaSummary`],
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
