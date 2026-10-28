"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";

type Tone = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

interface ToastApi {
  push: (message: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>");
  return value;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, tone: Tone = "info") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:items-end"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={[
              "pointer-events-auto flex max-w-md items-start gap-2 rounded-lg px-4 py-3 text-sm shadow-lg ring-1",
              toast.tone === "error"
                ? "bg-red-50 text-red-800 ring-red-200"
                : toast.tone === "success"
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                  : "bg-white text-slate-800 ring-slate-200",
            ].join(" ")}
          >
            <span className="mt-0.5 shrink-0">
              {toast.tone === "error" ? (
                <AlertIcon width={16} height={16} />
              ) : toast.tone === "success" ? (
                <CheckIcon width={16} height={16} />
              ) : null}
            </span>
            <span className="flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() =>
                setToasts((current) => current.filter((t) => t.id !== toast.id))
              }
              className="shrink-0 opacity-50 transition hover:opacity-100"
              aria-label="Dismiss"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
