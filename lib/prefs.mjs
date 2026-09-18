import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./cache.mjs";

const FILE = path.join(DATA_DIR, "prefs.json");

/**
 * Layout preferences are stored on this machine rather than in browser storage
 * so the Mac and the iPad show the same arrangement. localStorage is only a
 * cache in front of this file.
 */
const DEFAULTS = {
  order: null,
  summaryOpen: true,
};

function idList(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === "string") : null;
}

function normalize(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    order: idList(value.order),
    summaryOpen: value.summaryOpen !== false,
  };
}

export async function readPrefs() {
  try {
    return normalize(JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writePrefs(patch) {
  const current = await readPrefs();
  const next = normalize({ ...current, ...(patch ?? {}) });
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temporary = `${FILE}.tmp.${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, FILE);
  } catch {
    /* a failed write only costs the preference; the dashboard still renders */
  }
  return next;
}
