import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseQuotaSummary } from "../lib/collectors/antigravity.mjs";

test("keeps Argon separate and orders 5-hour before weekly", () => {
  const quota = parseQuotaSummary({ response: { groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.33 },
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.98 },
    ] },
    { displayName: "Gemini 4 Argon", buckets: [
      { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0 },
    ] },
  ] } });
  assert.deepEqual(quota.map(q => q.label), ["Gemini · 5-hour", "Gemini · Weekly", "Gemini 4 Argon · Weekly"]);
  assert.deepEqual(quota.map(q => Math.round(q.usedPercent)), [2, 67, 100]);
  assert.equal(new Set(quota.map(q => q.id)).size, 3);
});

test("accepts protobuf omitted zero but does not invent missing buckets", () => {
  assert.equal(parseQuotaSummary({ groups: [] }).length, 0);
  const quota = parseQuotaSummary({ groups: [{ displayName: "Gemini 4 Argon", buckets: [
    { bucketId: "argon-weekly", window: "weekly" },
    { bucketId: "invalid", window: "weekly", remainingFraction: "unknown" },
    { bucketId: "null", window: "weekly", remainingFraction: null },
  ] }] });
  assert.equal(quota.length, 1);
  assert.equal(quota[0].usedPercent, 100);
});

test("app unavailable shows last known limits as stale, without a live OAuth fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "usage-check-agy-"));
  try {
    await writeFile(path.join(dir, "antigravity-app-quota.json"), JSON.stringify({
      sampledAt: "2026-10-18T12:00:00Z", plan: "Google AI Pro",
      quota: [{ label: "Gemini 4 Argon · Weekly", usedPercent: 100 }],
    }));
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const {collect} = await import(${JSON.stringify(new URL("../lib/collectors/antigravity.mjs", import.meta.url).href)}); console.log(JSON.stringify(await collect()));`,
    ], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent", USAGE_CHECK_DATA_DIR: dir } });
    const result = JSON.parse(output);
    assert.equal(result.status, "stale");
    assert.equal(result.sampledAt, "2026-10-18T12:00:00Z");
    assert.deepEqual(result.quota, []);
    assert.equal(result.lastKnown[0].usedPercent, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
