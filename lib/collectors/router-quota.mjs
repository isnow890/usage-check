import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { HOME } from "../util.mjs";

const run = promisify(execFile);

const ROUTER_DIR = process.env.USAGE_CHECK_ROUTER_DIR || path.join(HOME, ".local", "share", "codex-router");
const CONTROL = path.join(ROUTER_DIR, "src", "control.mjs");
const TTL_MS = 60_000;

let memo = { at: 0, value: null };

/**
 * The local router already resolves vendor billing endpoints and normalises
 * their windows, so this reuses that instead of re-implementing each vendor
 * credential dance. It hits the network, so results are memoised briefly.
 */
async function load() {
  if (memo.value && Date.now() - memo.at < TTL_MS) return memo.value;
  if (!existsSync(CONTROL)) return { providers: {}, reason: "codex-router not installed" };
  try {
    const { stdout } = await run("node", [CONTROL, "provider-usage", "--json"], {
      cwd: ROUTER_DIR,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 45_000,
    });
    const parsed = JSON.parse(stdout);
    const providers = {};
    for (const entry of parsed.providers ?? []) {
      const account = entry.account;
      if (!account || account.status !== "available") continue;
      providers[entry.id] = account;
    }
    memo = { at: Date.now(), value: { providers, fetchedAt: parsed.fetchedAt } };
    return memo.value;
  } catch (error) {
    memo = { at: Date.now(), value: { providers: {}, reason: error.message } };
    return memo.value;
  }
}

export async function collect() {
  return load();
}

/** Router provider ids mapped onto the ids this dashboard uses. */
export const ROUTER_TO_PROVIDER = {
  commandcode: "commandcode",
  "opencode-go": "opencode",
  openai: "codex",
};
