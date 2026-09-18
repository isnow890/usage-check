#!/usr/bin/env node
import { buildSnapshot } from "../lib/snapshot.mjs";

const days = Number(process.env.USAGE_CHECK_DAYS || 60);
const snapshot = await buildSnapshot({ days });

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else {
  console.log(`snapshot in ${snapshot.tookMs}ms · ${snapshot.providers.length} providers`);
  if (snapshot.warnings.length) console.log("warnings:", snapshot.warnings.join("; "));
  if (snapshot.errors.length) console.log("errors:", JSON.stringify(snapshot.errors));
  for (const p of snapshot.providers) {
    const t = p.usage?.today?.tokens ?? 0;
    const w = p.usage?.window?.tokens ?? 0;
    console.log(`\n${p.name.padEnd(13)} ${String(p.kind).padEnd(13)} today=${fmt(t)} window=${fmt(w)}`);
    for (const q of p.quota ?? []) {
      console.log(`   quota   ${q.label.padEnd(14)} ${String(q.usedPercent).padStart(6)}%  ${q.detail ?? ""}`);
    }
    if (p.balance) console.log(`   balance ${p.balance.label} ${p.balance.value} ${p.balance.currency}`);
    for (const m of (p.models ?? []).slice(0, 3)) {
      console.log(`   model   ${String(m.name).padEnd(30)} ${fmt(m.tokens)}`);
    }
  }
}

function fmt(n) {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
