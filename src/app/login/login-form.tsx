"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction, type LoginState } from "./actions";
import { DEMO_PASSWORD } from "@/lib/auth/demo-password";

const initialState: LoginState = { error: null };

export default function LoginForm({ nextValue = "/" }: { nextValue?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink-200">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          placeholder="you@procura.co.za"
          className="w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-400 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink-200">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          className="w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-400 focus:outline-none"
        />
      </div>

      <input type="hidden" name="next" value={nextValue} />

      {state.error && (
        <p className="rounded-md border border-risk-600 bg-risk-950/40 px-3 py-2 text-sm text-risk-300">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-400 disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-center text-xs text-ink-500">
        No account?{" "}
        <Link href="/signup" className="text-brand-400 hover:text-brand-300">
          Create one
        </Link>
      </p>

      <p className="text-xs leading-relaxed text-ink-500">
        Demo account password is{" "}
        <code className="rounded bg-ink-800 px-1.5 py-0.5 text-ink-300">{DEMO_PASSWORD}</code>.
        Available accounts:{" "}
        <span className="text-ink-400">
          nomsa.khumalo@procura.co.za, riaan.steyn@procura.co.za,
          thandiwe.mokoena@procura.co.za, daniel.fischer@procura.co.za,
          lerato.mabaso@procura.co.za, amahle.dlamini@procura.co.za,
          admin@procura.co.za
        </span>
        <button
          type="button"
          onClick={() => {
            const emailInput = document.getElementById("email") as HTMLInputElement | null;
            const passwordInput = document.getElementById("password") as HTMLInputElement | null;
            if (emailInput && passwordInput) {
              emailInput.value = "nomsa.khumalo@procura.co.za";
              passwordInput.value = DEMO_PASSWORD;
            }
          }}
          className="ml-2 rounded border border-ink-600 px-2 py-0.5 text-ink-300 transition hover:border-brand-400 hover:text-brand-300"
        >
          Fill demo account
        </button>
      </p>
    </form>
  );
}