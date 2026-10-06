"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction, type SignupState } from "./actions";

const initialState: SignupState = { error: null, fieldErrors: {} };

const fieldClass =
  "w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-400 focus:outline-none";

export default function SignupForm() {
  const [state, formAction, pending] = useActionState(signupAction, initialState);

  const invalid = (field: string) => state.fieldErrors[field];

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-ink-200">
          Full name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoComplete="name"
          aria-invalid={Boolean(invalid("name"))}
          className={fieldClass}
        />
        {invalid("name") && (
          <p className="mt-1.5 text-xs text-risk-300">{invalid("name")}</p>
        )}
      </div>

      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink-200">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          aria-invalid={Boolean(invalid("email"))}
          placeholder="you@company.co.za"
          className={fieldClass}
        />
        {invalid("email") && (
          <p className="mt-1.5 text-xs text-risk-300">{invalid("email")}</p>
        )}
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
          minLength={12}
          autoComplete="new-password"
          aria-invalid={Boolean(invalid("password"))}
          className={fieldClass}
        />
        <p className="mt-1.5 text-xs text-ink-500">
          At least 12 characters. This is your own password; it is not the demo one.
        </p>
        {invalid("password") && (
          <p className="mt-1.5 text-xs text-risk-300">{invalid("password")}</p>
        )}
      </div>

      <div>
        <label htmlFor="department" className="mb-1.5 block text-sm font-medium text-ink-200">
          Department <span className="text-ink-500">(optional)</span>
        </label>
        <input
          id="department"
          name="department"
          type="text"
          autoComplete="organization-title"
          className={fieldClass}
        />
      </div>

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
        {pending ? "Creating account…" : "Create account"}
      </button>

      <p className="text-xs text-ink-500">
        New accounts start as <span className="text-ink-300">Requester</span>. Approval
        authority is granted separately by an administrator, so nobody can approve their
        own request by registering for it.{" "}
        <Link href="/login" className="text-brand-400 hover:text-brand-300">
          Sign in instead
        </Link>
      </p>
    </form>
  );
}