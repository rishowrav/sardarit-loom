import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getServerEnv } from "@/lib/env";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Supabase client bound to the current request's cookies (RLS-scoped to the
 * signed-in user). Safe in Server Components, Route Handlers and Server
 * Actions.
 */
export async function createSupabaseServer(cookieStore?: CookieStore) {
  const env = getServerEnv();
  const store = cookieStore ?? (await cookies());

  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            store.set(name, value, options),
          );
        } catch {
          // Server Components cannot write cookies — session refresh is
          // already handled by the auth proxy, so ignore.
        }
      },
    },
  });
}
