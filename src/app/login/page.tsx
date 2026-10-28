"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { APP_NAME } from "@/lib/config";
import { AlertIcon, RecordIcon } from "@/components/icons";

type ErrorKind = "credentials" | "account" | "rate" | "network" | "unknown";

const ERROR_MESSAGES: Record<ErrorKind, string> = {
  credentials: "Incorrect email or password.",
  account: "This account is not authorized to use this app.",
  rate: "Too many attempts. Wait a moment and try again.",
  network: "Could not reach the sign-in service. Check your connection.",
  unknown: "Sign-in failed. Please try again.",
};

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full flex-1 items-center justify-center px-4 py-12" />
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<ErrorKind | null>(null);

  const error: ErrorKind | null =
    formError ?? (searchParams.get("error") === "account" ? "account" : null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setFormError(null);
    try {
      const supabase = createSupabaseBrowser();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        const message = signInError.message.toLowerCase();
        if (message.includes("invalid login")) setFormError("credentials");
        else if (message.includes("rate") || message.includes("too many"))
          setFormError("rate");
        else if (message.includes("fetch")) setFormError("network");
        else setFormError("unknown");
        return;
      }
      router.replace("/library");
      router.refresh();
    } catch {
      setFormError("network");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <RecordIcon width={22} height={22} />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {APP_NAME}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Private screen recording studio — sign in to continue.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
        >
          {error ? (
            <div
              className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700 ring-1 ring-red-200"
              role="alert"
            >
              <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
              <span>{ERROR_MESSAGES[error]}</span>
            </div>
          ) : null}

          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-16 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-2 my-auto h-6 rounded px-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-center text-xs text-slate-400">
            Single-user app — no public registration.
          </p>
        </form>
      </div>
    </div>
  );
}
