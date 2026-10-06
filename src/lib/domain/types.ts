export type Currency = "ZAR" | "USD" | "EUR" | "GBP";

export const CURRENCIES: Currency[] = ["ZAR", "USD", "EUR", "GBP"];

export type Urgency = "low" | "normal" | "high" | "critical";

export type RequestStatus =
  | "submitted"
  | "needs_clarification"
  | "sourcing"
  | "awaiting_quotes"
  | "awaiting_approval"
  | "approved"
  | "blocked"
  | "rejected"
  | "po_issued"
  | "invoice_submitted"
  | "closed"
  | "failed";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  submitted: "Submitted",
  needs_clarification: "Needs clarification",
  sourcing: "Agents working",
  awaiting_quotes: "Awaiting quotes",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  blocked: "Blocked by risk",
  rejected: "Rejected",
  po_issued: "PO issued",
  invoice_submitted: "Invoice matched",
  closed: "Closed",
  failed: "Failed",
};

export type Category =
  | "it-hardware"
  | "software"
  | "office-furniture"
  | "facilities"
  | "marketing"
  | "professional-services"
  | "logistics"
  | "lab-equipment"
  | "general";

export const CATEGORY_LABEL: Record<Category, string> = {
  "it-hardware": "IT hardware",
  software: "Software & licences",
  "office-furniture": "Office furniture",
  facilities: "Facilities",
  marketing: "Marketing & events",
  "professional-services": "Professional services",
  logistics: "Logistics",
  "lab-equipment": "Lab & equipment",
  general: "General",
};

export type FinancialHealth = "strong" | "stable" | "watch" | "distressed";

/** Result of the last sanctions screening. `null` means never screened. */
export type SanctionsResult = "clear" | "hit";

export interface Supplier {
  id: string;
  name: string;
  country: string;
  city: string | null;
  categories: Category[];
  certifications: string[];
  performanceRating: number;
  qualityScore: number;
  onTimeRate: number;
  responseRate: number;
  financialHealth: FinancialHealth;
  yearsInBusiness: number;
  currency: Currency;
  minOrderValue: number;
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  /** When the supplier was last screened against a sanctions list. */
  sanctionsCheckedAt: string | null;
  sanctionsResult: SanctionsResult | null;
  /** Broad-Based Black Economic Empowerment level, South African suppliers only. */
  bbbeeLevel: number | null;
  /** Expiry of the certificate backing `bbbeeLevel`. */
  bbbeeExpiry: string | null;
}

export type QuoteStatus = "received" | "selected" | "rejected";

export interface Quote {
  id: string;
  requestId: string;
  supplierId: string;
  unitPrice: number;
  currency: Currency;
  quantity: number;
  subtotal: number;
  shippingCost: number;
  taxRate: number;
  totalPrice: number;
  minimumOrderQty: number;
  leadTimeDays: number;
  paymentTerms: string;
  warrantyMonths: number;
  validityDays: number;
  priceBreaks: { minQty: number; unitPrice: number }[];
  incoterms: string;
  notes: string | null;
  status: QuoteStatus;
  receivedAt: string;
  declineReason: string | null;
}

export interface ComparisonWeights {
  price: number;
  quality: number;
  delivery: number;
  terms: number;
  supplier: number;
}

export interface ComparisonRow {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  country: string;
  totalPrice: number;
  unitPrice: number;
  leadTimeDays: number;
  paymentTerms: string;
  priceScore: number;
  qualityScore: number;
  deliveryScore: number;
  termsScore: number;
  supplierScore: number;
  totalScore: number;
  rank: number;
  pros: string[];
  cons: string[];
}

export interface Comparison {
  id: string;
  requestId: string;
  weights: ComparisonWeights;
  rows: ComparisonRow[];
  recommendedQuoteId: string | null;
  recommendedSupplierId: string | null;
  budgetAmount: number | null;
  savingsVsBudget: number | null;
  savingsPctVsBudget: number | null;
  savingsVsLowestBid: number;
  pricePremiumPct: number;
  rationale: string;
  tradeOffNote: string | null;
  createdAt: string;
}

