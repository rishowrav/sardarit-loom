import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import RecorderStudio from "@/components/RecorderStudio";
import { getServerEnv, isLocalDemoMode } from "@/lib/env";
import { localUsage } from "@/lib/local-store";
import { getOwnerContext } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Record" };

export default async function RecordPage() {
  if (isLocalDemoMode()) {
    const usage = await localUsage();
    return (
      <AppShell email="Local development" localDemo usage={{ usedBytes: usage.usedBytes, limitBytes: usage.limitBytes }}>
        <RecorderStudio />
      </AppShell>
    );
  }

  const ctx = await getOwnerContext();
  if (!ctx) redirect("/login");

  const env = getServerEnv();
  const { data } = await ctx.supabase
    .from("recordings")
    .select("size_bytes")
    .eq("status", "completed");
  const usedBytes = (data ?? []).reduce(
    (sum, row) => sum + (Number(row.size_bytes) || 0),
    0,
  );

  return (
    <AppShell
      email={ctx.user.email ?? ""}
      usage={{ usedBytes, limitBytes: env.storageLimitBytes }}
    >
      <RecorderStudio />
    </AppShell>
  );
}
