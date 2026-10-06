import type { SQLInputValue } from "node:sqlite";
import { getDb } from "./client";
import {
  AGENT_NAMES,
  type AgentName,
  type AgentRun,
  type AgentStatus,
  type ApprovalAuthority,
  type ApprovalStatus,
  type ApprovalStep,
  type Budget,
  type Category,
  type Clarification,
  type ClarificationStatus,
  type Comparison,
  type Currency,
  type DispatchChannel,
  type FinancialHealth,
  type GoodsReceipt,
  type GoodsReceiptLine,
  type GoodsReceiptStatus,
  type Invoice,
  type InvoiceStatus,
  type Negotiation,
  type NegotiationLeverage,
  type NegotiationMessage,
  type NegotiationStatus,
  type PoStatus,
  type ProcurementRequest,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Quote,
  type QuoteMode,
  type QuoteStatus,
  type RequestStatus,
  type RiskAssessment,
  type RiskBand,
  type RiskFlag,
  type RfqInvitation,
  type RfqInvitationStatus,
  type SanctionsResult,
  type Supplier,
  type Urgency,
} from "@/lib/domain/types";
import { newId, nowIso, parseJson } from "@/lib/util";

function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[];
}

function one<T>(sql: string, ...params: SQLInputValue[]): T | null {
  const row = getDb().prepare(sql).get(...params);
  return (row as unknown as T | undefined) ?? null;
}

function exec(sql: string, ...params: SQLInputValue[]): void {
  getDb().prepare(sql).run(...params);
}

/* ------------------------------------------------------------------ requests */

interface RequestRow {
  id: string;
  reference: string;
  title: string;
  raw_description: string;
  requester_name: string;
  requester_department: string;
  requester_email: string;
  category: string | null;
  unit: string;
  quantity: number | null;
  currency: string;
  budget_amount: number | null;
  needed_by: string | null;
  urgency: string;
  status: string;
  quote_mode: string;
  spec: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestSpec {
  summary: string;
  category: Category;
  unit: string;
  quantity: number;
  budgetAmount: number | null;
  neededBy: string | null;
  specifications: { label: string; value: string; required: boolean }[];
  requiredCertifications: string[];
  mustHave: string[];
  niceToHave: string[];
  deliveryRequirement: string;
  budgetSignal: string;
  urgency: Urgency;
  completeness: number;
  clarifications: string[];
  /**
   * Questions the intake stage could not resolve for itself. While any of these
   * remain open the pipeline holds at `needs_clarification`; older specs stored
   * before this field existed read back as an empty list.
   */
  blockingClarifications: string[];
  assumptions: string[];
  parsingMode: "rules" | "llm";
}

function toRequest(row: RequestRow): ProcurementRequest {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    rawDescription: row.raw_description,
    requesterName: row.requester_name,
    requesterDepartment: row.requester_department,
    requesterEmail: row.requester_email,
    category: row.category as Category | null,
    unit: row.unit,
    quantity: row.quantity,
    currency: row.currency as Currency,
    budgetAmount: row.budget_amount,
    neededBy: row.needed_by,
    urgency: row.urgency as Urgency,
    status: row.status as RequestStatus,
    quoteMode: row.quote_mode === "portal" ? "portal" : "simulated",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewRequest {
  title: string;
  rawDescription: string;
  requesterName: string;
  requesterDepartment: string;
  requesterEmail: string;
  unit: string;
  quantity: number | null;
  currency: Currency;
  budgetAmount: number | null;
  neededBy: string | null;
  urgency: Urgency;
  /** Defaults to in-process simulation; the portal invites suppliers instead. */
  quoteMode?: QuoteMode;
  /** Only set by the demo seeder, to make the simulated market reproducible. */
  id?: string;
}

export function nextReference(): string {
  const year = new Date().getUTCFullYear();
  const row = one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM requests WHERE reference LIKE ?",
    `REQ-${year}-%`,
  );
  const next = (row?.count ?? 0) + 1;
  return `REQ-${year}-${String(next).padStart(4, "0")}`;
}

export function createRequest(input: NewRequest): ProcurementRequest {
  // Seeded demo rows pass a fixed id so the whole simulated market response is
  // reproducible across a database reset. Live requests get a random id and so
  // are independent of each other.
  const id = input.id ?? newId("req");
  const ts = nowIso();
  exec(
    `INSERT INTO requests (
       id, reference, title, raw_description, requester_name, requester_department,
       requester_email, unit, quantity, currency, budget_amount, needed_by, urgency,
       status, quote_mode, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?)`,
    id,
    nextReference(),
    input.title.trim(),
    input.rawDescription.trim(),
    input.requesterName.trim(),
    input.requesterDepartment.trim(),
    input.requesterEmail.trim(),
    input.unit,
    input.quantity ?? null,
    input.currency,
    input.budgetAmount ?? null,
    input.neededBy ?? null,
    input.urgency ?? "normal",
    input.quoteMode ?? "simulated",
    ts,
    ts,
  );
  return getRequest(id)!;
}

export function getRequest(id: string): ProcurementRequest | null {
  const row = one<RequestRow>("SELECT * FROM requests WHERE id = ?", id);
  return row ? toRequest(row) : null;
}

export function listRequests(): ProcurementRequest[] {
  return all<RequestRow>(
    "SELECT * FROM requests ORDER BY created_at DESC",
  ).map(toRequest);
}

export function updateRequest(
  id: string,
  patch: Partial<
    Pick<
      ProcurementRequest,
      | "category"
      | "quantity"
      | "unit"
      | "status"
      | "urgency"
      | "neededBy"
      | "budgetAmount"
    >
  >,
): void {
  const assignments: string[] = [];
  const values: SQLInputValue[] = [];

  const push = (column: string, value: SQLInputValue) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.category !== undefined) push("category", patch.category);
  if (patch.quantity !== undefined) push("quantity", patch.quantity);
  if (patch.unit !== undefined) push("unit", patch.unit);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.urgency !== undefined) push("urgency", patch.urgency);
  if (patch.neededBy !== undefined) push("needed_by", patch.neededBy);
  if (patch.budgetAmount !== undefined) push("budget_amount", patch.budgetAmount);

  if (assignments.length === 0) return;

  exec(
    `UPDATE requests SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`,
    ...values,
    nowIso(),
    id,
  );
}

