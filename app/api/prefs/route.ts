import { readPrefs, writePrefs } from "@/lib/prefs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readPrefs(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let patch;
  try {
    patch = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  return Response.json(await writePrefs(patch), { headers: { "cache-control": "no-store" } });
}
