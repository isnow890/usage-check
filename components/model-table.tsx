import type { ModelRow } from "@/lib/types";
import { fmtInt, fmtTokens } from "@/lib/format";

const COLOR: Record<string, string> = {
  Codex: "var(--color-ink)",
  Claude: "var(--color-warn)",
  CommandCode: "var(--color-accent)",
  OpenCode: "var(--color-ok)",
  Antigravity: "var(--color-crit)",
};

type Row = ModelRow & { providerName: string };

export function ModelTable({ rows }: { rows: Row[] }) {
  const total = rows.reduce((sum, r) => sum + r.tokens, 0) || 1;
  const top = [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, 14);

  if (!top.length) {
    return <p className="px-3 py-8 text-center text-[11px] text-ink-faint">No model rows yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11.5px]">
        <thead>
          <tr className="text-[10.5px] text-ink-faint">
            <th className="border-b border-line px-3 py-2 text-left font-normal">Provider</th>
            <th className="border-b border-line px-3 py-2 text-left font-normal">Model</th>
            {/* Requests and Share drop out on narrow screens so Tokens never clips. */}
            <th className="hidden border-b border-line px-3 py-2 text-right font-normal sm:table-cell">
              Requests
            </th>
            <th className="border-b border-line px-3 py-2 text-right font-normal">Tokens</th>
            <th className="hidden border-b border-line px-3 py-2 text-right font-normal md:table-cell">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {top.map((r) => (
            <tr key={`${r.providerName}-${r.name}`} className="border-b border-line-soft last:border-0">
              <td className="px-3 py-1.5 text-ink-dim">{r.providerName}</td>
              <td className="px-3 py-1.5">
                <span
                  className="mr-1.5 inline-block size-[7px] rounded-[2px] align-middle"
                  style={{ background: COLOR[r.providerName] ?? "var(--color-ink-dim)" }}
                />
                {r.name}
              </td>
              <td className="tnum hidden px-3 py-1.5 text-right sm:table-cell">
                {fmtInt(r.requests)}
              </td>
              <td className="tnum px-3 py-1.5 text-right">{fmtTokens(r.tokens)}</td>
              <td className="tnum hidden px-3 py-1.5 text-right text-ink-dim md:table-cell">
                {((r.tokens / total) * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