export type RiskBand = "low" | "moderate" | "elevated" | "high";

export interface RiskFlag {
  code: string;
  label: string;
  severity: "info" | "warning" | "critical";
  detail: string;
}

export interface RiskAssessment {
  id: string;
  requestId: string;
  quoteId: string;
  supplierId: string;
  supplierName: string;
  overallScore: number;
  financialScore: number;
  deliveryScore: number;
  complianceScore: number;
  concentrationScore: number;
  band: RiskBand;
  flags: RiskFlag[];
  recommendation: string;
  isRecommended: boolean;
  createdAt: string;
}

export interface NegotiationLeverage {
  point: string;
  strength: "strong" | "moderate" | "weak";
  detail: string;
}

export interface NegotiationMessage {
  from: "procura" | "supplier";
  at: string;
  message: string;
}

export type NegotiationStatus =
  | "prepared"
  | "countered"
  | "agreed"
  | "unsuccessful";

export interface Negotiation {
  id: string;
  requestId: string;
  quoteId: string;
  supplierId: string;
  supplierName: string;
  listUnitPrice: number;
  openingUnitPrice: number;
  targetUnitPrice: number;
  walkawayUnitPrice: number;
  counterUnitPrice: number | null;
  agreedUnitPrice: number | null;
  expectedSaving: number;
  realisedSaving: number;
  leverage: NegotiationLeverage[];
  strategy: string;
  status: NegotiationStatus;
  transcript: NegotiationMessage[];
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "not_required";

export interface ApprovalStep {
  id: string;
  requestId: string;
  stepOrder: number;
  role: string;
  approverName: string;
  thresholdAmount: number;
  status: ApprovalStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  automated: boolean;
  createdAt: string;
}

export interface PurchaseOrderLine {
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

export type PoStatus = "draft" | "issued" | "acknowledged" | "fulfilled";

export type DispatchChannel = "email" | "portal" | "edi";

export interface PurchaseOrder {
  id: string;
  requestId: string;
  poNumber: string;
  quoteId: string;
  supplierId: string;
  supplierName: string;
  currency: Currency;
  subtotal: number;
  shippingCost: number;
  taxAmount: number;
  totalAmount: number;
  paymentTerms: string;
  incoterms: string;
  shipTo: string;
  lineItems: PurchaseOrderLine[];
  expectedDelivery: string;
  status: PoStatus;
  issuedAt: string | null;
  createdAt: string;
  /** When the PO was sent to the supplier. */
  dispatchedAt: string | null;
  dispatchChannel: DispatchChannel | null;
  /** When the supplier confirmed receipt of the PO. */
  acknowledgedAt: string | null;
  ackReference: string | null;
}

export type InvoiceStatus =
  | "submitted"
  | "matched"
  | "discrepancies"
  | "rejected";

export interface InvoiceCheck {
  code: string;
  label: string;
  status: "pass" | "fail" | "warn";
  expected: string;
  actual: string;
  detail: string;
}

export interface InvoiceMatch {
  verdict: "approve" | "query" | "reject";
  checks: InvoiceCheck[];
  varianceAmount: number;
  variancePct: number;
  summary: string;
}

export interface Invoice {
  id: string;
  requestId: string;
  poId: string;
  supplierId: string;
  invoiceNumber: string;
  currency: Currency;
  invoiceAmount: number;
  taxAmount: number;
  totalAmount: number;
  receivedDate: string;
  status: InvoiceStatus;
  match: InvoiceMatch | null;
  createdAt: string;
}

export type AgentStatus = "running" | "success" | "failed" | "skipped";

export interface AgentRun {
  id: string;
  requestId: string;
  agent: AgentName;
  step: number;
  label: string;
  status: AgentStatus;
  summary: string;
  detail: unknown;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

export interface ProcurementRequest {
  id: string;
  reference: string;
  title: string;
  rawDescription: string;
  requesterName: string;
  requesterDepartment: string;
  requesterEmail: string;
  category: Category | null;
  unit: string;
  quantity: number | null;
  currency: Currency;
  budgetAmount: number | null;
  neededBy: string | null;
  urgency: Urgency;
  status: RequestStatus;
  /** How quotes are collected: in-process simulation or the supplier portal. */
  quoteMode: QuoteMode;
  createdAt: string;
  updatedAt: string;
}

/** Quote collection strategy for a request. */
export type QuoteMode = "simulated" | "portal";

export const AGENT_NAMES = [
  "request",
  "supplier",
  "quote",
  "comparison",
  "risk",
  "negotiation",
  "approval",
  "po",
  "invoice",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_LABEL: Record<AgentName, string> = {
  request: "Request Agent",
  supplier: "Supplier Agent",
  quote: "Quote Agent",
  comparison: "Comparison Agent",
  risk: "Risk Agent",
  negotiation: "Negotiation Agent",
  approval: "Approval Agent",
  po: "PO Agent",
  invoice: "Invoice Agent",
};

export const AGENT_ROLE: Record<AgentName, string> = {
  request: "Understands what the employee needs",
  supplier: "Finds suitable suppliers",
  quote: "Requests and reads quotations",
  comparison: "Compares price, quality, terms and delivery",
  risk: "Checks supplier risk",
  negotiation: "Prepares negotiation recommendations",
  approval: "Routes the purchase",
  po: "Creates the purchase order",
  invoice: "Checks the invoice against the purchase order",
};

/* ---------------------------------------------------------- clarification loop
 *
 * A question the intake stage could not answer for itself. Blocking items hold
 * the pipeline at `needs_clarification` until a person replies; the rest are
 * informational and ride along in the spec for the approver to see.
 */
export type ClarificationStatus = "open" | "answered";

export interface Clarification {
  id: string;
  requestId: string;
  code: string;
  question: string;
  detail: string | null;
  status: ClarificationStatus;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
}

/* --------------------------------------------------- request for quotation flow
 *
 * One row per shortlisted supplier when a request is sourced through the supplier
 * portal. The token is the supplier's only credential, so it is unguessable and
 * sufficient on its own to open the invitation.
 */
export type RfqInvitationStatus =
  | "invited"
  | "viewed"
  | "quoted"
  | "declined"
  | "expired";

export interface RfqInvitation {
  id: string;
  requestId: string;
  supplierId: string;
  supplierName: string;
  token: string;
  status: RfqInvitationStatus;
  declineReason: string | null;
  quoteId: string | null;
  invitedAt: string;
  viewedAt: string | null;
  respondedAt: string | null;
  expiresAt: string;
}

/* --------------------------------------------------------- goods receipt note
 *
 * What physically arrived against a purchase order. The invoice agent matches
 * the invoice against this as well as the PO, which is what turns a two-way
 * match into a three-way one.
 */
export interface GoodsReceiptLine {
  description: string;
  ordered: number;
  received: number;
  unit: string;
}

export type GoodsReceiptStatus = "partial" | "complete";

export interface GoodsReceipt {
  id: string;
  requestId: string;
  poId: string;
  receiptNumber: string;
  receivedDate: string;
  receivedBy: string;
  lines: GoodsReceiptLine[];
  notes: string | null;
  status: GoodsReceiptStatus;
  createdAt: string;
}

/* ------------------------------------------------------------ budget controls */

export interface ApprovalAuthority {
  id: string;
  stepOrder: number;
  role: string;
  approverName: string;
  thresholdAmount: number;
  active: boolean;
  createdAt: string;
}

export interface Budget {
  id: string;
  department: string;
  category: Category | null;
  annualLimit: number;
  ownerName: string;
  createdAt: string;
}
