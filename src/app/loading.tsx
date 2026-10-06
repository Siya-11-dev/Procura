export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-64 animate-pulse rounded bg-ink-800" />
      <div className="h-4 w-80 animate-pulse rounded bg-ink-800" />
      <div className="grid gap-6 lg:grid-cols-[1.7fr_1fr] lg:items-start">
        <div className="space-y-6">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-ink-800 bg-ink-900/40"
            />
          ))}
        </div>
        <div className="space-y-6">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-xl border border-ink-800 bg-ink-900/40"
            />
          ))}
        </div>
      </div>
    </div>
  );
}