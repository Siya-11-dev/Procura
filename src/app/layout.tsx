import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { auth } from "@/auth";
import { ROLE_LABEL, isRole } from "@/lib/auth/roles";
import { signOutAction } from "@/app/login/actions";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Procura — AI Procurement Workforce",
  description:
    "Nine agents that take a purchase request from an employee's inbox to a matched invoice, without the manual procurement work.",
};

const AGENT_CHAIN = [
  "Request",
  "Supplier",
  "Quote",
  "Comparison",
  "Risk",
  "Negotiation",
  "Approval",
  "PO",
  "Invoice",
];

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await auth();
  const user = session?.user;
  const roleLabel =
    user && typeof user.role === "string" && isRole(user.role)
      ? ROLE_LABEL[user.role]
      : null;
  // Navigation hint only. The admin page re-checks the role against the
  // database, so hiding this link is a convenience rather than the control.
  const isAdmin = user?.role === "admin";

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/85 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-brand-500/15 text-sm font-bold text-brand-400 ring-1 ring-brand-500/30">
                P
              </span>
              <span className="text-[15px] font-semibold tracking-tight">
                Procura
              </span>
              <span className="hidden text-xs text-ink-400 sm:inline">
                AI Procurement Workforce
              </span>
            </Link>

            <nav className="flex items-center gap-1 text-sm">
              <Link
                href="/"
                className="rounded-md px-2.5 py-1.5 text-ink-300 transition hover:bg-ink-800 hover:text-ink-100"
              >
                Dashboard
              </Link>
              <Link
                href="/requests/new"
                className="rounded-md px-2.5 py-1.5 text-ink-300 transition hover:bg-ink-800 hover:text-ink-100"
              >
                New request
              </Link>
              <Link
                href="/suppliers"
                className="rounded-md px-2.5 py-1.5 text-ink-300 transition hover:bg-ink-800 hover:text-ink-100"
              >
                Supplier network
              </Link>
              {isAdmin && (
                <Link
                  href="/admin/users"
                  className="rounded-md px-2.5 py-1.5 text-ink-300 transition hover:bg-ink-800 hover:text-ink-100"
                >
                  Accounts
                </Link>
              )}
            </nav>

            <div className="ml-auto flex items-center gap-3">
              {user ? (
                <>
                  <div className="hidden text-right leading-tight sm:block">
                    <p className="text-sm font-medium text-ink-100">{user.name}</p>
                    {roleLabel && (
                      <p className="text-[11px] text-ink-500">{roleLabel}</p>
                    )}
                  </div>
                  <form action={signOutAction}>
                    <button className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 transition hover:border-ink-500 hover:text-ink-100">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <p className="hidden font-mono text-[11px] text-ink-400 lg:block">
                    {AGENT_CHAIN.join(" → ")}
                  </p>
                  <Link
                    href="/login"
                    className="rounded-md bg-brand-500 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brand-400"
                  >
                    Sign in
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-5 py-8">{children}</main>

        <footer className="mx-auto max-w-7xl px-5 pb-10 pt-4 text-xs text-ink-400">
          Simulated supplier market. Every agent decision is recorded in the
          audit trail on each request.
        </footer>
      </body>
    </html>
  );
}