export function setRequestSpec(id: string, spec: RequestSpec): void {
  exec(
    "UPDATE requests SET spec = ?, category = ?, unit = ?, quantity = ?, urgency = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(spec),
    spec.category,
    spec.unit,
    spec.quantity,
    spec.urgency,
    nowIso(),
    id,
  );
}

export function getRequestSpec(id: string): RequestSpec | null {
  const row = one<{ spec: string | null }>(
    "SELECT spec FROM requests WHERE id = ?",
    id,
  );
  if (!row?.spec) return null;
  return parseJson<RequestSpec | null>(row.spec, null);
}

/* ----------------------------------------------------------------- suppliers */

interface SupplierRow {
  id: string;
  name: string;
  country: string;
  city: string | null;
  categories: string;
  certifications: string;
  performance_rating: number;
  quality_score: number;
  on_time_rate: number;
  response_rate: number;
  financial_health: string;
  years_in_business: number;
  currency: string;
  min_order_value: number;
  contact_name: string | null;
  contact_email: string | null;
  notes: string | null;
  sanctions_checked_at: string | null;
  sanctions_result: string | null;
  bbbee_level: number | null;
  bbbee_expiry: string | null;
}

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    city: row.city,
    categories: parseJson<Category[]>(row.categories, []),
    certifications: parseJson<string[]>(row.certifications, []),
    performanceRating: row.performance_rating,
    qualityScore: row.quality_score,
    onTimeRate: row.on_time_rate,
    responseRate: row.response_rate,
    financialHealth: row.financial_health as FinancialHealth,
    yearsInBusiness: row.years_in_business,
    currency: row.currency as Currency,
    minOrderValue: row.min_order_value,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    notes: row.notes,
    sanctionsCheckedAt: row.sanctions_checked_at,
    sanctionsResult: (row.sanctions_result as SanctionsResult | null) ?? null,
    bbbeeLevel: row.bbbee_level,
    bbbeeExpiry: row.bbbee_expiry,
  };
}

export function listSuppliers(): Supplier[] {
  return all<SupplierRow>("SELECT * FROM suppliers ORDER BY name").map(
    toSupplier,
  );
}

export function getSupplier(id: string): Supplier | null {
  const row = one<SupplierRow>("SELECT * FROM suppliers WHERE id = ?", id);
  return row ? toSupplier(row) : null;
}

export function insertSupplier(supplier: Omit<Supplier, "id"> & { id?: string }): void {
  exec(
    `INSERT INTO suppliers (
       id, name, country, city, categories, certifications, performance_rating,
       quality_score, on_time_rate, response_rate, financial_health, years_in_business,
       currency, min_order_value, contact_name, contact_email, notes,
       sanctions_checked_at, sanctions_result, bbbee_level, bbbee_expiry
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    supplier.id ?? newId("sup"),
    supplier.name,
    supplier.country,
    supplier.city,
    JSON.stringify(supplier.categories),
    JSON.stringify(supplier.certifications),
    supplier.performanceRating,
    supplier.qualityScore,
    supplier.onTimeRate,
    supplier.responseRate,
    supplier.financialHealth,
    supplier.yearsInBusiness,
    supplier.currency,
    supplier.minOrderValue,
    supplier.contactName,
    supplier.contactEmail,
    supplier.notes,
    supplier.sanctionsCheckedAt,
    supplier.sanctionsResult,
    supplier.bbbeeLevel,
    supplier.bbbeeExpiry,
  );
}

/**
 * Record the outcome of a screening run. Used after a sanctions check or a
 * B-BBEE certificate renewal, so the risk agent reads the current position
 * rather than the one the supplier was seeded with.
 */
export function updateSupplierCompliance(
  id: string,
  patch: {
    sanctionsCheckedAt?: string | null;
    sanctionsResult?: SanctionsResult | null;
    bbbeeLevel?: number | null;
    bbbeeExpiry?: string | null;
  },
): void {
  const assignments: string[] = [];
  const values: SQLInputValue[] = [];

  if (patch.sanctionsCheckedAt !== undefined) {
    assignments.push("sanctions_checked_at = ?");
    values.push(patch.sanctionsCheckedAt);
  }
  if (patch.sanctionsResult !== undefined) {
    assignments.push("sanctions_result = ?");
    values.push(patch.sanctionsResult);
  }
  if (patch.bbbeeLevel !== undefined) {
    assignments.push("bbbee_level = ?");
    values.push(patch.bbbeeLevel);
  }
  if (patch.bbbeeExpiry !== undefined) {
    assignments.push("bbbee_expiry = ?");
    values.push(patch.bbbeeExpiry);
  }

  if (assignments.length === 0) return;
  exec(`UPDATE suppliers SET ${assignments.join(", ")} WHERE id = ?`, ...values, id);
}

/* -------------------------------------------------------------------- quotes */

interface QuoteRow {
  id: string;
  request_id: string;
  supplier_id: string;
  unit_price: number;
  currency: string;
  quantity: number;
  subtotal: number;
  shipping_cost: number;
  tax_rate: number;
  total_price: number;
  minimum_order_qty: number;
  lead_time_days: number;
  payment_terms: string;
  warranty_months: number;
  validity_days: number;
  price_breaks: string;
  incoterms: string;
  notes: string | null;
  decline_reason: string | null;
  status: string;
  received_at: string;
}

function toQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    requestId: row.request_id,
    supplierId: row.supplier_id,
    unitPrice: row.unit_price,
    currency: row.currency as Currency,
    quantity: row.quantity,
    subtotal: row.subtotal,
    shippingCost: row.shipping_cost,
    taxRate: row.tax_rate,
    totalPrice: row.total_price,
    minimumOrderQty: row.minimum_order_qty,
    leadTimeDays: row.lead_time_days,
    paymentTerms: row.payment_terms,
    warrantyMonths: row.warranty_months,
    validityDays: row.validity_days,
    priceBreaks: parseJson<Quote["priceBreaks"]>(row.price_breaks, []),
    incoterms: row.incoterms,
    notes: row.notes,
    status: row.status as QuoteStatus,
    receivedAt: row.received_at,
    declineReason: row.decline_reason,
  };
}

export type NewQuote = Omit<Quote, "id"> & { declineReason: string | null };

export function insertQuote(quote: NewQuote): Quote {
  const id = newId("qte");
  exec(
    `INSERT INTO quotes (
       id, request_id, supplier_id, unit_price, currency, quantity, subtotal,
       shipping_cost, tax_rate, total_price, minimum_order_qty, lead_time_days,
       payment_terms, warranty_months, validity_days, price_breaks, incoterms,
       notes, decline_reason, status, received_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    quote.requestId,
    quote.supplierId,
    quote.unitPrice,
    quote.currency,
    quote.quantity,
    quote.subtotal,
    quote.shippingCost,
    quote.taxRate,
    quote.totalPrice,
    quote.minimumOrderQty,
    quote.leadTimeDays,
    quote.paymentTerms,
    quote.warrantyMonths,
    quote.validityDays,
    JSON.stringify(quote.priceBreaks),
    quote.incoterms,
    quote.notes,
    quote.declineReason,
    quote.status,
    quote.receivedAt,
  );
  return { ...quote, id };
}

export function listQuotes(requestId: string): Quote[] {
  return all<QuoteRow>(
    "SELECT * FROM quotes WHERE request_id = ? ORDER BY total_price ASC",
    requestId,
  ).map(toQuote);
}

export function getQuote(id: string): Quote | null {
  const row = one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id);
  return row ? toQuote(row) : null;
}

