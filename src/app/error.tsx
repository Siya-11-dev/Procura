"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") return;
    console.error("Procura page error", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-lg font-semibold text-ink-100">
        This page hit a problem
      </h1>
      <p className="max-w-md text-sm text-ink-400">
        {error.digest
          ? `Something went wrong while rendering this page (reference ${error.digest}). The request itself is safe — try again, or go back to the dashboard.`
          : "Something went wrong while rendering this page. Your data is safe — try again."}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-300 transition hover:border-ink-400 hover:text-ink-100"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}