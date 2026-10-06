import type { AgentRun } from "@/lib/domain/types";
import { AgentBadge, Panel, PanelHeader } from "./ui";

function DetailRows({ detail }: { detail: unknown }) {
  if (detail === null || detail === undefined) return null;

  if (Array.isArray(detail)) {
    if (detail.length === 0) return null;
    return (
      <ul className="mt-2 space-y-1 text-xs text-ink-300">
        {detail.slice(0, 8).map((entry, index) => (
          <li key={index} className="flex gap-2">
            <span className="text-ink-500">·</span>
            <span>
              {typeof entry === "string" ? entry : JSON.stringify(entry)}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (typeof detail === "object") {
    const entries = Object.entries(detail as Record<string, unknown>).filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    );
    if (entries.length === 0) return null;
    return (
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {entries.slice(0, 12).map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between gap-3">
            <dt className="truncate text-[11px] text-ink-400">
              {humanise(key)}
            </dt>
            <dd className="truncate text-right font-mono text-[11px] text-ink-200">
              {render(value)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return null;
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string") {
    return value.length > 70 ? `${value.slice(0, 70)}…` : value;
  }
  if (Array.isArray(value)) return `${value.length} items`;
  return "object";
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
}

function toneFor(run: AgentRun): string {
  if (run.status === "failed") return "border-risk-500/50 bg-risk-500/5";
  if (run.status === "skipped") return "border-ink-700 bg-ink-850/40 opacity-70";
  return "border-ink-700 bg-ink-850/60";
}

export function AgentTimeline({ runs }: { runs: AgentRun[] }) {
  if (runs.length === 0) {
    return (
      <Panel>
        <PanelHeader
          title="Agent run history"
          hint="Every decision an agent makes, in order"
        />
        <p className="px-5 py-8 text-center text-sm text-ink-400">
          No agents have run for this request yet.
        </p>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Agent run history"
        hint={`${runs.length} agent executions, each one recorded for audit`}
      />
      <ol className="divide-y divide-ink-700">
        {runs.map((run) => (
          <li
            key={run.id}
            className={`border-l-2 border-l-ink-600 px-5 py-4 ${toneFor(run)}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-ink-500">
                {String(run.step).padStart(2, "0")}
              </span>
              <AgentBadge agent={run.agent} />
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  run.status === "failed"
                    ? "bg-risk-500/15 text-risk-500"
                    : "bg-gain-500/15 text-gain-500"
                }`}
              >
                {run.status}
              </span>
              <span className="ml-auto font-mono text-[11px] text-ink-500">
                {run.durationMs}ms
              </span>
            </div>

            <p className="mt-2 text-sm leading-relaxed text-ink-100">
              {run.summary}
            </p>

            <DetailRows detail={run.detail} />

            <p className="mt-2 font-mono text-[10px] text-ink-500">
              {new Date(run.startedAt).toLocaleString("en-ZA")}
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
