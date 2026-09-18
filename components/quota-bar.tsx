import * as Progress from "@radix-ui/react-progress";

import type { Quota } from "@/lib/types";
import { cn } from "@/lib/cn";

function tone(used: number) {
  if (used >= 85) return "bg-crit";
  if (used >= 65) return "bg-warn";
  return "bg-accent";
}

export function countdown(resetsAt?: string | null) {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const ms = at - Date.now();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function QuotaBar({ quota, showTrack = true }: { quota: Quota; showTrack?: boolean }) {
  const used = Math.max(0, Math.min(100, quota.usedPercent));
  const eta = countdown(quota.resetsAt);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="text-ink-dim">{quota.label}</span>
        <span className={cn("ml-auto tnum", used >= 85 ? "text-crit" : "text-ink")}>
          {used.toFixed(used < 10 ? 1 : 0)}%
        </span>
        {eta ? (
          <span suppressHydrationWarning className="tnum text-[10px] text-ink-faint">
            {eta}
          </span>
        ) : null}
      </div>
      {showTrack ? (
        <Progress.Root
          value={used}
          aria-label={`${quota.label} used`}
          className="h-[5px] w-full overflow-hidden rounded-full bg-raised"
        >
          <Progress.Indicator
            className={cn("h-full rounded-full transition-[width] duration-500", tone(used))}
            style={{ width: `${used}%` }}
          />
        </Progress.Root>
      ) : null}
      {quota.detail ? <p className="text-[10px] text-ink-faint">{quota.detail}</p> : null}
    </div>
  );
}
