import * as antigravity from "./collectors/antigravity.mjs";
import * as claude from "./collectors/claude.mjs";
import * as codex from "./collectors/codex.mjs";
import * as commandcode from "./collectors/commandcode.mjs";
import * as opencode from "./collectors/opencode.mjs";
import * as routerQuota from "./collectors/router-quota.mjs";
import { round } from "./util.mjs";

const COLLECTORS = [
  ["codex", codex],
  ["claude", claude],
  ["antigravity", antigravity],
  ["commandcode", commandcode],
  ["opencode", opencode],
];

function summarise(providers) {
  const totals = { today: 0, last7: 0, window: 0, requests: 0 };
  let alerts = 0;
  for (const p of providers) {
    totals.today += p.usage?.today?.tokens ?? 0;
    totals.last7 += p.usage?.last7?.tokens ?? 0;
    totals.window += p.usage?.window?.tokens ?? 0;
    totals.requests += p.usage?.requests ?? p.usage?.window?.requests ?? 0;
    for (const q of p.quota ?? []) {
      if (q.usedPercent >= 85) alerts += 1;
    }
  }
  return { ...totals, alerts };
}

export async function buildSnapshot({ days = 60 } = {}) {
  const started = Date.now();
  const errors = [];

  const [collected, quota] = await Promise.all([
    Promise.all(
      COLLECTORS.map(async ([id, mod]) => {
        try {
          return await mod.collect({ days });
        } catch (error) {
          errors.push({ collector: id, message: error.message });
          return null;
        }
      }),
    ),
    routerQuota.collect().catch((error) => ({ providers: {}, reason: error.message })),
  ]);

  const providers = collected.filter(Boolean);

  for (const provider of providers) {
    const routerId = Object.entries(routerQuota.ROUTER_TO_PROVIDER).find(([, v]) => v === provider.id)?.[0];
    const account = routerId ? quota.providers?.[routerId] : null;
    if (!account) continue;

    const metrics = account.metrics ?? [];
    const quotaMetrics = metrics.filter((m) => m.kind === "quota");
    const balanceMetric = metrics.find((m) => m.kind === "balance");

    // Command Code meters spend against per-window caps plus a credit pool, and
    // the app's third "monthly" bar is that pool. The API exposes no monthly
    // window, so the cycle-to-date spend is approximated by the largest window
    // counter still running: a shorter window can reset mid-month, and the
    // month cannot have spent less than its longest live window.
    if (provider.id === "commandcode" && balanceMetric) {
      const counters = quotaMetrics.map((m) => m.used).filter((v) => Number.isFinite(v));
      const spend = counters.length ? Math.max(...counters) : NaN;
      const cap = spend + balanceMetric.value;
      if (Number.isFinite(spend) && cap > 0) {
        const percent = (spend / cap) * 100;
        quotaMetrics.push({
          kind: "quota",
          label: "Monthly limit",
          usedPercent: percent,
          remainingPercent: 100 - percent,
          used: spend,
          limit: cap,
          unit: "credits",
          resetAt: null,
          derived: true,
        });
        provider.notes = [
          ...(provider.notes ?? []),
          "The monthly bar is derived: the billing API exposes only 5-hour and weekly windows, so cycle spend is taken from the longest running counter against the credit pool.",
        ];
      }
    }

    if (quotaMetrics.length) {
      provider.quota = quotaMetrics.map((m) => ({
        label: m.label,
        usedPercent: round(m.usedPercent, 2),
        remainingPercent: round(m.remainingPercent, 2),
        resetsAt: m.resetAt ?? null,
        detail: m.limit != null ? `${round(m.used, 2)} / ${round(m.limit, 2)} ${m.unit ?? ""}`.trim() : null,
        live: true,
      }));
    }
    if (balanceMetric) {
      provider.balance = {
        label: balanceMetric.label,
        value: round(balanceMetric.value, 2),
        currency: balanceMetric.currency ?? "USD",
        detail: balanceMetric.detail ?? null,
        live: true,
      };
    }
    if (account.plan) provider.plan = account.plan;
    provider.sources = [...(provider.sources ?? []), "codex-router:official-api"];
  }

  const order = ["codex", "claude", "antigravity", "commandcode", "opencode"];
  providers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    days,
    totals: summarise(providers),
    providers,
    errors,
    warnings: quota.reason ? [`router quota unavailable: ${quota.reason}`] : [],
  };
}
