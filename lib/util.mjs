import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export const HOME = process.env.HOME;

export function dayKey(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysAgoKey(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return dayKey(d);
}

export function emptyBuckets(days) {
  const out = new Map();
  for (let i = days - 1; i >= 0; i -= 1) out.set(daysAgoKey(i), { tokens: 0, requests: 0 });
  return out;
}

export function addToBucket(buckets, date, tokens, requests = 1) {
  const entry = buckets.get(date);
  if (!entry) return;
  entry.tokens += tokens || 0;
  entry.requests += requests || 0;
}

export function bucketsToArray(buckets) {
  return [...buckets.entries()].map(([date, v]) => ({ date, ...v }));
}

export function sumBuckets(buckets) {
  let tokens = 0;
  let requests = 0;
  for (const v of buckets.values()) {
    tokens += v.tokens;
    requests += v.requests;
  }
  return { tokens, requests };
}

/** Files under `dir` matching a test, newest first. Missing dirs are not an error. */
export async function listFiles(dir, { since = 0, filter, maxDepth = 8 } = {}) {
  const found = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (filter && !filter(entry.name, full)) continue;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since) continue;
      found.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  await walk(dir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/** Read the first `bytes` of a file without slurping the rest. */
export async function readHead(file, bytes = 65536) {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Read the last `bytes` of a file. Used to avoid scanning multi-GB session logs. */
export async function readTail(file, bytes = 524288) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(bytes, size);
    const start = size - length;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Parse only the lines of a JSONL file that contain one of the needles. */
export async function parseJsonlLines(file, needles) {
  const out = [];
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let carry = "";
  for await (const chunk of stream) {
    const text = carry + chunk;
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      if (needles && !needles.some((n) => line.includes(n))) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a truncated line or a non-JSON record is not worth failing over */
      }
    }
  }
  if (carry && (!needles || needles.some((n) => carry.includes(n)))) {
    try {
      out.push(JSON.parse(carry));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Last JSON line in a tail buffer that contains the needle. */
export function lastJsonInTail(tail, needle) {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes(needle)) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export function num(value) {
  return Number.isFinite(value) ? value : 0;
}

export function topModels(map, limit = 8) {
  return [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

export function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(value) || 0) * f) / f;
}
