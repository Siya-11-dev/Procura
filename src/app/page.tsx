import Link from "next/link";
import { AgentTimeline } from "@/components/agent-timeline";
import { Panel, PanelHeader, Pill, StatCard, StatusPill } from "@/components/ui";
import { bootstrap } from "@/lib/bootstrap";
import { requireSession } from "@/lib/auth/guard";
import { listAgentRuns, listRequests } from "@/lib/db/repository";
import { getDashboardMetrics, getRequestBundle } from "@/lib/queries";
import { CATEGORY_LABEL, type ProcurementRequest } from "@/lib/domain/types";
import { formatDate, formatMoney } from "@/lib/util";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireSession("/");
  await bootstrap();

  const metrics = getDashboardMetrics();
  const requests = listRequests();

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Procurement, run by nine agents
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-300">
            An employee raises a request in plain language. The agents source
            it, compare it, check the risk, negotiate the price, route the
            approval, raise the PO and match the invoice — with every decision
            recorded.
          </p>
        </div>
        <Link
          href="/requests/new"
          className="rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-400"
        >
          Raise a request
        </Link>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Committed spend"
          value={formatMoney(metrics.committedSpend, metrics.currency)}
          sub="purchase orders issued"
          tone="brand"
        />
        <StatCard
          label="Negotiated savings"
          value={formatMoney(metrics.negotiationSavings, metrics.currency)}
          sub="price improvement won by the Negotiation Agent"
          tone="gain"
        />
        <StatCard
          label="Quotes per request"
          value={(metrics.quotesReceived / Math.max(metrics.totalRequests, 1)).toFixed(1)}
          sub={`${metrics.quotesReceived} quotations collected in total`}
        />
        <StatCard
          label="Source to PO"
          value={
            metrics.averageCycleMinutes < 1
              ? "< 1 min"
              : `${Math.round(metrics.averageCycleMinutes)} min`
          }
          sub="agent execution time, request raised to purchase order"
          tone="gain"
        />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="In flight"
          value={String(metrics.inFlight)}
          sub="sourcing or awaiting a decision"
        />
        <StatCard
          label="Awaiting approval"
          value={String(metrics.awaitingApproval)}
          sub="routed to a named approver"
        />
        <StatCard
          label="Invoices matched clean"
          value={String(metrics.invoicesMatched)}
          sub="three-way match passed on first pass"
          tone="gain"
        />
        <StatCard
          label="Invoices flagged"
          value={String(metrics.invoicesFlagged)}
          sub="discrepancy caught before payment"
          tone={metrics.invoicesFlagged > 0 ? "brand" : "neutral"}
        />
      </section>

      <Panel>
        <PanelHeader
          title="Requests"
          hint="Select a request to see the full agent audit trail"
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="px-5 py-2.5 font-medium">Reference</th>
                <th className="px-5 py-2.5 font-medium">Request</th>
                <th className="px-5 py-2.5 font-medium">Category</th>
                <th className="px-5 py-2.5 font-medium">Awarded to</th>
                <th className="px-5 py-2.5 text-right font-medium">Value</th>
                <th className="px-5 py-2.5 text-right font-medium">Saved</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-ink-400">
                    No requests yet.
                  </td>
                </tr>
              ) : (
                requests.map((request) => (
                  <RequestRow key={request.id} request={request} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <RecentAgentWork />
    </div>
  );
}

async function RequestRow({ request }: { request: ProcurementRequest }) {
  const bundle = getRequestBundle(request.id);
  const supplier =
    bundle?.purchaseOrder?.supplierName ??
    bundle?.comparison?.rows.find((row) => row.rank === 1)?.supplierName ??
    null;
  const value =
    bundle?.purchaseOrder?.totalAmount ??
    bundle?.comparison?.rows[0]?.totalPrice ??
    null;
  const saved =
    (bundle?.negotiation?.realisedSaving ?? 0) +
    Math.max(0, bundle?.comparison?.savingsVsBudget ?? 0);

  return (
    <tr className="transition hover:bg-ink-800/40">
      <td className="px-5 py-3 font-mono text-xs text-ink-300">
        <Link href={`/requests/${request.id}`} className="hover:text-brand-400">
          {request.reference}
        </Link>
      </td>
      <td className="px-5 py-3">
        <Link href={`/requests/${request.id}`} className="block max-w-72">
          <span className="block truncate font-medium text-ink-100 hover:text-brand-400">
            {request.title}
          </span>
          <span className="block truncate text-xs text-ink-400">
            {request.requesterName} · {request.requesterDepartment} ·{" "}
            {formatDate(request.createdAt)}
          </span>
        </Link>
      </td>
      <td className="px-5 py-3 text-ink-300">
        {request.category ? CATEGORY_LABEL[request.category] : "—"}
      </td>
      <td className="px-5 py-3 text-ink-300">{supplier ?? "—"}</td>
      <td className="px-5 py-3 text-right font-mono tabular-nums text-ink-100">
        {value === null ? "—" : formatMoney(value, request.currency)}
      </td>
      <td className="px-5 py-3 text-right font-mono tabular-nums">
        {saved > 0 ? (
          <span className="text-gain-500">{formatMoney(saved, request.currency)}</span>
        ) : (
          <span className="text-ink-500">—</span>
        )}
      </td>
      <td className="px-5 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={request.status} />
          {bundle?.invoice && bundle.invoice.status !== "matched" ? (
            <Pill tone="risk">invoice flagged</Pill>
          ) : null}
          {bundle?.pendingApproval ? (
            <Pill tone="warn">{bundle.pendingApproval.role}</Pill>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

async function RecentAgentWork() {
  const recent = listRequests()
    .flatMap((request) =>
      listAgentRuns(request.id).map((run) => ({ run, request })),
    )
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
    .slice(0, 8)
    .map(({ run }) => run);

  if (recent.length === 0) return null;

  return <AgentTimeline runs={recent} />;
}
