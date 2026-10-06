import {
  acceptRiskAction,
  acknowledgePurchaseOrderAction,
  answerClarificationAction,
  collectRfqResponsesAction,
  dispatchPurchaseOrderAction,
  recordGoodsReceiptAction,
} from "@/app/actions";
import type { RequestSpec, RiskException } from "@/lib/db/repository";
import type {
  Clarification,
  Comparison,
  DispatchChannel,
  GoodsReceipt,
  Invoice,
  Negotiation,
  ProcurementRequest,
  PurchaseOrder,
  Quote,
  RfqInvitation,
  RiskAssessment,
} from "@/lib/domain/types";
import { formatDate, formatMoney, formatMoneyExact } from "@/lib/util";
import {
  EmptyState,
  KeyValue,
  Panel,
  PanelHeader,
  Pill,
  RiskBandPill,
  ScoreBar,
} from "./ui";

export function QuoteTable({
  quotes,
  comparison,
  supplierNames,
}: {
  quotes: Quote[];
  comparison: Comparison | null;
  supplierNames: Map<string, string>;
}) {
  if (quotes.length === 0) return null;
  const rows = new Map(comparison?.rows.map((row) => [row.quoteId, row]));

  return (
    <Panel>
      <PanelHeader
        title="Quotations received"
        hint={`${quotes.length} bids, ranked on the weighted score by the Comparison Agent`}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th className="px-5 py-2.5 font-medium">Rank</th>
              <th className="px-5 py-2.5 font-medium">Supplier</th>
              <th className="px-5 py-2.5 text-right font-medium">Unit</th>
              <th className="px-5 py-2.5 text-right font-medium">Total</th>
              <th className="px-5 py-2.5 text-right font-medium">Lead time</th>
              <th className="px-5 py-2.5 font-medium">Terms</th>
              <th className="px-5 py-2.5 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {quotes.map((quote) => {
              const row = rows.get(quote.id);
              const recommended = comparison?.recommendedQuoteId === quote.id;
              return (
                <tr
                  key={quote.id}
                  className={recommended ? "bg-gain-500/5" : undefined}
                >
                  <td className="px-5 py-3 font-mono text-xs text-ink-400">
                    {recommended ? (
                      <Pill tone="gain">awarded</Pill>
                    ) : row ? (
                      `#${row.rank}`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className="font-medium text-ink-100">
                      {supplierNames.get(quote.supplierId) ?? "Unknown supplier"}
                    </span>
                    {row ? (
                      <span className="block text-xs text-ink-400">
                        {row.country}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-ink-200">
                    {formatMoneyExact(quote.unitPrice, quote.currency)}
                  </td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-ink-100">
                    {formatMoneyExact(quote.totalPrice, quote.currency)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-ink-300">
                    {quote.leadTimeDays}d
                  </td>
                  <td className="px-5 py-3 text-ink-300">{quote.paymentTerms}</td>
                  <td className="px-5 py-3 text-right">
                    {row ? (
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16">
                          <ScoreBar
                            value={row.totalScore}
                            tone={recommended ? "gain" : "brand"}
                          />
                        </div>
                        <span className="font-mono tabular-nums text-ink-100">
                          {row.totalScore.toFixed(1)}
                        </span>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-ink-700 px-5 py-3 text-xs text-ink-400">
        Totals are VAT inclusive. Unit prices shown are the negotiated price
        where the Negotiation Agent reached agreement.
      </p>
    </Panel>
  );
}

export function ComparisonPanel({
  comparison,
  currency,
}: {
  comparison: Comparison;
  currency: string;
}) {
  return (
    <Panel>
      <PanelHeader
        title="Weighted comparison"
        hint={`Price ${Math.round(comparison.weights.price * 100)}% · quality ${Math.round(comparison.weights.quality * 100)}% · delivery ${Math.round(comparison.weights.delivery * 100)}% · terms ${Math.round(comparison.weights.terms * 100)}% · supplier ${Math.round(comparison.weights.supplier * 100)}%`}
      />
      <div className="space-y-4 p-5">
        <p className="text-sm leading-relaxed text-ink-200">
          {comparison.rationale}
        </p>
        {comparison.tradeOffNote ? (
          <p className="rounded-lg border border-warn-500/25 bg-warn-500/5 px-3.5 py-2.5 text-sm text-warn-500">
            {comparison.tradeOffNote}
          </p>
        ) : null}
        <dl className="divide-y divide-ink-800">
          {comparison.budgetAmount !== null ? (
            <KeyValue label="Requested budget" mono>
              {formatMoney(comparison.budgetAmount, currency)}
            </KeyValue>
          ) : null}
          <KeyValue label="Recommended total" mono>
            {formatMoney(comparison.rows[0]?.totalPrice ?? 0, currency)}
          </KeyValue>
          {comparison.savingsVsBudget !== null ? (
            <KeyValue
              label={
                comparison.savingsVsBudget >= 0
                  ? "Under budget by"
                  : "Over budget by"
              }
              mono
            >
              <span
                className={
                  comparison.savingsVsBudget >= 0 ? "text-gain-500" : "text-risk-500"
                }
              >
                {formatMoney(Math.abs(comparison.savingsVsBudget), currency)}
              </span>
            </KeyValue>
          ) : null}
          {comparison.pricePremiumPct > 0 ? (
            <KeyValue label="Premium over cheapest bid" mono>
              {comparison.pricePremiumPct.toFixed(1)}%
            </KeyValue>
          ) : null}
          <KeyValue label="Saving vs lowest bid" mono>
            <span className="text-gain-500">
              {formatMoney(comparison.savingsVsLowestBid, currency)}
            </span>
          </KeyValue>
        </dl>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wider text-gain-500">
              Why the recommended supplier
            </h3>
            <ul className="mt-2 space-y-1.5">
              {comparison.rows[0]?.pros.map((pro) => (
                <li key={pro} className="text-sm text-ink-300">
                  {pro}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
              What it gives up
            </h3>
            <ul className="mt-2 space-y-1.5">
              {(comparison.rows[0]?.cons ?? []).map((con) => (
                <li key={con} className="text-sm text-ink-300">
                  {con}
                </li>
              ))}
              {(comparison.rows[0]?.cons ?? []).length === 0 ? (
                <li className="text-sm text-ink-500">
                  Nothing material — it leads on price, quality and delivery.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function RiskPanel({
  requestId,
  risks,
  exceptions,
  purchaseOrderRaised,
}: {
  requestId: string;
  risks: RiskAssessment[];
  exceptions: RiskException[];
  purchaseOrderRaised: boolean;
}) {
  if (risks.length === 0) return null;
  const recommended = risks.find((risk) => risk.isRecommended) ?? risks[0];
  const alternates = risks.filter((risk) => risk.id !== recommended.id);
  const waived = new Map(exceptions.map((e) => [e.flagCode, e]));

  return (
    <Panel>
      <PanelHeader
        title="Supplier risk"
        hint={`${risks.length} suppliers assessed. Band for the recommended supplier: ${recommended.band}`}
      />
      <div className="space-y-5 p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-ink-100">
              {recommended.supplierName}
            </h3>
            <RiskBandPill band={recommended.band} />
            <span className="ml-auto font-mono text-sm tabular-nums text-ink-200">
              {recommended.overallScore.toFixed(0)}/100
            </span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {(
              [
                ["Financial", recommended.financialScore],
                ["Delivery", recommended.deliveryScore],
                ["Compliance", recommended.complianceScore],
                ["Concentration", recommended.concentrationScore],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] text-ink-400">{label}</span>
                  <span className="font-mono text-[11px] text-ink-200">
                    {value.toFixed(0)}
                  </span>
                </div>
                <div className="mt-1">
                  <ScoreBar
                    value={value}
                    tone={
                      value >= 82 ? "gain" : value >= 62 ? "warn" : "risk"
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-ink-300">{recommended.recommendation}</p>
        </div>

        {recommended.flags.length > 0 ? (
          <ul className="space-y-2">
            {recommended.flags.map((flag) => {
              const exception = waived.get(flag.code);
              const blocked =
                flag.severity === "critical" && !exception && !purchaseOrderRaised;

              return (
                <li
                  key={flag.code}
                  className={`rounded-lg border px-3.5 py-2.5 ${
                    flag.severity === "critical"
                      ? "border-risk-500/30 bg-risk-500/5"
                      : flag.severity === "warning"
                        ? "border-warn-500/25 bg-warn-500/5"
                        : "border-ink-700 bg-ink-800/40"
                  }`}
                >
                  <p
                    className={`text-sm font-medium ${
                      flag.severity === "critical"
                        ? "text-risk-500"
                        : flag.severity === "warning"
                          ? "text-warn-500"
                          : "text-ink-200"
                    }`}
                  >
                    {flag.label}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-300">{flag.detail}</p>

                  {exception ? (
                    <p className="mt-2 border-t border-ink-700/60 pt-2 text-xs text-ink-400">
                      Accepted by {exception.approverName}: &ldquo;
                      {exception.justification}&rdquo;
                    </p>
                  ) : blocked ? (
                    <form
                      action={async (formData: FormData) => {
                        "use server";
                        await acceptRiskAction(
                          requestId,
                          flag.code,
                          String(formData.get("justification") ?? ""),
                          String(formData.get("approverName") ?? ""),
                        );
                      }}
                      className="mt-2.5 space-y-2 border-t border-ink-700/60 pt-2.5"
                    >
                      <p className="text-xs text-risk-500">
                        This blocks the purchase order until an approver accepts
                        it in writing.
                      </p>
                      <input
                        type="text"
                        name="approverName"
                        required
                        placeholder="Your name"
                        className="w-full rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-ink-500 focus:outline-none"
                      />
                      <textarea
                        name="justification"
                        required
                        rows={2}
                        placeholder="Why is this risk acceptable? e.g. quantity confirmed, budget approved by the budget holder."
                        className="w-full resize-y rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-ink-500 focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-ink-600 px-2.5 py-1.5 text-xs font-medium text-ink-100 transition hover:border-ink-500 hover:bg-ink-800"
                      >
                        Accept this risk
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {alternates.length > 0 ? (
          <details className="rounded-lg border border-ink-700 bg-ink-800/30">
            <summary className="cursor-pointer px-3.5 py-2.5 text-xs font-medium text-ink-300">
              Risk scores for the {alternates.length} alternate supplier
              {alternates.length === 1 ? "" : "s"}
            </summary>
            <ul className="divide-y divide-ink-800 border-t border-ink-700">
              {alternates.map((risk) => (
                <li
                  key={risk.id}
                  className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
                >
                  <span className="text-sm text-ink-200">{risk.supplierName}</span>
                  <RiskBandPill band={risk.band} />
                  <span className="ml-auto font-mono text-xs tabular-nums text-ink-400">
                    {risk.overallScore.toFixed(0)}/100
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

export function NegotiationPanel({
  negotiation,
  currency,
}: {
  negotiation: Negotiation;
  currency: string;
}) {
  return (
    <Panel>
      <PanelHeader
        title="Negotiation"
        hint={
          negotiation.status === "agreed"
            ? `Agreed with ${negotiation.supplierName}`
            : `Closed without agreement — ${negotiation.supplierName}`
        }
      />
      <div className="space-y-5 p-5">
        <div className="grid gap-2 sm:grid-cols-5">
          {(
            [
              ["List price", negotiation.listUnitPrice, "neutral"],
              ["Opened at", negotiation.openingUnitPrice, "brand"],
              ["Their counter", negotiation.counterUnitPrice, "neutral"],
              ["Walkaway", negotiation.walkawayUnitPrice, "risk"],
              [
                "Agreed",
                negotiation.agreedUnitPrice,
                negotiation.status === "agreed" ? "gain" : "risk",
              ],
            ] as const
          ).map(([label, value, tone]) => (
            <div
              key={label}
              className="rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2.5"
            >
              <p className="text-[11px] text-ink-400">{label}</p>
              <p
                className={`mt-0.5 font-mono text-sm tabular-nums ${
                  tone === "gain"
                    ? "text-gain-500"
                    : tone === "risk"
                      ? "text-risk-500"
                      : tone === "brand"
                        ? "text-brand-400"
                        : "text-ink-200"
                }`}
              >
                {value === null ? "—" : formatMoney(value, currency)}
              </p>
            </div>
          ))}
        </div>

        <p className="text-sm leading-relaxed text-ink-200">
          {negotiation.strategy}
        </p>

        {negotiation.status === "agreed" ? (
          <p className="rounded-lg border border-gain-500/25 bg-gain-500/5 px-3.5 py-2.5 text-sm text-gain-500">
            Saved {formatMoney(negotiation.realisedSaving, currency)} against
            the list price, against an expected{" "}
            {formatMoney(negotiation.expectedSaving, currency)}{" "}
            from the opening position.
          </p>
        ) : null}

        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
            Leverage used
          </h3>
          <ul className="mt-2 space-y-2">
            {negotiation.leverage.map((point) => (
              <li key={point.point} className="text-sm text-ink-300">
                <span className="font-medium text-ink-100">{point.point}</span>{" "}
                <Pill
                  tone={
                    point.strength === "strong"
                      ? "gain"
                      : point.strength === "moderate"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {point.strength}
                </Pill>
                <span className="mt-0.5 block text-xs text-ink-400">
                  {point.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
            Exchange
          </h3>
          <ol className="mt-2 space-y-2">
            {negotiation.transcript.map((message, index) => (
              <li
                key={index}
                className={`rounded-lg border px-3.5 py-2.5 ${
                  message.from === "procura"
                    ? "border-brand-500/25 bg-brand-500/5"
                    : "border-ink-700 bg-ink-800/40"
                }`}
              >
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  {message.from === "procura"
                    ? "Procura"
                    : negotiation.supplierName}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink-200">
                  {message.message}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Panel>
  );
}

export function PurchaseOrderPanel({
  po,
  request,
}: {
  po: PurchaseOrder;
  request: ProcurementRequest;
}) {
  return (
    <Panel>
      <PanelHeader
        title={`Purchase order ${po.poNumber}`}
        hint={`Issued to ${po.supplierName} · ${po.status}`}
        action={<Pill tone="brand">{po.status}</Pill>}
      />
      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <dl className="divide-y divide-ink-800">
          <KeyValue label="Supplier" mono>
            {po.supplierName}
          </KeyValue>
          <KeyValue label="Payment terms" mono>
            {po.paymentTerms}
          </KeyValue>
          <KeyValue label="Incoterms" mono>
            {po.incoterms}
          </KeyValue>
          <KeyValue label="Expected delivery" mono>
            {formatDate(po.expectedDelivery)}
          </KeyValue>
          <KeyValue label="Issued" mono>
            {po.issuedAt ? formatDate(po.issuedAt) : "—"}
          </KeyValue>
          <KeyValue label="Dispatched" mono>
            {po.dispatchedAt
              ? `${formatDate(po.dispatchedAt)} by ${po.dispatchChannel}`
              : "not yet sent to the supplier"}
          </KeyValue>
          <KeyValue label="Acknowledged" mono>
            {po.acknowledgedAt
              ? `${formatDate(po.acknowledgedAt)}${po.ackReference ? ` · ref ${po.ackReference}` : ""}`
              : "no confirmation from the supplier"}
          </KeyValue>
        </dl>
        <div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-ink-800">
              <tr>
                <td className="py-1.5 text-ink-400">Subtotal</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-ink-200">
                  {formatMoneyExact(po.subtotal, po.currency)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-ink-400">Shipping</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-ink-200">
                  {formatMoneyExact(po.shippingCost, po.currency)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-ink-400">VAT</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-ink-200">
                  {formatMoneyExact(po.taxAmount, po.currency)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 font-medium text-ink-100">Total</td>
                <td className="py-1.5 text-right font-mono tabular-nums font-semibold text-ink-100">
                  {formatMoneyExact(po.totalAmount, po.currency)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-xs text-ink-400">
            Line: {po.lineItems[0]?.description ?? request.title} ×{" "}
            {po.lineItems[0]?.quantity ?? request.quantity}
          </p>
          <p className="mt-1 text-xs text-ink-400">Ship to: {po.shipTo}</p>
        </div>
      </div>

      {/* Dispatch and acknowledgement are separate facts with separate
          timestamps, so each is its own form rather than one status field. */}
      {po.dispatchedAt === null ? (
        <form
          action={async (formData: FormData) => {
            "use server";
            await dispatchPurchaseOrderAction(
              request.id,
              String(formData.get("channel") ?? "email") as DispatchChannel,
            );
          }}
          className="flex flex-wrap items-end gap-3 border-t border-ink-700 px-5 py-4"
        >
          <div>
            <label className="text-xs font-medium text-ink-300">Channel</label>
            <select
              name="channel"
              defaultValue="email"
              className="mt-1.5 rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100"
            >
              <option value="email">Email</option>
              <option value="portal">Supplier portal</option>
              <option value="edi">EDI</option>
            </select>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400"
          >
            Dispatch to the supplier
          </button>
          <p className="text-xs text-ink-400">
            Records the moment the order left, and by which channel.
          </p>
        </form>
      ) : po.acknowledgedAt === null ? (
        <form
          action={async (formData: FormData) => {
            "use server";
            await acknowledgePurchaseOrderAction(
              request.id,
              String(formData.get("reference") ?? ""),
            );
          }}
          className="flex flex-wrap items-end gap-3 border-t border-ink-700 px-5 py-4"
        >
          <div className="min-w-64 flex-1">
            <label className="text-xs font-medium text-ink-300">
              Supplier acknowledgement reference
            </label>
            <input
              name="reference"
              placeholder="e.g. ACK-77120 or the supplier's order confirmation number"
              className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg border border-gain-500/40 px-4 py-2 text-sm font-medium text-gain-500 transition hover:bg-gain-500/10"
          >
            Record acknowledgement
          </button>
        </form>
      ) : null}
    </Panel>
  );
}

export function InvoicePanel({ invoice }: { invoice: Invoice }) {
  if (!invoice.match) return null;
  const { match } = invoice;

  const verdictTone =
    match.verdict === "approve"
      ? "border-gain-500/30 bg-gain-500/5 text-gain-500"
      : match.verdict === "query"
        ? "border-warn-500/30 bg-warn-500/5 text-warn-500"
        : "border-risk-500/30 bg-risk-500/5 text-risk-500";

  return (
    <Panel>
      <PanelHeader
        title="Three-way invoice match"
        hint={`Invoice ${invoice.invoiceNumber} against the purchase order`}
        action={
          <Pill
            tone={
              match.verdict === "approve"
                ? "gain"
                : match.verdict === "query"
                  ? "warn"
                  : "risk"
            }
          >
            {match.verdict}
          </Pill>
        }
      />
      <div className="space-y-4 p-5">
        <p className={`rounded-lg border px-3.5 py-2.5 text-sm ${verdictTone}`}>
          {match.summary}
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="py-2 pr-4 font-medium">Check</th>
                <th className="py-2 pr-4 font-medium">Expected</th>
                <th className="py-2 pr-4 font-medium">Found</th>
                <th className="py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {match.checks.map((check) => (
                <tr key={check.code}>
                  <td className="py-2.5 pr-4 align-top">
                    <span className="block font-medium text-ink-100">
                      {check.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-400">
                      {check.detail}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 align-top font-mono text-xs text-ink-300">
                    {check.expected}
                  </td>
                  <td className="py-2.5 pr-4 align-top font-mono text-xs text-ink-300">
                    {check.actual}
                  </td>
                  <td className="py-2.5 align-top">
                    <Pill
                      tone={
                        check.status === "pass"
                          ? "gain"
                          : check.status === "warn"
                            ? "warn"
                            : "risk"
                      }
                    >
                      {check.status}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-ink-400">
          Invoiced {formatMoneyExact(invoice.invoiceAmount, invoice.currency)} +
          VAT {formatMoneyExact(invoice.taxAmount, invoice.currency)}, received{" "}
          {formatDate(invoice.receivedDate)}.
        </p>
      </div>
    </Panel>
  );
}

export function RequestBriefPanel({
  request,
  spec,
}: {
  request: ProcurementRequest;
  spec: RequestSpec | null;
}) {
  return (
    <Panel>
      <PanelHeader
        title="What was asked for"
        hint={
          spec
            ? `Parsed by the Request Agent · ${Math.round(spec.completeness * 100)}% complete`
            : "Not yet parsed"
        }
      />
      <div className="space-y-4 p-5">
        <p className="text-sm leading-relaxed text-ink-200">
          {spec?.summary ?? "The Request Agent has not run for this request."}
        </p>

        <p className="rounded-lg border border-ink-700 bg-ink-800/40 px-3.5 py-2.5 text-sm text-ink-300">
          {request.rawDescription}
        </p>

        {spec ? (
          <div className="grid gap-5 sm:grid-cols-2">
            {spec.specifications.length > 0 ? (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
                  Specifications found
                </h3>
                <ul className="mt-2 space-y-1">
                  {spec.specifications.map((entry) => (
                    <li key={entry.label} className="text-sm text-ink-300">
                      <span className="text-ink-400">{entry.label}:</span>{" "}
                      <span className="font-mono">{entry.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
                  Required certifications
                </h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {spec.requiredCertifications.map((cert) => (
                    <Pill key={cert} tone="brand">
                      {cert}
                    </Pill>
                  ))}
                </div>
              </div>

              {spec.mustHave.length > 0 ? (
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
                    Must have
                  </h3>
                  <ul className="mt-2 space-y-1">
                    {spec.mustHave.map((item) => (
                      <li key={item} className="text-sm text-ink-300">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {spec.niceToHave.length > 0 ? (
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
                    Nice to have
                  </h3>
                  <ul className="mt-2 space-y-1">
                    {spec.niceToHave.map((item) => (
                      <li key={item} className="text-sm text-ink-300">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {spec && (spec.clarifications.length > 0 || spec.assumptions.length > 0) ? (
          <div className="grid gap-4 border-t border-ink-800 pt-4 sm:grid-cols-2">
            {spec.clarifications.length > 0 ? (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-warn-500">
                  Gaps flagged
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {spec.clarifications.map((item) => (
                    <li key={item} className="text-sm text-ink-300">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {spec.assumptions.length > 0 ? (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-ink-400">
                  Assumptions made
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {spec.assumptions.map((item) => (
                    <li key={item} className="text-sm text-ink-300">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <dl className="divide-y divide-ink-800 border-t border-ink-800 pt-2">
          <KeyValue label="Delivery requirement" mono>
            {spec?.deliveryRequirement ?? "—"}
          </KeyValue>
          <KeyValue label="Budget position" mono>
            {spec?.budgetSignal ?? "—"}
          </KeyValue>
        </dl>
      </div>
    </Panel>
  );
}

/**
 * The questions the pipeline stopped on. Answering them is what unblocks the
 * run, so the form and the resume action live in the same place rather than
 * the requester answering here and someone remembering to re-run elsewhere.
 */
export function ClarificationPanel({
  requestId,
  clarifications,
}: {
  requestId: string;
  clarifications: Clarification[];
}) {
  if (clarifications.length === 0) return null;
  const open = clarifications.filter((entry) => entry.status === "open");
  const answered = clarifications.filter((entry) => entry.status === "answered");

  return (
    <Panel>
      <PanelHeader
        title="Questions for the requester"
        hint={
          open.length > 0
            ? `${open.length} still open — sourcing resumes the moment they are answered`
            : "All answered; the pipeline carries on from where it stopped"
        }
        action={
          <Pill tone={open.length > 0 ? "warn" : "gain"}>
            {open.length > 0 ? "waiting" : "answered"}
          </Pill>
        }
      />
      <div className="space-y-4 p-5">
        {open.length > 0 ? (
          <form
            action={async (formData: FormData) => {
              "use server";
              const answers: Record<string, string> = {};
              for (const entry of open) {
                answers[entry.id] = String(formData.get(entry.id) ?? "");
              }
              await answerClarificationAction(requestId, answers);
            }}
            className="space-y-4"
          >
            {open.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-warn-500/25 bg-warn-500/5 p-3.5"
              >
                <label
                  htmlFor={entry.id}
                  className="text-sm font-medium text-ink-100"
                >
                  {entry.question}
                </label>
                {entry.detail ? (
                  <p className="mt-1 text-xs text-ink-400">{entry.detail}</p>
                ) : null}
                <input
                  id={entry.id}
                  name={entry.id}
                  placeholder="Your answer"
                  className="mt-2.5 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500"
                />
              </div>
            ))}
            <button
              type="submit"
              className="rounded-lg bg-warn-500 px-4 py-2 text-sm font-medium text-ink-950 transition hover:brightness-110"
            >
              Save answers and resume sourcing
            </button>
          </form>
        ) : null}

        {answered.length > 0 ? (
          <ul className="divide-y divide-ink-800 border-t border-ink-700 pt-3">
            {answered.map((entry) => (
              <li key={entry.id} className="py-2.5">
                <p className="text-xs text-ink-400">{entry.question}</p>
                <p className="mt-1 text-sm text-ink-200">{entry.answer}</p>
                <p className="mt-1 font-mono text-[10px] text-ink-500">
                  {entry.answeredBy ?? "unknown"}
                  {entry.answeredAt ? ` · ${formatDate(entry.answeredAt)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Who the RFQ went to through the supplier portal, with the link each supplier
 * opens. Collecting closes the window and drives the pipeline from the
 * comparison step onward.
 */
export function RfqPanel({
  requestId,
  status,
  invitations,
}: {
  requestId: string;
  status: ProcurementRequest["status"];
  invitations: RfqInvitation[];
}) {
  if (invitations.length === 0) return null;
  const collecting = status === "awaiting_quotes";

  return (
    <Panel>
      <PanelHeader
        title="Supplier portal quotations"
        hint={
          collecting
            ? "The RFQ is out; each supplier answers through its own link"
            : "The response window is closed"
        }
        action={
          <Pill tone={collecting ? "brand" : "gain"}>
            {collecting ? "collecting" : "closed"}
          </Pill>
        }
      />
      <div className="space-y-4 p-5">
        <ul className="divide-y divide-ink-800">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink-100">
                  {invitation.supplierName}
                </span>
                <Pill
                  tone={
                    invitation.status === "quoted"
                      ? "gain"
                      : invitation.status === "declined"
                        ? "risk"
                        : invitation.status === "expired"
                          ? "neutral"
                          : "warn"
                  }
                >
                  {invitation.status}
                </Pill>
                <span
                  className="ml-auto truncate font-mono text-[10px] text-ink-500"
                  title={`/portal?token=${invitation.token}`}
                >
                  /portal?token={invitation.token}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-400">
                invited {formatDate(invitation.invitedAt)} · closes{" "}
                {formatDate(invitation.expiresAt)}
                {invitation.respondedAt
                  ? ` · answered ${formatDate(invitation.respondedAt)}`
                  : ""}
              </p>
              {invitation.declineReason ? (
                <p className="mt-1 text-xs text-warn-500">
                  {invitation.declineReason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        {collecting ? (
          <form
            action={async () => {
              "use server";
              await collectRfqResponsesAction(requestId);
            }}
            className="flex flex-wrap items-center gap-3 border-t border-ink-700 pt-4"
          >
            <button
              type="submit"
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400"
            >
              Close the window and collect responses
            </button>
            <p className="text-xs text-ink-400">
              Every outstanding supplier answers as it would have, then the
              pipeline resumes from the comparison step. Nobody answered means
              the request is parked as blocked.
            </p>
          </form>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * What arrived against the purchase order. Without a receipt the invoice's
 * quantity check can only look at the order; with one it compares against what
 * a person signed for, which is the whole point of a three-way match.
 */
export function GoodsReceiptPanel({
  requestId,
  po,
  receipt,
}: {
  requestId: string;
  po: PurchaseOrder;
  receipt: GoodsReceipt | null;
}) {
  if (receipt) {
    return (
      <Panel>
        <PanelHeader
          title={`Goods receipt ${receipt.receiptNumber}`}
          hint={`Received by ${receipt.receivedBy} on ${formatDate(receipt.receivedDate)} · matched against ${po.poNumber}`}
          action={
            <Pill tone={receipt.status === "complete" ? "gain" : "warn"}>
              {receipt.status}
            </Pill>
          }
        />
        <div className="space-y-3 p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="py-2 pr-4 font-medium">Line</th>
                <th className="py-2 pr-4 text-right font-medium">Ordered</th>
                <th className="py-2 text-right font-medium">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {receipt.lines.map((line, index) => (
                <tr key={`${line.description}-${index}`}>
                  <td className="py-2 pr-4 text-ink-200">{line.description}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums text-ink-400">
                    {line.ordered} {line.unit}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-ink-100">
                    {line.received} {line.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {receipt.notes ? (
            <p className="text-xs text-ink-400">{receipt.notes}</p>
          ) : null}
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="Record the goods receipt"
        hint={`Against ${po.poNumber} — the invoice is matched to this, not just to the order`}
      />
      <form
        action={async (formData: FormData) => {
          "use server";
          const lines = po.lineItems.map((line, index) => ({
            description: line.description,
            ordered: line.quantity,
            received:
              Number.parseFloat(
                String(formData.get(`received_${index}`) ?? ""),
              ) || 0,
            unit: line.unit,
          }));
          await recordGoodsReceiptAction(requestId, {
            lines,
            notes: String(formData.get("notes") ?? ""),
            receivedDate: String(formData.get("receivedDate") ?? ""),
          });
        }}
        className="space-y-4 p-5"
      >
        <ul className="space-y-3">
          {po.lineItems.map((line, index) => (
            <li
              key={`${line.description}-${index}`}
              className="grid items-end gap-3 sm:grid-cols-[1fr_auto_auto]"
            >
              <div>
                <span className="block text-sm text-ink-200">
                  {line.description}
                </span>
                <span className="mt-0.5 block font-mono text-[11px] text-ink-500">
                  ordered {line.quantity} {line.unit} at{" "}
                  {formatMoneyExact(line.unitPrice, po.currency)}
                </span>
              </div>
              <div>
                <label
                  htmlFor={`received_${index}`}
                  className="text-xs font-medium text-ink-300"
                >
                  Received
                </label>
                <input
                  id={`received_${index}`}
                  name={`received_${index}`}
                  defaultValue={String(line.quantity)}
                  inputMode="decimal"
                  className="mt-1.5 w-28 rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-right font-mono text-sm text-ink-100"
                />
              </div>
              <span className="pb-2 text-xs text-ink-500">{line.unit}</span>
            </li>
          ))}
        </ul>

        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div>
            <label
              htmlFor="receivedDate"
              className="text-xs font-medium text-ink-300"
            >
              Date received
            </label>
            <input
              id="receivedDate"
              name="receivedDate"
              type="date"
              defaultValue={new Date().toISOString().slice(0, 10)}
              className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100"
            />
          </div>
          <div>
            <label
              htmlFor="notes"
              className="text-xs font-medium text-ink-300"
            >
              Notes
            </label>
            <input
              id="notes"
              name="notes"
              placeholder="e.g. two boxes damaged in transit, carrier notified"
              className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400"
          >
            Record the receipt
          </button>
          <p className="text-xs text-ink-400">
            Every line fully received marks the purchase order fulfilled; a
            short delivery stays partial.
          </p>
        </div>
      </form>
    </Panel>
  );
}

export function NoAgentsYet() {
  return (
    <Panel>
      <EmptyState>
        Sourcing has not been run for this request yet.
      </EmptyState>
    </Panel>
  );
}
