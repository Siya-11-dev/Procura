import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-ink-500">
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Nothing here
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-300">
        That request does not exist, or the database has been reset since you
        last looked at it.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}
