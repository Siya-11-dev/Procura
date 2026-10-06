import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentTimeline } from "@/components/agent-timeline";
import { DecisionBar, InvoiceForm, RerunButton } from "@/components/request-actions";
import {
  ClarificationPanel,
  ComparisonPanel,
  GoodsReceiptPanel,
  InvoicePanel,
  NegotiationPanel,
  PurchaseOrderPanel,
  QuoteTable,
  RequestBriefPanel,
  RfqPanel,
  RiskPanel,
} from "@/components/request-panels";
import {
  EmptyState,
  KeyValue,
  Panel,
  PanelHeader,
  Pill,
  StatusPill,
} from "@/components/ui";
import { getSupplier, listRequestDocuments } from "@/lib/db/repository";
import { requireSession } from "@/lib/auth/guard";
import { getRequestBundle } from "@/lib/queries";
import { CATEGORY_LABEL, type ApprovalStep } from "@/lib/domain/types";
import { formatDate, formatMoney } from "@/lib/util";

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The session check comes before the lookup so an anonymous visitor is sent
  // to login rather than being told whether this reference exists at all.
  await requireSession(`/requests/${id}`);
  const bundle = getRequestBundle(id);
  if (!bundle) notFound();

  const { request, spec, quotes, comparison, risks, negotiation, approvals } =
    bundle;
  // Fetched here rather than through getRequestBundle so the dashboard, which
  // calls that per request, does not pay for a query it never renders.
  const documents = listRequestDocuments(id);
  const supplierNames = new Map(
    quotes
      .map((quote) => getSupplier(quote.supplierId))
      .filter((supplier) => supplier !== null)
      .map((supplier) => [supplier.id, supplier.name]),
  );

  return (
    <div className="space-y-6">
      <nav className="text-xs text-ink-400">
        <Link href="/" className="hover:text-brand-400">
          All requests
        </Link>
        <span className="mx-2">/</span>
        <span className="font-mono text-ink-300">{request.reference}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {request.title}
            </h1>
            <StatusPill status={request.status} />
            {request.urgency !== "normal" ? (
              <Pill tone={request.urgency === "critical" ? "risk" : "warn"}>
                {request.urgency} urgency
              </Pill>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-ink-300">
            {request.requesterName} · {request.requesterDepartment} · raised{" "}
            {formatDate(request.createdAt)} ·{" "}
            {request.category
              ? CATEGORY_LABEL[request.category]
              : "category not yet set"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RerunButton requestId={request.id} />
        </div>
      </header>

      <DecisionBar bundle={bundle} />

      <ClarificationPanel
        requestId={request.id}
        clarifications={bundle.clarifications}
      />

      {bundle.rfqInvitations.length > 0 ? (
        <RfqPanel
          requestId={request.id}
          status={request.status}
          invitations={bundle.rfqInvitations}
        />
      ) : null}

      {request.status === "blocked" && bundle.approvals.length > 0 ? (
        <div className="rounded-xl border border-risk-500/30 bg-risk-500/5 p-4">
          <p className="text-sm font-medium text-risk-500">
            Every approval is cleared, but no purchase order has been raised.
          </p>
          <p className="mt-1 text-sm text-ink-300">
            The risk agent still holds an unresolved critical finding on the
            recommended supplier. Record a written exception in the risk panel
            below to release the order, or fix the finding and re-run the
            pipeline.
          </p>
        </div>
      ) : null}

      {request.status === "blocked" && bundle.approvals.length === 0 ? (
        <div className="rounded-xl border border-warn-500/30 bg-warn-500/5 p-4">
          <p className="text-sm font-medium text-warn-500">
            The response window closed without a single quotation.
          </p>
          <p className="mt-1 text-sm text-ink-300">
            There is nothing to compare, so the request is parked here rather
            than awarded on no evidence. Re-run the agents to invite a wider
            pool of suppliers.
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.7fr_1fr] lg:items-start">
        <div className="space-y-6">
          <RequestBriefPanel request={request} spec={spec} />

          <QuoteTable
            quotes={quotes}
            comparison={comparison}
            supplierNames={supplierNames}
          />

          {comparison ? (
            <ComparisonPanel
              comparison={comparison}
              currency={request.currency}
            />
          ) : null}

          <RiskPanel
            requestId={request.id}
            risks={risks}
            exceptions={bundle.riskExceptions}
            purchaseOrderRaised={bundle.purchaseOrder !== null}
          />

          {negotiation ? (
            <NegotiationPanel
              negotiation={negotiation}
              currency={request.currency}
            />
          ) : null}

          {bundle.purchaseOrder ? (
            <PurchaseOrderPanel
              po={bundle.purchaseOrder}
              request={request}
            />
          ) : null}

          {bundle.purchaseOrder ? (
            <GoodsReceiptPanel
              requestId={request.id}
              po={bundle.purchaseOrder}
              receipt={bundle.goodsReceipt}
            />
          ) : null}

          {bundle.invoice ? <InvoicePanel invoice={bundle.invoice} /> : null}

          {bundle.invoice ? null : bundle.purchaseOrder ? (
            <InvoiceForm
              requestId={request.id}
              poNumber={bundle.purchaseOrder.poNumber}
              invoiceAmount={
                bundle.purchaseOrder.subtotal + bundle.purchaseOrder.shippingCost
              }
              taxAmount={bundle.purchaseOrder.taxAmount}
              currency={request.currency}
            />
          ) : null}
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader
              title="Approval route"
              hint={
                bundle.pendingApproval
                  ? `Waiting on ${bundle.pendingApproval.role}`
                  : approvals.length > 0
                    ? "Every step decided"
                    : "Not routed yet"
              }
            />
            {approvals.length === 0 ? (
              <EmptyState>
                The Approval Agent routes this once sourcing and negotiation
                are complete.
              </EmptyState>
            ) : (
              <ol className="divide-y divide-ink-800">
                {approvals.map((step) => (
                  <ApprovalRow
                    key={step.id}
                    step={step}
                    currency={request.currency}
                    isPending={bundle.pendingApproval?.id === step.id}
                  />
                ))}
              </ol>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Request facts" />
            <dl className="divide-y divide-ink-800 px-5 py-2">
              <KeyValue label="Quantity" mono>
                {request.quantity === null
                  ? "not stated"
                  : `${request.quantity} ${request.unit}`}
              </KeyValue>
              <KeyValue label="Budget" mono>
                {request.budgetAmount === null
                  ? "not stated"
                  : formatMoney(request.budgetAmount, request.currency)}
              </KeyValue>
              <KeyValue label="Needed by" mono>
                {request.neededBy === null
                  ? "not stated"
                  : formatDate(request.neededBy)}
              </KeyValue>
              <KeyValue label="Quotes received" mono>
                {quotes.length}
              </KeyValue>
              <KeyValue label="Supplier risk band" mono>
                {risks.find((risk) => risk.isRecommended)?.band ?? "—"}
              </KeyValue>
            </dl>
          </Panel>

          {documents.length > 0 ? (
            <Panel>
              <PanelHeader
                title="Attachments"
                hint={`${documents.filter((doc) => doc.extractStatus === "read").length} of ${documents.length} read by the agents`}
              />
              <ul className="divide-y divide-ink-800">
                {documents.map((doc) => (
                  <li key={doc.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm text-ink-100">
                        {doc.originalName}
                      </span>
                      <Pill tone={doc.extractStatus === "read" ? "gain" : "warn"}>
                        {doc.extractStatus === "read"
                          ? "read"
                          : "stored, not read"}
                      </Pill>
                    </div>
                    <p className="mt-1 text-xs text-ink-400">
                      {(doc.byteSize / 1024).toFixed(0)} KB · uploaded{" "}
                      {formatDate(doc.uploadedAt)}
                      {doc.charCount !== null
                        ? ` · ${doc.charCount.toLocaleString("en-ZA")} characters extracted`
                        : ""}
                    </p>
                    {doc.extractReason ? (
                      <p className="mt-1 text-xs text-warn-500">
                        {doc.extractReason}
                      </p>
                    ) : null}
                    <p
                      className="mt-1 truncate font-mono text-[10px] text-ink-600"
                      title="SHA-256 of the stored file"
                    >
                      sha256 {doc.sha256}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>

      <AgentTimeline runs={bundle.runs} />
    </div>
  );
}

function ApprovalRow({
  step,
  currency,
  isPending,
}: {
  step: ApprovalStep;
  currency: string;
  isPending: boolean;
}) {
  const tone =
    step.status === "approved"
      ? "gain"
      : step.status === "rejected"
        ? "risk"
        : step.status === "not_required"
          ? "neutral"
          : "warn";

  return (
    <li
      className={`px-5 py-3.5 ${isPending ? "bg-warn-500/5" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink-100">{step.role}</span>
        <Pill tone={tone}>{step.status.replace("_", " ")}</Pill>
        {step.automated ? <Pill tone="brand">auto</Pill> : null}
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {step.approverName} ·{" "}
        {step.thresholdAmount === 0
          ? "compliance gate, no monetary limit"
          : step.thresholdAmount > 1_000_000_000_000
            ? "unlimited authority"
            : `approves up to ${formatMoney(step.thresholdAmount, currency)}`}
      </p>
      {step.decisionNote ? (
        <p className="mt-1.5 text-sm text-ink-300">{step.decisionNote}</p>
      ) : null}
      {step.decidedAt ? (
        <p className="mt-1 font-mono text-[10px] text-ink-500">
          {formatDate(step.decidedAt)}
        </p>
      ) : null}
    </li>
  );
}
