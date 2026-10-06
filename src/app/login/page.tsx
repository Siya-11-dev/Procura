import { bootstrap } from "@/lib/bootstrap";
import LoginForm from "./login-form";

function DemoAccounts() {
  const accounts = [
    { name: "Nomsa Khumalo", role: "Procurement Lead", email: "nomsa.khumalo@procura.co.za" },
    { name: "Riaan Steyn", role: "Finance Director", email: "riaan.steyn@procura.co.za" },
    { name: "Thandiwe Mokoena", role: "CFO", email: "thandiwe.mokoena@procura.co.za" },
    { name: "Daniel Fischer", role: "CEO", email: "daniel.fischer@procura.co.za" },
    { name: "Lerato Mabaso", role: "Compliance Officer", email: "lerato.mabaso@procura.co.za" },
    { name: "Amahle Dlamini", role: "Requester", email: "amahle.dlamini@procura.co.za" },
    { name: "Platform Administrator", role: "Administrator", email: "admin@procura.co.za" },
  ];
  return (
    <div className="mt-8 border-t border-ink-700 pt-6">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-400">
        Demo accounts
      </p>
      <ul className="divide-y divide-ink-800">
        {accounts.map((account) => (
          <li key={account.email} className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-sm text-ink-200">{account.name}</span>
            <span className="text-xs text-ink-500">{account.role}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-500">
        Every demo account uses the same password:{" "}
        <code className="rounded bg-ink-800 px-1.5 py-0.5 text-ink-300">Procura!2026</code>
      </p>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { next } = await searchParams;
  const nextValue = typeof next === "string" && next.startsWith("/") ? next : "/";

  // The home page used to seed a fresh database, but the auth proxy now blocks
  // anonymous browsers before it. Seed here instead: this is the one SSR entry
  // everyone must reach before signing in, and both steps are idempotent.
  await bootstrap();

  return (
    <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-100">Procura</h1>
          <p className="mt-2 text-sm text-ink-400">
            AI procurement workforce. Sign in to continue.
          </p>
        </div>
        <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-6">
          <LoginForm nextValue={nextValue} />
        </div>
        <DemoAccounts />
      </div>
    </main>
  );
}

export const dynamic = "force-dynamic";