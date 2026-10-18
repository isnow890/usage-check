import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { DATA_DIR } from "../cache.mjs";

const run = promisify(execFile);
const RPC = "/exa.language_server_pb.LanguageServerService/";
const LAST_QUOTA = path.join(DATA_DIR, "antigravity-app-quota.json");
const TTL_MS = 60_000;
let memo = { at: 0, value: null };

function base(overrides = {}) {
  return {
    id: "antigravity", name: "Gemini / Antigravity", subtitle: "Google AI",
    kind: "subscription", plan: null, account: null, quota: [], balance: null,
    usage: null, daily: [], models: [], notes: [], ...overrides,
  };
}

const WINDOW_RANK = { "5h": 0, weekly: 1, monthly: 2 };
function windowLabel(window) {
  return ({ "5h": "5-hour", weekly: "Weekly", monthly: "Monthly" })[window] ?? window;
}

function shortGroup(name) {
  if (/argon/i.test(name)) return "Gemini 4 Argon";
  if (/gemini/i.test(name)) return "Gemini";
  if (/claude|gpt/i.test(name)) return "Claude/GPT";
  return name;
}

/** Keep distinct pools by bucket identity, never by a shortened display name. */
export function parseQuotaSummary(payload) {
  const summary = payload?.response ?? payload;
  const rows = [];
  for (const group of summary?.groups ?? []) {
    const buckets = [...(group.buckets ?? [])].sort(
      (a, b) => (WINDOW_RANK[a.window] ?? 9) - (WINDOW_RANK[b.window] ?? 9),
    );
    for (const bucket of buckets) {
      const remaining = bucket.remainingFraction;
      // Protobuf JSON omits zero scalars, including an exhausted bucket's
      // remainingFraction. A missing bucket itself is never fabricated.
      if (remaining === null || (remaining !== undefined && (typeof remaining !== "number" || !Number.isFinite(remaining)))) continue;
      if (!bucket.bucketId || !bucket.window || !group.displayName) continue;
      const remainingPercent = Math.max(0, Math.min(100, (remaining ?? 0) * 100));
      rows.push({
        id: bucket.bucketId,
        label: `${shortGroup(group.displayName)} · ${windowLabel(bucket.window)}`,
        group: group.displayName,
        window: windowLabel(bucket.window),
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: bucket.resetTime ?? null,
        detail: bucket.description ?? null,
        live: true,
      });
    }
  }
  return rows;
}

async function appServers() {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const processes = stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[2];
    if (!/Antigravity\.app\/Contents\/Resources\/bin\/language_server\s/.test(command)) return [];
    if (!/--standalone(?:\s|$)/.test(command)) return [];
    const csrf = command.match(/--csrf_token(?:=|\s+)(\S+)/)?.[1];
    return csrf ? [{ pid: match[1], csrf }] : [];
  });
  const servers = [];
  for (const proc of processes) {
    try {
      const { stdout: sockets } = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", proc.pid, "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 5000 });
      for (const socket of sockets.split("\n")) {
        const port = socket.match(/^n127\.0\.0\.1:(\d+)$/)?.[1];
        if (port) servers.push({ port: Number(port), csrf: proc.csrf });
      }
    } catch { /* The app may have exited between ps and lsof. */ }
  }
  return servers;
}

async function rpc(server, method) {
  const response = await fetch(`http://127.0.0.1:${server.port}${RPC}${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codeium-csrf-token": server.csrf },
    body: "{}",
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Local Antigravity API: HTTP ${response.status}`);
  return response.json();
}

export async function collect() {
  if (memo.value && Date.now() - memo.at < TTL_MS) return memo.value;
  const servers = await appServers().catch(() => []);
  for (const server of servers) {
    try {
      const payload = await rpc(server, "RetrieveUserQuotaSummary");
      const quota = parseQuotaSummary(payload);
      if (!quota.length) continue;
      const status = await rpc(server, "GetUserStatus").catch(() => null);
      const user = status?.userStatus;
      const value = base({
        status: "ok",
        sampledAt: new Date().toISOString(),
        plan: user?.userTier?.name ?? user?.planStatus?.planInfo?.planName ?? null,
        account: user?.email ?? null,
        quota,
        sources: ["Antigravity.app:RetrieveUserQuotaSummary (loopback)"],
        notes: ["Read from the running Antigravity app's local API, including separate model quota pools."],
      });
      // Store only the displayed quota, never the app's local CSRF credential.
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const temporary = `${LAST_QUOTA}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await fs.rename(temporary, LAST_QUOTA);
      } catch { /* A cache failure must not discard a live reading. */ }
      memo = { at: Date.now(), value };
      return value;
    } catch { /* The other listening port may be the HTTPS port. */ }
  }

  let last;
  try { last = JSON.parse(await fs.readFile(LAST_QUOTA, "utf8")); } catch { /* First run. */ }
  const value = base({
    status: last?.quota?.length ? "stale" : "unavailable",
    message: servers.length
      ? "Antigravity's current model limits could not be read."
      : "Open Antigravity to read its current model limits.",
    sampledAt: last?.sampledAt,
    plan: last?.plan ?? null,
    account: last?.account ?? null,
    lastKnown: last?.quota?.map(({ label, usedPercent }) => ({ label, usedPercent })),
    sources: ["Antigravity.app:RetrieveUserQuotaSummary (loopback)"],
  });
  memo = { at: Date.now(), value };
  return value;
}
