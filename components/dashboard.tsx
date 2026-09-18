"use client";

import { useEffect, useState } from "react";
import * as Separator from "@radix-ui/react-separator";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ChevronDown, RefreshCw } from "lucide-react";

import { DragGrip } from "@/components/drag-grip";
import { ModelTable } from "@/components/model-table";
import { ProviderCard } from "@/components/provider-card";
import { SortableGrid } from "@/components/sortable-grid";
import { TokenChart } from "@/components/token-chart";
import { fmtInt, fmtTokens } from "@/lib/format";
import type { DragHandleProps, Provider, Snapshot } from "@/lib/types";
import { cn } from "@/lib/cn";

const RANGES = [
  { value: "1", label: "1d" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "60", label: "60d" },
];

/**
 * The summary is one draggable block, not four. The four figures travel
 * together so the whole panel can be swapped with a provider card.
 */
const SUMMARY_ID = "__summary";
const PREFS_KEY = "usage-check:prefs";

type StatDef = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  short?: string;
  tone?: string;
};

type Prefs = {
  order: string[] | null;
  summaryOpen: boolean;
};

type GridItem = { id: string; provider?: Provider };

function SummaryCard({
  stats,
  open,
  onToggle,
  dragHandle,
}: {
  stats: StatDef[];
  open: boolean;
  onToggle: () => void;
  dragHandle: DragHandleProps;
}) {
  const brief = stats
    .filter((stat) => stat.short)
    .map((stat) => `${stat.value} ${stat.short}`)
    .join(" · ");

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <span className="size-[7px] shrink-0 rounded-[2px] bg-ink-dim" />
        <h3 className="text-[12.5px] font-medium">Summary</h3>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls="summary-body"
            aria-label={open ? "Collapse summary" : "Expand summary"}
            className="grid size-5 shrink-0 place-items-center rounded text-ink-faint hover:text-ink"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
          </button>
          <DragGrip handle={dragHandle} label="Summary" />
        </div>
      </header>

      <div id="summary-body" className="px-3 py-3">
        {open ? (
          <div className="grid grid-cols-2 gap-2.5">
            {stats.map((stat) => (
              <div key={stat.id}>
                <p className="text-[10.5px] text-ink-faint">{stat.label}</p>
                <p className={cn("tnum mt-px text-[19px] font-medium", stat.tone)}>{stat.value}</p>
                {stat.sub ? <p className="text-[11px] text-ink-dim">{stat.sub}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="tnum text-[11px] text-ink-dim">{brief}</p>
        )}
      </div>
    </article>
  );
}

export function Dashboard({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [range, setRange] = useState("30");
  const [prefs, setPrefs] = useState<Prefs>(() => ({
    order: null,
    summaryOpen: true,
  }));
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [ageSeconds, setAgeSeconds] = useState(0);

  /**
   * Layout preferences live on the server so the Mac and the iPad agree.
   * localStorage only paints instantly while the file is being read.
   */
  useEffect(() => {
    let cancelled = false;
    let local: Partial<Prefs> | null = null;
    try {
      local = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    } catch {
      local = null;
    }
    if (local) setPrefs((prev) => ({ ...prev, ...local }));

    fetch("/api/prefs", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((server: Partial<Prefs> | null) => {
        if (cancelled || !server) return;
        setPrefs((prev) => ({
          order: server.order ?? prev.order,
          summaryOpen: server.summaryOpen ?? prev.summaryOpen,
        }));
        // A server that has never been configured adopts this browser's order.
        if (!server.order && local?.order) {
          void fetch("/api/prefs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ order: local.order }),
          }).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePrefs = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* private mode or a full quota; the server write still applies */
    }
    void fetch("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  };

  useEffect(() => {
    setMounted(true);
    const id = setInterval(() => {
      const at = Date.parse(snapshot.generatedAt);
      setAgeSeconds(Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : 0);
    }, 1000);
    return () => clearInterval(id);
  }, [snapshot.generatedAt]);

  const refresh = async (announce = false) => {
    if (announce) setBusy(true);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (response.ok) setSnapshot((await response.json()) as Snapshot);
    } catch {
      /* a failed poll keeps the last good snapshot on screen */
    } finally {
      if (announce) setBusy(false);
    }
  };

  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { totals, providers } = snapshot;
  const stats: StatDef[] = [
    {
      id: "today",
      label: "Tokens today",
      value: fmtTokens(totals.today),
      sub: `${fmtInt(totals.requests)} requests`,
      short: "today",
    },
    {
      id: "last7",
      label: "Tokens · 7 days",
      value: fmtTokens(totals.last7),
      sub: `${providers.length} providers`,
      short: "/ 7d",
    },
    {
      id: "window",
      label: `Tokens · ${snapshot.days} days`,
      value: fmtTokens(totals.window),
      sub: `built in ${snapshot.tookMs}ms`,
    },
    {
      id: "alerts",
      label: "Quota alerts",
      value: String(totals.alerts),
      sub: totals.alerts ? "at or above 85%" : "all clear",
      short: totals.alerts ? "alert" : undefined,
      tone: totals.alerts ? "text-crit" : undefined,
    },
  ];
  const modelRows = providers.flatMap((p) =>
    (p.models ?? []).map((m) => ({ ...m, providerName: p.name })),
  );
  const sources = [...new Set(providers.flatMap((p) => p.sources ?? []))];
  const stale = ageSeconds > 120;

  const items: GridItem[] = [
    { id: SUMMARY_ID },
    ...providers.map((provider) => ({ id: provider.id, provider })),
  ];
  const defaultOrder = items.map((item) => item.id);
  // A saved order from before the summary joined this grid would push it to the
  // end, so a missing summary is placed first rather than silently relocated.
  const savedOrder = prefs.order ?? defaultOrder;
  const order = savedOrder.includes(SUMMARY_ID)
    ? savedOrder
    : [SUMMARY_ID, ...savedOrder];

  return (
    <Tooltip.Provider delayDuration={150}>
      <div className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col gap-3 px-4 py-4">
        <header className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-chrome px-3.5 py-3">
          <div className="mr-auto flex items-center gap-2.5">
            <span className="grid size-6 place-items-center rounded-md bg-accent text-[13px] font-medium text-bg">
              U
            </span>
            <div>
              <h1 className="text-[14px] font-medium leading-tight">Usage Check</h1>
              <p className="text-[11px] text-ink-faint">
                {providers.map((p) => p.name).join(" · ")}
              </p>
            </div>
          </div>

          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px]",
                  stale ? "text-warn" : "text-ink-dim",
                )}
              >
                <span className={cn("size-1.5 rounded-full", stale ? "bg-warn" : "bg-ok")} />
                <span suppressHydrationWarning>
                  {mounted
                    ? ageSeconds < 60
                      ? `${ageSeconds}s ago`
                      : `${Math.floor(ageSeconds / 60)}m ago`
                    : "—"}
                </span>
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={6}
                className="z-50 max-w-[320px] rounded-md border border-line bg-raised px-2.5 py-2 text-[11px] text-ink-dim shadow-lg"
              >
                Built {new Date(snapshot.generatedAt).toLocaleString("ko-KR")} in {snapshot.tookMs}ms.
                Polls every 30s.
                <Tooltip.Arrow className="fill-[var(--color-raised)]" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>

          <ToggleGroup.Root
            type="single"
            value={range}
            onValueChange={(v) => v && setRange(v)}
            className="inline-flex gap-0.5 rounded-md border border-line bg-surface p-0.5"
            aria-label="Chart range"
          >
            {RANGES.map((r) => (
              <ToggleGroup.Item
                key={r.value}
                value={r.value}
                className="rounded-[5px] px-2.5 py-[3px] text-[11.5px] text-ink-dim data-[state=on]:bg-ink data-[state=on]:text-bg"
              >
                {r.label}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>

          <button
            type="button"
            onClick={() => void refresh(true)}
            aria-label="Refresh now"
            className="grid size-7 place-items-center rounded-md border border-line bg-surface text-ink-dim hover:text-ink"
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
          </button>
        </header>

        <SortableGrid
          items={items}
          order={order}
          onOrderChange={(next) => updatePrefs({ order: next })}
          className="grid gap-2.5 md:grid-cols-2 lg:grid-cols-3"
          render={(item, handle) =>
            item.provider ? (
              <ProviderCard provider={item.provider} dragHandle={handle} />
            ) : (
              <SummaryCard
                stats={stats}
                open={prefs.summaryOpen}
                onToggle={() => updatePrefs({ summaryOpen: !prefs.summaryOpen })}
                dragHandle={handle}
              />
            )
          }
        />

        {snapshot.warnings.length || snapshot.errors.length ? (
          <section className="grid gap-1 rounded-lg border border-line bg-surface px-3 py-2.5">
            {snapshot.warnings.map((w) => (
              <p key={w} className="text-[11px] text-warn">
                {w}
              </p>
            ))}
            {snapshot.errors.map((e) => (
              <p key={e.collector} className="text-[11px] text-crit">
                {e.collector}: {e.message}
              </p>
            ))}
          </section>
        ) : null}

        <Separator.Root className="h-px w-full bg-line" />

        <section className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line-soft px-3 py-2.5">
            <h2 className="text-[12.5px] font-medium">Tokens per day</h2>
          </div>
          <TokenChart providers={providers} days={Number(range)} />
        </section>

        <section className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center border-b border-line-soft px-3 py-2.5">
            <h2 className="text-[12.5px] font-medium">By model</h2>
            <span className="ml-auto text-[10px] text-ink-faint">sorted by tokens</span>
          </div>
          <ModelTable rows={modelRows} />
        </section>

        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-[10.5px] text-ink-faint">
          <span>local read {snapshot.tookMs}ms · nothing leaves this machine</span>
          {sources.length ? <span>sources: {sources.join(", ")}</span> : null}
        </footer>
      </div>
    </Tooltip.Provider>
  );
}
