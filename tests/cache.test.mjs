import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

test("concurrent snapshots in the same process can save a shared cache", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "usage-check-cache-"));
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { readFile } from 'node:fs/promises';
      const { FileCache } = await import(${JSON.stringify(new URL("../lib/cache.mjs", import.meta.url).href)});
      const writers = Array.from({ length: 12 }, () => new FileCache('shared'));
      for (const cache of writers) cache.set('session', { size: 1, mtimeMs: 1 }, { tokens: 42 });
      await Promise.all(writers.map(cache => cache.save()));
      console.log(await readFile(writers[0].file, 'utf8'));
    `], { encoding: "utf8", env: { ...process.env, USAGE_CHECK_DATA_DIR: dir } });
    assert.equal(JSON.parse(output).files.session.value.tokens, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
