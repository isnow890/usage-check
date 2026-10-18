import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectQuota, parseQuota } from "../lib/collectors/opencode.mjs";

test("OpenCode uses used percentages and orders short, weekly, monthly windows", () => {
  const rows = parseQuota({ usage: {
    monthly: { percent: 40 },
    weekly: { percent: 20, resetsAt: "2026-10-20T00:00:00Z" },
    rolling: { percent: 0 },
  } });
  assert.deepEqual(rows.map((q) => [q.label, q.usedPercent, q.remainingPercent]), [
    ["5-hour limit", 0, 100], ["Weekly limit", 20, 80], ["Monthly limit", 40, 60],
  ]);
  assert.equal(rows[1].resetsAt, "2026-10-20T00:00:00.000Z");
});

test("OpenCode malformed usage never becomes a false zero", () => {
  for (const percent of [null, undefined, "", " ", "unknown", false, [], {}]) {
    assert.deepEqual(parseQuota({ usage: { rolling: { percent } } }), []);
  }
  assert.deepEqual(parseQuota({}), []);
});

test("OpenCode reads CLI key directly, caches calls, and detects replacement keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "usage-check-opencode-"));
  const authPath = path.join(dir, "auth.json");
  const oldEnv = [process.env.OPENCODE_API_KEY, process.env.OPENCODE_GO_API_KEY];
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  try {
    let calls = 0;
    await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api", key: "test-expired-key" } }));
    const failed = await collectQuota({ authPath, now: 100_000, fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer test-expired-key");
      return new Response(JSON.stringify({ error: { code: "api_key_expired", message: "test-expired-key" } }), { status: 401 });
    } });
    assert.equal(failed.quotaStatus, "unavailable");
    assert.match(failed.quotaMessage, /key expired/);
    assert.equal(JSON.stringify(failed).includes("test-expired-key"), false);
    assert.equal(failed.status, undefined);
    await collectQuota({ authPath, now: 100_001, fetchImpl: () => { throw new Error("cache missed"); } });
    assert.equal(calls, 1);

    await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api", key: "test-replacement-key" } }));
    const success = await collectQuota({ authPath, now: 100_002, fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer test-replacement-key");
      return new Response(JSON.stringify({ usage: { rolling: { percent: 2.6 }, weekly: { percent: 21 } } }));
    } });
    assert.equal(success.quotaStatus, "ok");
    assert.deepEqual(success.quota.map((q) => q.usedPercent), [2.6, 21]);

    await writeFile(authPath, JSON.stringify({
      opencode: { type: "api", key: "test-current-cli-key" },
      "opencode-go": { type: "api", key: "test-expired-go-key" },
    }));
    const current = await collectQuota({ authPath, now: 100_003, fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer test-current-cli-key");
      return new Response(JSON.stringify({ usage: { weekly: { percent: 100 }, monthly: { percent: 50 } } }));
    } });
    assert.equal(current.quotaStatus, "ok");
    assert.deepEqual(current.quota.map(q => q.usedPercent), [100, 50]);

    await writeFile(authPath, JSON.stringify({
      opencode: { type: "api", key: "test-expired-current-key" },
      "opencode-go": { type: "api", key: "test-valid-go-key" },
    }));
    const tried = [];
    const fallback = await collectQuota({ authPath, now: 100_004, fetchImpl: async (_url, options) => {
      tried.push(options.headers.Authorization);
      return options.headers.Authorization === "Bearer test-expired-current-key"
        ? new Response(JSON.stringify({ error: { code: "api_key_expired" } }), { status: 401 })
        : new Response(JSON.stringify({ usage: { weekly: { percent: 21 } } }));
    } });
    assert.equal(fallback.quotaStatus, "ok");
    assert.deepEqual(tried, ["Bearer test-expired-current-key", "Bearer test-valid-go-key"]);

    const missing = await collectQuota({ authPath: path.join(dir, "missing.json"), now: 100_005,
      fetchImpl: () => { throw new Error("must not call without a key"); } });
    assert.equal(missing.quotaStatus, "unavailable");
    assert.match(missing.quotaMessage, /No OpenCode Go API key/);
  } finally {
    for (const [i, name] of ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"].entries()) {
      if (oldEnv[i] == null) delete process.env[name]; else process.env[name] = oldEnv[i];
    }
    await rm(dir, { recursive: true, force: true });
  }
});
