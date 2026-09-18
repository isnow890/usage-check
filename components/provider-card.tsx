import { fmtInt, fmtTokens, fmtUSD, relTime } from "@/lib/format";
import type { DragHandleProps, Provider } from "@/lib/types";
import { cn } from "@/lib/cn";
import { DragGrip } from "./drag-grip";
import { QuotaBar } from "./quota-bar";

const DOT: Record<string, string> = {
  codex: "bg-ink",
  claude: "bg-warn",
  antigravity: "bg-accent",
  commandcode: "bg-accent",
  opencode: "bg-ok",
};

function Row({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="text-ink-faint">{k}</span>
      <span className={cn("ml-auto", mono && "tnum")}>{v}</span>
    </div>
  );
}

export function ProviderCard({
  provider,
  dragHandle,
}: {
  provider: Provider;
  dragHandle?: DragHandleProps;
}) {
  const usage = provider.usage;
  const lastUsed = relTime(usage?.lastUsedAt);
  const sampled = relTime(provider.sampledAt);
  const isStale = provider.status === "stale";
  const isUnavailable = provider.status === "unavailable";
  const isUnverified = provider.status === "unverified";

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <span className={cn("size-[7px] shrink-0 rounded-[2px]", DOT[provider.id] ?? "bg-ink-dim")} />
        <h3 className="text-[12.5px] font-medium">{provider.name}</h3>
        {provider.plan ? (
          <span className="rounded border border-line px-1.5 py-px text-[10px] text-ink-dim">
            {provider.plan}
          </span>
        ) : null}
        {isStale ? (
          <span className="rounded border border-line px-1.5 py-px text-[10px] text-warn">stale</span>
        ) : null}
        {isUnverified ? (
          <span className="rounded border border-line px-1.5 py-px text-[10px] text-warn">
            unverified
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-ink-faint">{provider.subtitle}</span>
        {dragHandle ? (
          <DragGrip handle={dragHandle} label={provider.name} />
        ) : null}
      </header>

      <div className="grid gap-2.5 px-3 py-3">
        {isUnverified ? (
          <p className="text-[11px] text-warn">{provider.message}</p>
        ) : null}

        {provider.quota.map((q) => (
          <QuotaBar key={`${provider.id}-${q.label}`} quota={q} />
        ))}

        {isStale && provider.lastKnown?.length ? (
          <div className="grid gap-1.5">
            <p className="text-[10.5px] text-warn">
              Last known{sampled ? ` · ${sampled}` : ""} — not current
            </p>
            {provider.lastKnown.map((k) => (
              <div key={k.label} className="flex items-baseline gap-2 text-[11px]">
                <span className="text-ink-dim">{k.label}</span>
                <span className="tnum ml-auto text-ink-dim">{k.usedPercent.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        ) : null}

        {isUnavailable && !provider.quota.length && !isStale ? (
          <p className="text-[11px] text-ink-dim">
            {provider.message ?? "No quota source on this machine."}
          </p>
        ) : null}

        {provider.balance ? (
          <Row k={provider.balance.label} v={fmtUSD(provider.balance.value)} />
        ) : null}

        {usage ? (
          <>
            <Row k="Today" v={fmtTokens(usage.today?.tokens)} />
            <Row k="7 days" v={fmtTokens(usage.last7?.tokens)} />
            {usage.sessions != null ? <Row k="Sessions" v={fmtInt(usage.sessions)} /> : null}
            {usage.requests != null ? <Row k="Requests" v={fmtInt(usage.requests)} /> : null}
            {usage.medianFirstTokenMs != null ? (
              <Row k="First token" v={`${fmtInt(usage.medianFirstTokenMs)}ms`} />
            ) : null}
            {lastUsed ? <Row k="Last used" v={lastUsed} mono={false} /> : null}
          </>
        ) : null}

        {!provider.quota.length && !usage && !provider.balance && !isStale && !isUnavailable ? (
          <p className="text-[11px] text-ink-faint">No metrics collected.</p>
        ) : null}
      </div>
    </article>
  );
}
