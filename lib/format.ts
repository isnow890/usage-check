export function fmtTokens(n?: number | null) {
  if (!n) return "0";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtInt(n?: number | null) {
  return (n ?? 0).toLocaleString("en-US");
}

export function fmtUSD(n?: number | null) {
  return `$${(n ?? 0).toFixed(2)}`;
}

export function relTime(iso?: string | null) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function shortDate(date: string) {
  const parts = date.split("-");
  return `${parts[1]}/${parts[2]}`;
}

export function basename(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts.at(-1) ?? p;
}
