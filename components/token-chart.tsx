import type { Daily, Provider } from "@/lib/types";
import { fmtTokens, shortDate } from "@/lib/format";

const SERIES: Record<string, string> = {
  codex: "var(--color-ink)",
  claude: "var(--color-warn)",
  commandcode: "var(--color-accent)",
  opencode: "var(--color-ok)",
  antigravity: "var(--color-crit)",
};

const W = 720;
const H = 150;
const TOP = 12;

function datesOf(providers: Provider[]) {
  const set = new Set<string>();
  for (const p of providers) for (const d of p.daily ?? []) set.add(d.date);
  return [...set].sort();
}

export function TokenChart({ providers, days = 30 }: { providers: Provider[]; days?: number }) {
  const active = providers.filter((p) => (p.daily?.length ?? 0) > 0);
  const dates = datesOf(active).slice(-days);

  if (dates.length < 2) {
    return (
      <p className="px-3 py-8 text-center text-[11px] text-ink-faint">
        Not enough daily history yet.
      </p>
    );
  }

  const lookup = active.map((p) => ({
    provider: p,
    byDate: new Map<string, number>((p.daily ?? []).map((d: Daily) => [d.date, d.tokens])),
  }));

  const stacked: number[][] = [];
  let running = new Array(dates.length).fill(0);
  for (const { byDate } of lookup) {
    const layer = dates.map((date) => byDate.get(date) ?? 0);
    running = running.map((v, i) => v + layer[i]);
    stacked.push(layer);
  }
  const peak = Math.max(...running, 1);

  const x = (i: number) => (i / (dates.length - 1)) * W;
  const y = (v: number) => H - (v / peak) * (H - TOP);

  let cumulative = new Array(dates.length).fill(0);
  const paths = stacked.map((layer, index) => {
    const bottom = cumulative;
    cumulative = cumulative.map((v, i) => v + layer[i]);
    const up = cumulative.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const down = bottom
      .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .reverse();
    return {
      id: lookup[index].provider.id,
      name: lookup[index].provider.name,
      color: SERIES[lookup[index].provider.id] ?? "var(--color-ink-dim)",
      d: `M${up.join(" L")} L${down.join(" L")} Z`,
    };
  });

  const ticks = [0.5, 1].map((f) => ({ v: peak * f, y: y(peak * f) }));
  const labelEvery = Math.ceil(dates.length / 6);

  return (
    <div className="px-3 py-3">
      <div className="mb-2 flex items-center gap-3 text-[10.5px] text-ink-dim">
        {paths.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className="size-[7px] rounded-[2px]" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        <span className="ml-auto tnum text-ink-faint">peak {fmtTokens(peak)}/day</span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[150px] w-full"
        role="img"
        aria-label={`Stacked daily tokens across ${paths.length} providers for the last ${dates.length} days`}
      >
        {ticks.map((t) => (
          <line
            key={t.v}
            x1="0"
            y1={t.y}
            x2={W}
            y2={t.y}
            stroke="var(--color-line-soft)"
            strokeWidth="1"
          />
        ))}
        <line x1="0" y1={H} x2={W} y2={H} stroke="var(--color-line)" strokeWidth="1" />
        {paths.map((s) => (
          <path key={s.id} d={s.d} fill={s.color} fillOpacity="0.72" />
        ))}
      </svg>

      <div className="tnum mt-1.5 flex justify-between text-[10px] text-ink-faint">
        {dates
          .map((d, i) => (i % labelEvery === 0 || i === dates.length - 1 ? shortDate(d) : null))
          .filter(Boolean)
          .map((label, i) => (
            <span key={`${label}-${i}`}>{label}</span>
          ))}
      </div>
    </div>
  );
}
