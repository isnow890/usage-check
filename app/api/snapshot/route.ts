import { buildSnapshot } from "@/lib/snapshot.mjs";
import { inspectExposure } from "@/lib/network.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The port the client actually reached us on, so no port config is duplicated. */
function portFromHost(host: string | null) {
  const match = host?.match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

export async function GET(request: Request) {
  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 365) : 60;

  try {
    const snapshot = await buildSnapshot({ days });

    // A failed probe must not take the dashboard down with it.
    const port = portFromHost(request.headers.get("host"));
    let network = null;
    if (port) {
      try {
        network = await inspectExposure({ port });
      } catch {
        network = null;
      }
    }

    return Response.json({ ...snapshot, network }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "snapshot failed" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
