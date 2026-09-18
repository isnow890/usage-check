import { buildSnapshot } from "@/lib/snapshot.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 365) : 60;

  try {
    const snapshot = await buildSnapshot({ days });
    return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "snapshot failed" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