export function setQuoteStatus(id: string, status: QuoteStatus): void {
  exec("UPDATE quotes SET status = ? WHERE id = ?", status, id);
}

export function applyNegotiatedPrice(quoteId: string, unitPrice: number): void {
  const quote = getQuote(quoteId);
  if (!quote) return;
  const subtotal = unitPrice * quote.quantity;
  const totalPrice = subtotal + quote.shippingCost;
  exec(
    "UPDATE quotes SET unit_price = ?, subtotal = ?, total_price = ? WHERE id = ?",
    unitPrice,
    subtotal,
    totalPrice,
    quoteId,
  );
}

export function deleteQuotes(requestId: string): void {
  exec("DELETE FROM quotes WHERE request_id = ?", requestId);
}

/* --------------------------------------------------------------- comparisons */

interface ComparisonRowDb {
  id: string;
  request_id: string;
  weights: string;
  rows: string;
  recommended_quote_id: string | null;
  recommended_supplier_id: string | null;
  budget_amount: number | null;
  savings_vs_budget: number | null;
  savings_pct_vs_budget: number | null;
  savings_vs_lowest_bid: number;
  price_premium_pct: number;
  rationale: string;
  trade_off_note: string | null;
  created_at: string;
}

function toComparison(row: ComparisonRowDb): Comparison {
  return {
    id: row.id,
    requestId: row.request_id,
    weights: parseJson<Comparison["weights"]>(row.weights, {
      price: 0.35,
      quality: 0.2,
      delivery: 0.2,
      terms: 0.15,
      supplier: 0.1,
    }),
    rows: parseJson<Comparison["rows"]>(row.rows, []),
    recommendedQuoteId: row.recommended_quote_id,
    recommendedSupplierId: row.recommended_supplier_id,
    budgetAmount: row.budget_amount,
    savingsVsBudget: row.savings_vs_budget,
    savingsPctVsBudget: row.savings_pct_vs_budget,
    savingsVsLowestBid: row.savings_vs_lowest_bid,
    pricePremiumPct: row.price_premium_pct,
    rationale: row.rationale,
    tradeOffNote: row.trade_off_note,
    createdAt: row.created_at,
  };
}

