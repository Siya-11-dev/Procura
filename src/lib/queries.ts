import {
  getComparison,
  getGoodsReceipt,
  getInvoice,
  getNegotiation,
  getPurchaseOrder,
  getRequest,
  getRequestSpec,
  listAgentRuns,
  listApprovals,
  listClarifications,
  listQuotes,
  listRequests,
  listRfqInvitations,
  listRisk,
  listRiskExceptions,
  type RequestSpec,
  type RiskException,
} from "@/lib/db/repository";
import type {
  AgentRun,
  ApprovalStep,
  Clarification,
  Comparison,
  GoodsReceipt,
  Invoice,
  Negotiation,
  ProcurementRequest,
  PurchaseOrder,
  Quote,
  RfqInvitation,
  RiskAssessment,
} from "@/lib/domain/types";

export interface RequestBundle {
  request: ProcurementRequest;
  spec: RequestSpec | null;
  quotes: Quote[];
  comparison: Comparison | null;
  risks: RiskAssessment[];
  negotiation: Negotiation | null;
  approvals: ApprovalStep[];
  purchaseOrder: PurchaseOrder | null;
  invoice: Invoice | null;
  runs: AgentRun[];
  riskExceptions: RiskException[];
  pendingApproval: ApprovalStep | null;
  /** The questions the pipeline is waiting on, answered or not. */
  clarifications: Clarification[];
  /** Who the RFQ went to through the supplier portal, and how they replied. */
  rfqInvitations: RfqInvitation[];
  /** What physically arrived, when there is a receipt to match an invoice to. */
  goodsReceipt: GoodsReceipt | null;
}

export function getRequestBundle(id: string): RequestBundle | null {
  const request = getRequest(id);
  if (!request) return null;

  const approvals = listApprovals(id);

  return {
    request,
    spec: getRequestSpec(id),
    quotes: listQuotes(id),
    comparison: getComparison(id),
    risks: listRisk(id),
    negotiation: getNegotiation(id),
    approvals,
    purchaseOrder: getPurchaseOrder(id),
    invoice: getInvoice(id),
    runs: listAgentRuns(id),
    riskExceptions: listRiskExceptions(id),
    pendingApproval: approvals.find((step) => step.status === "pending") ?? null,
    clarifications: listClarifications(id),
    rfqInvitations: listRfqInvitations(id),
    goodsReceipt: getGoodsReceipt(id),
  };
}

export interface DashboardMetrics {
  totalRequests: number;
  inFlight: number;
  awaitingApproval: number;
  committedSpend: number;
  negotiationSavings: number;
  budgetSavings: number;
  quotesReceived: number;
  averageCycleMinutes: number;
  invoicesMatched: number;
  invoicesFlagged: number;
  currency: string;
}

export function getDashboardMetrics(): DashboardMetrics {
  const requests = listRequests();
  const committed = requests.filter((request) =>
    ["po_issued", "invoice_submitted", "closed"].includes(request.status),
  );

  const cycleTimes = requests
    .map((request) => {
      const bundle = getRequestBundle(request.id);
      if (!bundle || bundle.runs.length === 0) return null;
      const start = new Date(bundle.runs[0].startedAt).getTime();
      const end = new Date(bundle.runs[bundle.runs.length - 1].finishedAt).getTime();
      return (end - start) / 60_000;
    })
    .filter((value): value is number => value !== null && value >= 0);

  return {
    totalRequests: requests.length,
    inFlight: requests.filter((request) =>
      [
        "submitted",
        "needs_clarification",
        "sourcing",
        "awaiting_quotes",
        "awaiting_approval",
      ].includes(request.status),
    ).length,
    awaitingApproval: requests.filter(
      (request) => request.status === "awaiting_approval",
    ).length,
    committedSpend: committed.reduce(
      (total, request) => total + (getRequestBundle(request.id)?.purchaseOrder?.totalAmount ?? 0),
      0,
    ),
    negotiationSavings: requests.reduce(
      (total, request) =>
        total + (getRequestBundle(request.id)?.negotiation?.realisedSaving ?? 0),
      0,
    ),
    budgetSavings: requests.reduce(
      (total, request) =>
        total +
        Math.max(0, getRequestBundle(request.id)?.comparison?.savingsVsBudget ?? 0),
      0,
    ),
    quotesReceived: requests.reduce(
      (total, request) => total + (getRequestBundle(request.id)?.quotes.length ?? 0),
      0,
    ),
    averageCycleMinutes:
      cycleTimes.length === 0
        ? 0
        : cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length,
    invoicesMatched: requests.filter(
      (request) => request.status === "invoice_submitted",
    ).length,
    invoicesFlagged: requests.filter((request) => {
      const invoice = getRequestBundle(request.id)?.invoice;
      return invoice?.status === "discrepancies" || invoice?.status === "rejected";
    }).length,
    currency: "ZAR",
  };
}
