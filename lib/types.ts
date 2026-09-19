import type { useSortable } from "@dnd-kit/sortable";

/** The drag grip's wiring, derived from the hook so it survives dnd-kit updates. */
export type DragHandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

export type Quota = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: string | null;
  detail?: string | null;
  severity?: string | null;
  live?: boolean;
};

export type WindowTotals = { tokens: number; requests: number };

export type Usage = {
  today: WindowTotals;
  last7: WindowTotals;
  window: WindowTotals;
  requests?: number;
  sessions?: number;
  files?: number;
  failures?: number;
  medianFirstTokenMs?: number | null;
  lastUsedAt?: string | null;
};

export type Daily = { date: string; tokens: number; requests: number };

export type ModelRow = {
  name: string;
  tokens: number;
  requests: number;
  provider?: string | null;
  cost?: number;
  output?: number;
  reasoning?: number;
};

export type Balance = {
  label: string;
  value: number;
  currency: string;
  detail?: string | null;
  live?: boolean;
};

export type Provider = {
  id: string;
  name: string;
  subtitle: string;
  kind: "subscription" | "metered";
  status?: "ok" | "stale" | "unavailable" | "unverified";
  message?: string;
  sampledAt?: string;
  lastKnown?: { label: string; usedPercent: number }[];
  plan: string | null;
  account: string | null;
  quota: Quota[];
  balance: Balance | null;
  usage: Usage | null;
  daily: Daily[];
  models: ModelRow[];
  projects?: { name: string; tokens: number; requests: number }[];
  series?: { id: string; label: string; points: { t: number; usedPercent: number }[] }[];
  notes: string[];
  sources?: string[];
  cache?: { hits: number; misses: number };
};

export type Snapshot = {
  generatedAt: string;
  tookMs: number;
  days: number;
  totals: { today: number; last7: number; window: number; requests: number; alerts: number };
  providers: Provider[];
  errors: { collector: string; message: string }[];
  warnings: string[];
  network?: NetworkExposure | null;
};

/**
 * `kind` is inferred from the address range, not from an interface lookup.
 * `reachable` is measured by opening a TCP connection to our own port on each
 * address, so it says what answers, not what a remote peer is allowed to do.
 */
export type NetworkAddress = {
  name: string;
  address: string;
  kind: "lan" | "tailnet" | "loopback" | "other";
};

export type NetworkExposure = {
  method: "self-probe";
  port: number;
  addresses: NetworkAddress[];
  reachable: NetworkAddress[];
};
