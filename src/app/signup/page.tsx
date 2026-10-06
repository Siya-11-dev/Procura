import { bootstrap } from "@/lib/bootstrap";
import SignupForm from "./signup-form";

export default async function SignupPage() {
  // The login page seeds on every visit, and signup is reachable from there, so
  // this is the fallback for a browser that lands here first.
  await bootstrap();

  return (
    <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-100">
            Create an account
          </h1>
          <p className="mt-2 text-sm text-ink-400">
            Register to raise procurement requests.
          </p>
        </div>
        <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-6">
          <SignupForm />
        </div>
      </div>
    </main>
  );
}

export const dynamic = "force-dynamic";