import { Dashboard } from "@/components/dashboard";
import { buildSnapshot } from "@/lib/snapshot.mjs";
import type { Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = (await buildSnapshot({ days: 60 })) as Snapshot;
  return <Dashboard initial={snapshot} />;
}