export function upsertComparison(
  comparison: Omit<Comparison, "id" | "createdAt">,
): Comparison {
  exec("DELETE FROM comparisons WHERE request_id = ?", comparison.requestId);
  exec(
    `INSERT INTO comparisons (
       id, request_id, weights, rows, recommended_quote_id, recommended_supplier_id,
       budget_amount, savings_vs_budget, savings_pct_vs_budget, savings_vs_lowest_bid,
       price_premium_pct, rationale, trade_off_note, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("cmp"),
    comparison.requestId,
    JSON.stringify(comparison.weights),
    JSON.stringify(comparison.rows),
    comparison.recommendedQuoteId,
    comparison.recommendedSupplierId,
    comparison.budgetAmount,
    comparison.savingsVsBudget,
    comparison.savingsPctVsBudget,
    comparison.savingsVsLowestBid,
    comparison.pricePremiumPct,
    comparison.rationale,
    comparison.tradeOffNote,
    nowIso(),
  );
  return getComparison(comparison.requestId)!;
}

export function getComparison(requestId: string): Comparison | null {
  const row = one<ComparisonRowDb>(
    "SELECT * FROM comparisons WHERE request_id = ?",
    requestId,
  );
  return row ? toComparison(row) : null;
}

export function deleteComparison(requestId: string): void {
  exec("DELETE FROM comparisons WHERE request_id = ?", requestId);
}

/* --------------------------------------------------------------------- risk */

interface RiskRowDb {
  id: string;
  request_id: string;
  quote_id: string;
  supplier_id: string;
  overall_score: number;
  financial_score: number;
  delivery_score: number;
  compliance_score: number;
  concentration_score: number;
  band: string;
  flags: string;
  recommendation: string;
  is_recommended: number;
  created_at: string;
}

function toRisk(row: RiskRowDb, supplierName: string): RiskAssessment {
  return {
    id: row.id,
    requestId: row.request_id,
    quoteId: row.quote_id,
    supplierId: row.supplier_id,
    supplierName,
    overallScore: row.overall_score,
    financialScore: row.financial_score,
    deliveryScore: row.delivery_score,
    complianceScore: row.compliance_score,
    concentrationScore: row.concentration_score,
    band: row.band as RiskBand,
    flags: parseJson<RiskFlag[]>(row.flags, []),
    recommendation: row.recommendation,
    isRecommended: row.is_recommended === 1,
    createdAt: row.created_at,
  };
}

export type NewRiskAssessment = Omit<
  RiskAssessment,
  "id" | "createdAt" | "supplierName"
>;

export function insertRisk(assessment: NewRiskAssessment): void {
  exec(
    `INSERT INTO risk_assessments (
       id, request_id, quote_id, supplier_id, overall_score, financial_score,
       delivery_score, compliance_score, concentration_score, band, flags,
       recommendation, is_recommended, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("rsk"),
    assessment.requestId,
    assessment.quoteId,
    assessment.supplierId,
    assessment.overallScore,
    assessment.financialScore,
    assessment.deliveryScore,
    assessment.complianceScore,
    assessment.concentrationScore,
    assessment.band,
    JSON.stringify(assessment.flags),
    assessment.recommendation,
    assessment.isRecommended ? 1 : 0,
    nowIso(),
  );
}

export function listRisk(requestId: string): RiskAssessment[] {
  return all<RiskRowDb & { name: string }>(
    `SELECT r.*, s.name AS name
       FROM risk_assessments r
       JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.request_id = ?
      ORDER BY r.overall_score DESC`,
    requestId,
  ).map((row) => toRisk(row, row.name));
}

export interface RiskException {
  id: string;
  requestId: string;
  flagCode: string;
  justification: string;
  approverName: string;
  createdAt: string;
}

export function insertRiskException(input: {
  requestId: string;
  flagCode: string;
  justification: string;
  approverName: string;
}): void {
  exec(
    `INSERT INTO risk_exceptions (id, request_id, flag_code, justification, approver_name, created_at)
     VALUES (?,?,?,?,?,?)`,
    newId("rxe"),
    input.requestId,
    input.flagCode,
    input.justification,
    input.approverName,
    nowIso(),
  );
}

export function deleteRiskException(requestId: string, flagCode: string): void {
  exec(
    "DELETE FROM risk_exceptions WHERE request_id = ? AND flag_code = ?",
    requestId,
    flagCode,
  );
}

export function listRiskExceptions(requestId: string): RiskException[] {
  return all<{
    id: string;
    request_id: string;
    flag_code: string;
    justification: string;
    approver_name: string;
    created_at: string;
  }>(
    "SELECT * FROM risk_exceptions WHERE request_id = ? ORDER BY created_at",
    requestId,
  ).map((row) => ({
    id: row.id,
    requestId: row.request_id,
    flagCode: row.flag_code,
    justification: row.justification,
    approverName: row.approver_name,
    createdAt: row.created_at,
  }));
}

export function deleteRisk(requestId: string): void {
  exec("DELETE FROM risk_assessments WHERE request_id = ?", requestId);
}

/* -------------------------------------------------------------- negotiations */

interface NegotiationRowDb {
  id: string;
  request_id: string;
  quote_id: string;
  supplier_id: string;
  list_unit_price: number;
  opening_unit_price: number;
  target_unit_price: number;
  walkaway_unit_price: number;
  counter_unit_price: number | null;
  agreed_unit_price: number | null;
  expected_saving: number;
  realised_saving: number;
  leverage: string;
  strategy: string;
  status: string;
  transcript: string;
  created_at: string;
  updated_at: string;
}

function toNegotiation(row: NegotiationRowDb, supplierName: string): Negotiation {
  return {
    id: row.id,
    requestId: row.request_id,
    quoteId: row.quote_id,
    supplierId: row.supplier_id,
    supplierName,
    listUnitPrice: row.list_unit_price,
    openingUnitPrice: row.opening_unit_price,
    targetUnitPrice: row.target_unit_price,
    walkawayUnitPrice: row.walkaway_unit_price,
    counterUnitPrice: row.counter_unit_price,
    agreedUnitPrice: row.agreed_unit_price,
    expectedSaving: row.expected_saving,
    realisedSaving: row.realised_saving,
    leverage: parseJson<NegotiationLeverage[]>(row.leverage, []),
    strategy: row.strategy,
    status: row.status as NegotiationStatus,
    transcript: parseJson<NegotiationMessage[]>(row.transcript, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertNegotiation(
  negotiation: Omit<Negotiation, "id" | "createdAt" | "updatedAt">,
): Negotiation {
  exec("DELETE FROM negotiations WHERE request_id = ?", negotiation.requestId);
  exec(
    `INSERT INTO negotiations (
       id, request_id, quote_id, supplier_id, list_unit_price, opening_unit_price,
       target_unit_price, walkaway_unit_price, counter_unit_price, agreed_unit_price,
       expected_saving, realised_saving, leverage, strategy, status, transcript,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("neg"),
    negotiation.requestId,
    negotiation.quoteId,
    negotiation.supplierId,
    negotiation.listUnitPrice,
    negotiation.openingUnitPrice,
    negotiation.targetUnitPrice,
    negotiation.walkawayUnitPrice,
    negotiation.counterUnitPrice,
    negotiation.agreedUnitPrice,
    negotiation.expectedSaving,
    negotiation.realisedSaving,
    JSON.stringify(negotiation.leverage),
    negotiation.strategy,
    negotiation.status,
    JSON.stringify(negotiation.transcript),
    nowIso(),
    nowIso(),
  );
  return getNegotiation(negotiation.requestId)!;
}

export function getNegotiation(requestId: string): Negotiation | null {
  const row = one<NegotiationRowDb & { name: string }>(
    `SELECT n.*, s.name AS name
       FROM negotiations n
       JOIN suppliers s ON s.id = n.supplier_id
      WHERE n.request_id = ?`,
    requestId,
  );
  return row ? toNegotiation(row, row.name) : null;
}

export function deleteNegotiation(requestId: string): void {
  exec("DELETE FROM negotiations WHERE request_id = ?", requestId);
}

/* ----------------------------------------------------------------- approvals */

interface ApprovalRowDb {
  id: string;
  request_id: string;
  step_order: number;
  role: string;
  approver_name: string;
  threshold_amount: number;
  status: string;
  decision_note: string | null;
  decided_at: string | null;
  automated: number;
  created_at: string;
}

function toApproval(row: ApprovalRowDb): ApprovalStep {
  return {
    id: row.id,
    requestId: row.request_id,
    stepOrder: row.step_order,
    role: row.role,
    approverName: row.approver_name,
    thresholdAmount: row.threshold_amount,
    status: row.status as ApprovalStatus,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    automated: row.automated === 1,
    createdAt: row.created_at,
  };
}

export type NewApprovalStep = Omit<ApprovalStep, "id" | "createdAt">;

export function insertApprovalStep(
  step: NewApprovalStep,
): ApprovalStep {
  const id = newId("apr");
  exec(
    `INSERT INTO approvals (
       id, request_id, step_order, role, approver_name, threshold_amount, status,
       decision_note, decided_at, automated, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    step.requestId,
    step.stepOrder,
    step.role,
    step.approverName,
    step.thresholdAmount,
    step.status,
    step.decisionNote,
    step.decidedAt,
    step.automated ? 1 : 0,
    nowIso(),
  );
  return { ...step, id, createdAt: nowIso() };
}

export function listApprovals(requestId: string): ApprovalStep[] {
  return all<ApprovalRowDb>(
    "SELECT * FROM approvals WHERE request_id = ? ORDER BY step_order",
    requestId,
  ).map(toApproval);
}

export function getApprovalStep(
  requestId: string,
  stepId: string,
): ApprovalStep | null {
  const row = one<ApprovalRowDb>(
    "SELECT * FROM approvals WHERE id = ? AND request_id = ?",
    stepId,
    requestId,
  );
  return row ? toApproval(row) : null;
}

export function updateApprovalStep(
  id: string,
  patch: { status: ApprovalStatus; decisionNote: string | null },
): void {
  exec(
    "UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?",
    patch.status,
    patch.decisionNote,
    patch.status === "pending" ? null : nowIso(),
    id,
  );
}

export function deleteAgentRuns(requestId: string): void {
  exec("DELETE FROM agent_runs WHERE request_id = ?", requestId);
}

export function deleteApprovals(requestId: string): void {
  exec("DELETE FROM approvals WHERE request_id = ?", requestId);
}

/* ----------------------------------------------------------- purchase orders */

interface PoRowDb {
  id: string;
  request_id: string;
  po_number: string;
  quote_id: string;
  supplier_id: string;
  currency: string;
  subtotal: number;
  shipping_cost: number;
  tax_amount: number;
  total_amount: number;
  payment_terms: string;
  incoterms: string;
  ship_to: string;
  line_items: string;
  expected_delivery: string;
  status: string;
  issued_at: string | null;
  dispatched_at: string | null;
  dispatch_channel: string | null;
  acknowledged_at: string | null;
  ack_reference: string | null;
  created_at: string;
}

function toPo(row: PoRowDb, supplierName: string): PurchaseOrder {
  return {
    id: row.id,
    requestId: row.request_id,
    poNumber: row.po_number,
    quoteId: row.quote_id,
    supplierId: row.supplier_id,
    supplierName,
    currency: row.currency as Currency,
    subtotal: row.subtotal,
    shippingCost: row.shipping_cost,
    taxAmount: row.tax_amount,
    totalAmount: row.total_amount,
    paymentTerms: row.payment_terms,
    incoterms: row.incoterms,
    shipTo: row.ship_to,
    lineItems: parseJson<PurchaseOrderLine[]>(row.line_items, []),
    expectedDelivery: row.expected_delivery,
    status: row.status as PoStatus,
    issuedAt: row.issued_at,
    dispatchedAt: row.dispatched_at,
    dispatchChannel: (row.dispatch_channel as DispatchChannel | null) ?? null,
    acknowledgedAt: row.acknowledged_at,
    ackReference: row.ack_reference,
    createdAt: row.created_at,
  };
}

export function insertPurchaseOrder(
  po: Omit<PurchaseOrder, "id" | "createdAt" | "dispatchedAt" | "dispatchChannel" | "acknowledgedAt" | "ackReference">,
): PurchaseOrder {
  exec(
    `INSERT INTO purchase_orders (
       id, request_id, po_number, quote_id, supplier_id, currency, subtotal,
       shipping_cost, tax_amount, total_amount, payment_terms, incoterms, ship_to,
       line_items, expected_delivery, status, issued_at, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("po"),
    po.requestId,
    po.poNumber,
    po.quoteId,
    po.supplierId,
    po.currency,
    po.subtotal,
    po.shippingCost,
    po.taxAmount,
    po.totalAmount,
    po.paymentTerms,
    po.incoterms,
    po.shipTo,
    JSON.stringify(po.lineItems),
    po.expectedDelivery,
    po.status,
    po.issuedAt,
    nowIso(),
  );
  return getPurchaseOrder(po.requestId)!;
}

/**
 * Record that the purchase order reached the supplier, or that the supplier
 * confirmed it. Dispatch and acknowledgement are separate facts with separate
 * timestamps, so they are written as one patch rather than inferred from status.
 */
export function updatePurchaseOrderDispatch(
  requestId: string,
  patch: {
    dispatchedAt?: string;
    dispatchChannel?: DispatchChannel;
    acknowledgedAt?: string;
    ackReference?: string | null;
    status?: PoStatus;
  },
): void {
  const assignments: string[] = [];
  const values: SQLInputValue[] = [];

  if (patch.dispatchedAt !== undefined) {
    assignments.push("dispatched_at = ?");
    values.push(patch.dispatchedAt);
  }
  if (patch.dispatchChannel !== undefined) {
    assignments.push("dispatch_channel = ?");
    values.push(patch.dispatchChannel);
  }
  if (patch.acknowledgedAt !== undefined) {
    assignments.push("acknowledged_at = ?");
    values.push(patch.acknowledgedAt);
  }
  if (patch.ackReference !== undefined) {
    assignments.push("ack_reference = ?");
    values.push(patch.ackReference);
  }
  if (patch.status !== undefined) {
    assignments.push("status = ?");
    values.push(patch.status);
  }

  if (assignments.length === 0) return;
  exec(
    `UPDATE purchase_orders SET ${assignments.join(", ")} WHERE request_id = ?`,
    ...values,
    requestId,
  );
}

export function getPurchaseOrder(requestId: string): PurchaseOrder | null {
  const row = one<PoRowDb & { name: string }>(
    `SELECT p.*, s.name AS name
       FROM purchase_orders p
       JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.request_id = ?`,
    requestId,
  );
  return row ? toPo(row, row.name) : null;
}

export function nextPoNumber(): string {
  const year = new Date().getUTCFullYear();
  const row = one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM purchase_orders WHERE po_number LIKE ?",
    `PO-${year}-%`,
  );
  return `PO-${year}-${String((row?.count ?? 0) + 1).padStart(4, "0")}`;
}

export function deletePurchaseOrders(requestId: string): void {
  exec("DELETE FROM purchase_orders WHERE request_id = ?", requestId);
}

/* ----------------------------------------------------------------- invoices */

interface InvoiceRowDb {
  id: string;
  request_id: string;
  po_id: string;
  supplier_id: string;
  invoice_number: string;
  currency: string;
  invoice_amount: number;
  tax_amount: number;
  total_amount: number;
  received_date: string;
  status: string;
  match: string | null;
  created_at: string;
}

function toInvoice(row: InvoiceRowDb): Invoice {
  return {
    id: row.id,
    requestId: row.request_id,
    poId: row.po_id,
    supplierId: row.supplier_id,
    invoiceNumber: row.invoice_number,
    currency: row.currency as Currency,
    invoiceAmount: row.invoice_amount,
    taxAmount: row.tax_amount,
    totalAmount: row.total_amount,
    receivedDate: row.received_date,
    status: row.status as InvoiceStatus,
    match: parseJson<Invoice["match"]>(row.match, null),
    createdAt: row.created_at,
  };
}

export function insertInvoice(
  invoice: Omit<Invoice, "id" | "createdAt">,
): Invoice {
  exec(
    `INSERT INTO invoices (
       id, request_id, po_id, supplier_id, invoice_number, currency, invoice_amount,
       tax_amount, total_amount, received_date, status, match, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("inv"),
    invoice.requestId,
    invoice.poId,
    invoice.supplierId,
    invoice.invoiceNumber,
    invoice.currency,
    invoice.invoiceAmount,
    invoice.taxAmount,
    invoice.totalAmount,
    invoice.receivedDate,
    invoice.status,
    invoice.match ? JSON.stringify(invoice.match) : null,
    nowIso(),
  );
  return getInvoice(invoice.requestId)!;
}

export function getInvoice(requestId: string): Invoice | null {
  const row = one<InvoiceRowDb>(
    "SELECT * FROM invoices WHERE request_id = ? ORDER BY created_at DESC",
    requestId,
  );
  return row ? toInvoice(row) : null;
}

export function findInvoiceByNumber(
  invoiceNumber: string,
  excludeRequestId: string,
): Invoice | null {
  const row = one<InvoiceRowDb>(
    "SELECT * FROM invoices WHERE invoice_number = ? AND request_id != ? LIMIT 1",
    invoiceNumber,
    excludeRequestId,
  );
  return row ? toInvoice(row) : null;
}

export function updateInvoice(
  id: string,
  patch: { status: InvoiceStatus; match: Invoice["match"] },
): void {
  exec(
    "UPDATE invoices SET status = ?, match = ? WHERE id = ?",
    patch.status,
    patch.match ? JSON.stringify(patch.match) : null,
    id,
  );
}

export function deleteInvoices(requestId: string): void {
  exec("DELETE FROM invoices WHERE request_id = ?", requestId);
}

/* --------------------------------------------------------------- agent runs */

interface AgentRunRow {
  id: string;
  request_id: string;
  agent: string;
  step: number;
  label: string;
  status: string;
  summary: string;
  detail: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    requestId: row.request_id,
    agent: (AGENT_NAMES as readonly string[]).includes(row.agent)
      ? (row.agent as AgentName)
      : "request",
    step: row.step,
    label: row.label,
    status: row.status as AgentStatus,
    summary: row.summary,
    detail: parseJson<unknown>(row.detail, {}),
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function recordAgentRun(run: Omit<AgentRun, "id">): void {
  exec(
    `INSERT INTO agent_runs (
       id, request_id, agent, step, label, status, summary, detail, duration_ms,
       started_at, finished_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    newId("run"),
    run.requestId,
    run.agent,
    run.step,
    run.label,
    run.status,
    run.summary,
    JSON.stringify(run.detail ?? {}),
    run.durationMs,
    run.startedAt,
    run.finishedAt,
  );
}

export function listAgentRuns(requestId: string): AgentRun[] {
  return all<AgentRunRow>(
    "SELECT * FROM agent_runs WHERE request_id = ? ORDER BY step, started_at",
    requestId,
  ).map(toAgentRun);
}

export function clearAgentRunsFrom(
  requestId: string,
  agent: AgentName,
): void {
  exec(
    "DELETE FROM agent_runs WHERE request_id = ? AND agent = ?",
    requestId,
    agent,
  );
}

/* ------------------------------------------------------- request documents */

export interface RequestDocument {
  id: string;
  requestId: string;
  originalName: string;
  storedName: string;
  extension: string;
  byteSize: number;
  sha256: string;
  contentType: string | null;
  extractStatus: "read" | "not_read";
  extractReason: string | null;
  charCount: number | null;
  uploadedBy: string;
  uploadedAt: string;
}

interface RequestDocumentRow {
  id: string;
  request_id: string;
  original_name: string;
  stored_name: string;
  extension: string;
  byte_size: number;
  sha256: string;
  content_type: string | null;
  extract_status: "read" | "not_read";
  extract_reason: string | null;
  extracted_text: string | null;
  char_count: number | null;
  uploaded_by: string;
  uploaded_at: string;
}

function toRequestDocument(row: RequestDocumentRow): RequestDocument {
  return {
    id: row.id,
    requestId: row.request_id,
    originalName: row.original_name,
    storedName: row.stored_name,
    extension: row.extension,
    byteSize: row.byte_size,
    sha256: row.sha256,
    contentType: row.content_type,
    extractStatus: row.extract_status,
    extractReason: row.extract_reason,
    charCount: row.char_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

export interface StoredDocumentRow {
  id: string;
  originalName: string;
  storedName: string;
  extension: string;
  byteSize: number;
  sha256: string;
  contentType: string | null;
  extractStatus: "read" | "not_read";
  extractReason: string | null;
  extractedText: string | null;
  charCount: number | null;
  uploadedBy: string;
  uploadedAt: string;
}

export function insertRequestDocument(
  requestId: string,
  document: StoredDocumentRow,
): void {
  exec(
    `INSERT INTO request_documents (
       id, request_id, original_name, stored_name, extension, byte_size, sha256,
       content_type, extract_status, extract_reason, extracted_text, char_count,
       uploaded_by, uploaded_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    document.id,
    requestId,
    document.originalName,
    document.storedName,
    document.extension,
    document.byteSize,
    document.sha256,
    document.contentType,
    document.extractStatus,
    document.extractReason,
    document.extractedText,
    document.charCount,
    document.uploadedBy,
    document.uploadedAt,
  );
}

export function listRequestDocuments(requestId: string): RequestDocument[] {
  return all<RequestDocumentRow>(
    "SELECT * FROM request_documents WHERE request_id = ? ORDER BY uploaded_at, id",
    requestId,
  ).map(toRequestDocument);
}

export function countRequestDocuments(requestId: string): number {
  const row = one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM request_documents WHERE request_id = ?",
    requestId,
  );
  return row?.count ?? 0;
}

/**
 * The text the Request Agent reads, in upload order, each document labelled so
 * a figure can be traced back to the file it came from. Only documents marked
 * 'read' contribute; anything else was stored as evidence but never parsed, and
 * silently feeding it in would misrepresent what the agents actually saw.
 */
export function readableDocumentCorpus(requestId: string): {
  corpus: string;
  readCount: number;
  unreadCount: number;
} {
  const rows = all<RequestDocumentRow>(
    `SELECT * FROM request_documents
      WHERE request_id = ? AND extract_status = 'read' AND extracted_text IS NOT NULL
      ORDER BY uploaded_at, id`,
    requestId,
  );

  const unread = one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM request_documents
      WHERE request_id = ? AND extract_status <> 'read'`,
    requestId,
  )?.count ?? 0;

  const corpus = rows
    .map((row) => `--- attachment: ${row.original_name} ---\n${row.extracted_text}`)
    .join("\n\n");

  return { corpus, readCount: rows.length, unreadCount: unread };
}

/* ------------------------------------------------------------- clarifications */

interface ClarificationRow {
  id: string;
  request_id: string;
  code: string;
  question: string;
  detail: string | null;
  status: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
}

function toClarification(row: ClarificationRow): Clarification {
  return {
    id: row.id,
    requestId: row.request_id,
    code: row.code,
    question: row.question,
    detail: row.detail,
    status: row.status as ClarificationStatus,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    createdAt: row.created_at,
  };
}

/**
 * Raise a blocking question, unless the same code already exists for this
 * request. INSERT OR IGNORE is what lets a rerun re-assert the question without
 * overwriting an answer the requester has already given.
 */
export function insertClarification(input: {
  requestId: string;
  code: string;
  question: string;
  detail?: string | null;
}): void {
  exec(
    `INSERT OR IGNORE INTO clarifications (
       id, request_id, code, question, detail, status, created_at
     ) VALUES (?,?,?,?,?, 'open', ?)`,
    newId("clq"),
    input.requestId,
    input.code,
    input.question,
    input.detail ?? null,
    nowIso(),
  );
}

export function listClarifications(requestId: string): Clarification[] {
  return all<ClarificationRow>(
    "SELECT * FROM clarifications WHERE request_id = ? ORDER BY created_at, code",
    requestId,
  ).map(toClarification);
}

export function listOpenClarifications(requestId: string): Clarification[] {
  return all<ClarificationRow>(
    "SELECT * FROM clarifications WHERE request_id = ? AND status = 'open' ORDER BY created_at, code",
    requestId,
  ).map(toClarification);
}

export function answerClarification(input: {
  id: string;
  requestId: string;
  answer: string;
  answeredBy: string;
}): boolean {
  const result = getDb()
    .prepare(
      `UPDATE clarifications
          SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?
        WHERE id = ? AND request_id = ? AND status = 'open'`,
    )
    .run(input.answer, input.answeredBy, nowIso(), input.id, input.requestId);
  return Number(result.changes) > 0;
}

/* ---------------------------------------------------------- RFQ invitations */

interface RfqInvitationRow {
  id: string;
  request_id: string;
  supplier_id: string;
  token: string;
  status: string;
  decline_reason: string | null;
  quote_id: string | null;
  invited_at: string;
  viewed_at: string | null;
  responded_at: string | null;
  expires_at: string;
}

function toRfqInvitation(
  row: RfqInvitationRow & { supplier_name: string },
): RfqInvitation {
  return {
    id: row.id,
    requestId: row.request_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    token: row.token,
    status: row.status as RfqInvitationStatus,
    declineReason: row.decline_reason,
    quoteId: row.quote_id,
    invitedAt: row.invited_at,
    viewedAt: row.viewed_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at,
  };
}

export function insertRfqInvitation(input: {
  requestId: string;
  supplierId: string;
  token: string;
  expiresAt: string;
}): void {
  exec(
    `INSERT INTO rfq_invitations (
       id, request_id, supplier_id, token, status, invited_at, expires_at
     ) VALUES (?,?,?,?, 'invited', ?, ?)`,
    newId("rfq"),
    input.requestId,
    input.supplierId,
    input.token,
    nowIso(),
    input.expiresAt,
  );
}

export function listRfqInvitations(requestId: string): RfqInvitation[] {
  return all<RfqInvitationRow & { supplier_name: string }>(
    `SELECT i.*, s.name AS supplier_name
       FROM rfq_invitations i
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.request_id = ?
      ORDER BY s.name`,
    requestId,
  ).map(toRfqInvitation);
}

/** Look an invitation up by the token a supplier's link carries. */
export function findRfqInvitationByToken(token: string): RfqInvitation | null {
  const row = one<RfqInvitationRow & { supplier_name: string }>(
    `SELECT i.*, s.name AS supplier_name
       FROM rfq_invitations i
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.token = ?`,
    token,
  );
  return row ? toRfqInvitation(row) : null;
}

export function updateRfqInvitation(
  id: string,
  patch: {
    status?: RfqInvitationStatus;
    viewedAt?: string;
    respondedAt?: string;
    quoteId?: string;
    declineReason?: string | null;
  },
): void {
  const assignments: string[] = [];
  const values: SQLInputValue[] = [];

  if (patch.status !== undefined) {
    assignments.push("status = ?");
    values.push(patch.status);
  }
  if (patch.viewedAt !== undefined) {
    assignments.push("viewed_at = ?");
    values.push(patch.viewedAt);
  }
  if (patch.respondedAt !== undefined) {
    assignments.push("responded_at = ?");
    values.push(patch.respondedAt);
  }
  if (patch.quoteId !== undefined) {
    assignments.push("quote_id = ?");
    values.push(patch.quoteId);
  }
  if (patch.declineReason !== undefined) {
    assignments.push("decline_reason = ?");
    values.push(patch.declineReason);
  }

  if (assignments.length === 0) return;
  exec(`UPDATE rfq_invitations SET ${assignments.join(", ")} WHERE id = ?`, ...values, id);
}

/** Expire every invitation still outstanding for a request. */
export function expireRfqInvitations(requestId: string): number {
  const result = getDb()
    .prepare(
      `UPDATE rfq_invitations
          SET status = 'expired', responded_at = ?
        WHERE request_id = ? AND status IN ('invited', 'viewed')`,
    )
    .run(nowIso(), requestId);
  return Number(result.changes);
}

export function deleteRfqInvitations(requestId: string): void {
  exec("DELETE FROM rfq_invitations WHERE request_id = ?", requestId);
}

/* ------------------------------------------------------------ goods receipts */

interface GoodsReceiptRow {
  id: string;
  request_id: string;
  po_id: string;
  receipt_number: string;
  received_date: string;
  received_by: string;
  lines: string;
  notes: string | null;
  status: string;
  created_at: string;
}

function toGoodsReceipt(row: GoodsReceiptRow): GoodsReceipt {
  return {
    id: row.id,
    requestId: row.request_id,
    poId: row.po_id,
    receiptNumber: row.receipt_number,
    receivedDate: row.received_date,
    receivedBy: row.received_by,
    lines: parseJson<GoodsReceiptLine[]>(row.lines, []),
    notes: row.notes,
    status: row.status as GoodsReceiptStatus,
    createdAt: row.created_at,
  };
}

export function insertGoodsReceipt(input: {
  requestId: string;
  poId: string;
  receiptNumber: string;
  receivedDate: string;
  receivedBy: string;
  lines: GoodsReceiptLine[];
  notes: string | null;
  status: GoodsReceiptStatus;
}): GoodsReceipt {
  const id = newId("grn");
  exec(
    `INSERT INTO goods_receipts (
       id, request_id, po_id, receipt_number, received_date, received_by,
       lines, notes, status, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.requestId,
    input.poId,
    input.receiptNumber,
    input.receivedDate,
    input.receivedBy,
    JSON.stringify(input.lines),
    input.notes,
    input.status,
    nowIso(),
  );
  return getGoodsReceipt(input.requestId)!;
}

export function getGoodsReceipt(requestId: string): GoodsReceipt | null {
  const row = one<GoodsReceiptRow>(
    "SELECT * FROM goods_receipts WHERE request_id = ? ORDER BY created_at DESC LIMIT 1",
    requestId,
  );
  return row ? toGoodsReceipt(row) : null;
}

export function listGoodsReceipts(requestId: string): GoodsReceipt[] {
  return all<GoodsReceiptRow>(
    "SELECT * FROM goods_receipts WHERE request_id = ? ORDER BY created_at",
    requestId,
  ).map(toGoodsReceipt);
}

export function nextReceiptNumber(): string {
  const year = new Date().getUTCFullYear();
  const row = one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM goods_receipts WHERE receipt_number LIKE ?",
    `GRN-${year}-%`,
  );
  return `GRN-${year}-${String((row?.count ?? 0) + 1).padStart(4, "0")}`;
}

export function deleteGoodsReceipts(requestId: string): void {
  exec("DELETE FROM goods_receipts WHERE request_id = ?", requestId);
}

/* --------------------------------------------------------- approval authority */

interface ApprovalAuthorityRow {
  id: string;
  step_order: number;
  role: string;
  approver_name: string;
  threshold_amount: number;
  active: number;
  created_at: string;
}

function toApprovalAuthority(row: ApprovalAuthorityRow): ApprovalAuthority {
  return {
    id: row.id,
    stepOrder: row.step_order,
    role: row.role,
    approverName: row.approver_name,
    thresholdAmount: row.threshold_amount,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

/** The active delegation ladder, in ascending order of authority. */
export function listApprovalAuthority(): ApprovalAuthority[] {
  return all<ApprovalAuthorityRow>(
    "SELECT * FROM approval_authority WHERE active = 1 ORDER BY step_order",
  ).map(toApprovalAuthority);
}

export function insertApprovalAuthority(input: {
  stepOrder: number;
  role: string;
  approverName: string;
  thresholdAmount: number;
}): void {
  exec(
    `INSERT INTO approval_authority (
       id, step_order, role, approver_name, threshold_amount, active, created_at
     ) VALUES (?,?,?,?,?,1,?)`,
    newId("aut"),
    input.stepOrder,
    input.role,
    input.approverName,
    input.thresholdAmount,
    nowIso(),
  );
}

/* ------------------------------------------------------------------- budgets */

interface BudgetRow {
  id: string;
  department: string;
  category: string | null;
  annual_limit: number;
  owner_name: string;
  created_at: string;
}

function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    department: row.department,
    category: row.category as Category | null,
    annualLimit: row.annual_limit,
    ownerName: row.owner_name,
    createdAt: row.created_at,
  };
}

/**
 * The ceiling covering a department's spend in a category. A category-specific
 * budget wins over the department-wide fallback, so narrowing one line does not
 * open up the rest of the department's budget by accident.
 */
export function findBudget(
  department: string,
  category: Category | null,
): Budget | null {
  const row = one<BudgetRow>(
    `SELECT * FROM budgets
      WHERE department = ?
        AND (category IS NULL OR category = ?)
      ORDER BY category IS NULL
      LIMIT 1`,
    department,
    category,
  );
  return row ? toBudget(row) : null;
}

export function listBudgets(): Budget[] {
  return all<BudgetRow>("SELECT * FROM budgets ORDER BY department, category").map(
    toBudget,
  );
}

export function insertBudget(input: {
  department: string;
  category?: Category | null;
  annualLimit: number;
  ownerName: string;
}): void {
  exec(
    `INSERT INTO budgets (id, department, category, annual_limit, owner_name, created_at)
     VALUES (?,?,?,?,?,?)`,
    newId("bdg"),
    input.department,
    input.category ?? null,
    input.annualLimit,
    input.ownerName,
    nowIso(),
  );
}

/**
 * What the department has already committed against its ceiling. Only purchase
 * orders that exist count: a request still being sourced has committed nothing
 * yet, which is exactly the window the budget check has to be honest about.
 */
export function departmentCommittedSpend(department: string): number {
  const row = one<{ total: number | null }>(
    `SELECT SUM(p.total_amount) AS total
       FROM purchase_orders p
       JOIN requests r ON r.id = p.request_id
      WHERE r.requester_department = ?`,
    department,
  );
  return row?.total ?? 0;
}
