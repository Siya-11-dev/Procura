import type { ReactNode } from "react";
import {
  AGENT_LABEL,
  AGENT_ROLE,
  REQUEST_STATUS_LABEL,
  type AgentName,
  type RequestStatus,
  type RiskBand,
} from "@/lib/domain/types";

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-ink-700 bg-ink-850/85 backdrop-blur-sm ${className}`}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-700 px-5 py-3.5">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-ink-100">
          {title}
        </h2>
        {hint ? (
          <p className="mt-0.5 text-xs text-ink-400">{hint}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

const STATUS_STYLE: Record<RequestStatus, string> = {
  submitted: "bg-ink-700 text-ink-200",
  needs_clarification: "bg-warn-500/15 text-warn-500 ring-1 ring-warn-500/30",
  sourcing: "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30",
  awaiting_quotes: "bg-brand-500/10 text-brand-300 ring-1 ring-brand-500/25",
  awaiting_approval: "bg-warn-500/15 text-warn-500 ring-1 ring-warn-500/30",
  approved: "bg-gain-500/15 text-gain-500 ring-1 ring-gain-500/30",
  blocked: "bg-risk-500/15 text-risk-500 ring-1 ring-risk-500/40",
  rejected: "bg-risk-500/15 text-risk-500 ring-1 ring-risk-500/30",
  po_issued: "bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30",
  invoice_submitted: "bg-gain-500/15 text-gain-500 ring-1 ring-gain-500/30",
  closed: "bg-ink-700 text-ink-300",
  failed: "bg-risk-500/15 text-risk-500 ring-1 ring-risk-500/30",
};

export function StatusPill({ status }: { status: RequestStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {REQUEST_STATUS_LABEL[status]}
    </span>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "gain" | "warn" | "risk" | "brand";
}) {
  const tones = {
    neutral: "bg-ink-700 text-ink-300",
    gain: "bg-gain-500/15 text-gain-500",
    warn: "bg-warn-500/15 text-warn-500",
    risk: "bg-risk-500/15 text-risk-500",
    brand: "bg-brand-500/15 text-brand-400",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function AgentBadge({ agent }: { agent: AgentName }) {
  return (
    <span
      title={AGENT_ROLE[agent]}
      className="inline-flex items-center gap-1.5 rounded-md bg-brand-500/12 px-2 py-0.5 font-mono text-[11px] font-medium text-brand-400 ring-1 ring-brand-500/25"
    >
      {AGENT_LABEL[agent]}
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "gain" | "brand";
}) {
  const valueTone =
    tone === "gain"
      ? "text-gain-500"
      : tone === "brand"
        ? "text-brand-400"
        : "text-ink-100";
  return (
    <Panel className="px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueTone}`}>
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-ink-400">{sub}</p> : null}
    </Panel>
  );
}

export function KeyValue({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs text-ink-400">{label}</dt>
      <dd
        className={`text-right text-sm text-ink-100 ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}

const BAND_STYLE: Record<RiskBand, string> = {
  low: "bg-gain-500/15 text-gain-500",
  moderate: "bg-brand-500/15 text-brand-400",
  elevated: "bg-warn-500/15 text-warn-500",
  high: "bg-risk-500/15 text-risk-500",
};

export function RiskBandPill({ band }: { band: RiskBand }) {
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${BAND_STYLE[band]}`}
    >
      {band} risk
    </span>
  );
}

export function ScoreBar({
  value,
  max = 100,
  tone = "brand",
}: {
  value: number;
  max?: number;
  tone?: "brand" | "gain" | "warn" | "risk";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const colours = {
    brand: "bg-brand-500",
    gain: "bg-gain-500",
    warn: "bg-warn-500",
    risk: "bg-risk-500",
  } as const;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
      <div
        className={`h-full rounded-full ${colours[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="px-5 py-8 text-center text-sm text-ink-400">{children}</p>
  );
}
