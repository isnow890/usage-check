import { promises as fs } from "node:fs";
import path from "node:path";

import { HOME } from "./util.mjs";

const DATA_DIR = process.env.USAGE_CHECK_DATA_DIR || path.join(HOME, ".usage-check");
// Bumped whenever a collector's parsed shape changes, so stale entries from an
// older parser are re-read instead of being served from the memo.
const VERSION = 3;

/**
 * Per-file parse memo. Session logs only ever grow, so an unchanged
 * (mtimeMs, size) pair means the parsed value is still valid.
 */
export class FileCache {
  constructor(name) {
    this.name = name;
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.files = new Map();
    this.dirty = false;
    this.hits = 0;
    this.misses = 0;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (raw?.version !== VERSION || typeof raw.files !== "object") return this;
      for (const [key, entry] of Object.entries(raw.files)) this.files.set(key, entry);
    } catch {
      /* a cold or corrupt cache just costs one full pass */
    }
    return this;
  }

  get(file, stat) {
    const entry = this.files.get(file);
    if (!entry) return undefined;
    if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) return undefined;
    this.hits += 1;
    return entry.value;
  }

  set(file, stat, value) {
    this.misses += 1;
    this.files.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    this.dirty = true;
    return value;
  }

  prune(knownPaths) {
    for (const key of [...this.files.keys()]) {
      if (knownPaths.has(key)) continue;
      this.files.delete(key);
      this.dirty = true;
    }
  }

  async save() {
    if (!this.dirty) return;
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload = { version: VERSION, files: Object.fromEntries(this.files) };
    const temporary = `${this.file}.tmp.${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(payload), "utf8");
    await fs.rename(temporary, this.file);
  }
}

export { DATA_DIR };
