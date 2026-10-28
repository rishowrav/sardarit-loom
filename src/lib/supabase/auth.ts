import type { User } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";
import { createSupabaseServer } from "@/lib/supabase/server";

export interface AuthContext {
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>;
  user: User;
}

/** True when this user is the single configured owner of the app. */
export function isOwner(user: User): boolean {
  const ownerEmail = getServerEnv().ownerEmail;
  if (!ownerEmail) return true; // Not configured yet — proxy will warn via /api/health
  return user.email?.toLowerCase() === ownerEmail;
}

/**
 * Returns the signed-in owner's context, or null when there is no session or
 * the session belongs to someone other than the configured OWNER_EMAIL.
 */
export async function getOwnerContext(): Promise<AuthContext | null> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !isOwner(user)) return null;
    return { supabase, user };
  } catch {
    return null;
  }
}
