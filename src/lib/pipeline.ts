import {
  deleteAgentRuns,
  deleteApprovals,
  deleteComparison,
  deleteGoodsReceipts,
  deleteInvoices,
  deleteNegotiation,
  deletePurchaseOrders,
  deleteQuotes,
  deleteRfqInvitations,
  deleteRisk,
  getApprovalStep,
  getComparison,
  getPurchaseOrder,
  getQuote,
  getRequest,
  getRequestSpec,
  insertClarification,
  insertRfqInvitation,
  listApprovals,
  listOpenClarifications,
  listQuotes,
  listRisk,
  listRiskExceptions,
  listSuppliers,
  recordAgentRun,
  updateApprovalStep,
  updateRequest,
  type RequestSpec,
} from "@/lib/db/repository";
import { appendAudit } from "@/lib/db/audit";
import { withTransaction } from "@/lib/db/client";
import { ROLE_TO_APPROVAL_STEP, type Role } from "@/lib/auth/roles";
import type { AgentName, ProcurementRequest, RiskFlag } from "@/lib/domain/types";
import { addDays, newId, nowIso, seededRandom, todayIso } from "@/lib/util";
import { approvalAgent } from "./agents/approval.agent";
import { comparisonAgent } from "./agents/comparison.agent";
import { invoiceAgent, type InvoiceAgentInput } from "./agents/invoice.agent";
import { negotiationAgent } from "./agents/negotiation.agent";
import { poAgent } from "./agents/po.agent";
import { quoteAgent } from "./agents/quote.agent";
import { requestAgent } from "./agents/request.agent";
import { riskAgent } from "./agents/risk.agent";
import { supplierAgent, type SupplierMatch } from "./agents/supplier.agent";
import type { Agent, AgentContext, AgentResult } from "./agents/types";

const STEP_NUMBER: Record<AgentName, number> = {
  request: 1,
  supplier: 2,
  quote: 3,
  comparison: 4,
  risk: 5,
  negotiation: 6,
  approval: 7,
  po: 8,
  invoice: 9,
};

export interface PipelineResult {
  requestId: string;
  status: ProcurementRequest["status"];
  recommendedSupplier: string | null;
  totalAmount: number | null;
  currency: string;
  summary: string;
  error: string | null;
}

/**
 * Who is responsible for a pipeline action. Every entry point takes one so the
 * audit chain records a person rather than an anonymous system step; the seed
 * passes a synthetic pipeline identity because it acts on the requester's
 * behalf.
 */
export interface Actor {
  id: string;
  name: string;
  role: string;
}

export const SYSTEM_ACTOR: Actor = {
  id: "system",
  name: "Procura pipeline",
  role: "system",
};

async function runStep<TInput, TOutput>(
  request: ProcurementRequest,
  agent: Agent<TInput, TOutput>,
  input: TInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AgentResult<TOutput>> {
  const startedAt = nowIso();
  const started = performance.now();
  const context: AgentContext = {
    request,
    rng: seededRandom(`${request.id}:${agent.name}`),
  };

  const finish = (
    status: "success" | "failed",
    summary: string,
    detail: unknown,
  ) => {
    // The run record and the audit entry describe the same event, so they commit
    // together: a step can never be logged as done without the record of it, or
    // recorded without the audit trail claiming it.
    withTransaction(() => {
      recordAgentRun({
        requestId: request.id,
        agent: agent.name,
        step: STEP_NUMBER[agent.name],
        label: agent.name,
        status,
        summary,
        detail,
        durationMs: Math.max(1, Math.round(performance.now() - started)),
        startedAt,
        finishedAt: nowIso(),
      });
      appendAudit({
        requestId: request.id,
        actor: actor.id,
        actorRole: actor.role,
        action: "agent.completed",
        entityType: "agent_run",
        entityId: agent.name,
        detail: { step: STEP_NUMBER[agent.name], status, summary },
      });
    });
  };

  try {
    const result = await agent.run(context, input);
    finish("success", result.summary, result.detail);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? null : null;
    finish("failed", `${agent.name} agent failed: ${message}`, { error: message, stack });
    throw error;
  }
}

export async function runSourcingPipeline(
  requestId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<PipelineResult> {
  const initial = getRequest(requestId);
  if (!initial) throw new Error("Request not found");

  // Clearing derived data, moving the request into sourcing and recording that
  // the run began are one decision. Splitting them would let the audit trail
  // assert a pipeline start against a request still marked submitted.
  withTransaction(() => {
    clearDerivedData(requestId);
    updateRequest(requestId, { status: "sourcing" });
    appendAudit({
      requestId,
      actor: actor.id,
      actorRole: actor.role,
      action: "pipeline.started",
      entityType: "request",
      entityId: requestId,
      detail: { reference: initial.reference, title: initial.title },
    });
  });

  try {
    await runStep(initial, requestAgent, null, actor);
    const request = getRequest(requestId)!;
    const spec = getRequestSpec(requestId)!;

    // The gate runs before anything is sourced: there is no point shortlisting
    // suppliers for a request nobody could price.
    const paused = clarificationGate(request, spec, actor);
    if (paused) return paused;

    const supplierResult = await runStep(request, supplierAgent, spec, actor);

    // Portal mode hands the RFQ to the suppliers themselves and stops here.
    // Everything after the quotes are in runs in `resumeAfterQuotes`.
    if (request.quoteMode === "portal") {
      return await pauseForRfqInvitations(request, supplierResult.output.shortlist, actor);
    }

    await runStep(
      request,
      quoteAgent,
      {
        shortlist: supplierResult.output.shortlist,
        category: spec.category,
        quantity: spec.quantity,
      },
      actor,
    );

    return await runFromComparison(requestId, actor);
  } catch (error) {
    return pipelineFailure(requestId, error, actor, initial.currency);
  }
}

/**
 * Write the blocking questions as rows the requester can answer, then stop the
 * run when any of them are still open.
 *
 * The rows are unique per request and code, so a rerun re-asserts the question
 * without overwriting an answer; once every row is answered the gate passes
 * even if the same rule would still fire, because a person has spoken for the
 * request. The spec is already stored at this point, so the request page can
 * show the parsed read alongside the questions it is waiting on.
 */
function clarificationGate(
  request: ProcurementRequest,
  spec: RequestSpec,
  actor: Actor,
): PipelineResult | null {
  withTransaction(() => {
    for (const code of spec.blockingClarifications) {
      const prompt = CLARIFICATION_QUESTIONS[code];
      if (!prompt) continue;
      insertClarification({
        requestId: request.id,
        code,
        question: prompt.question,
        detail: prompt.detail,
      });
    }
  });

  const open = listOpenClarifications(request.id);
  if (open.length === 0) return null;

  withTransaction(() => {
    updateRequest(request.id, { status: "needs_clarification" });
    appendAudit({
      requestId: request.id,
      actor: actor.id,
      actorRole: actor.role,
      action: "clarification.requested",
      entityType: "clarification",
      entityId: open[0].id,
      detail: {
        count: open.length,
        codes: open.map((entry) => entry.code),
        questions: open.map((entry) => entry.question),
      },
    });
  });

  return {
    requestId: request.id,
    status: "needs_clarification",
    recommendedSupplier: null,
    totalAmount: null,
    currency: request.currency,
    summary: `Sourcing is waiting on ${open.length} answer${open.length === 1 ? "" : "s"} from ${request.requesterName}: ${open
      .map((entry) => entry.question)
      .join(" ")}`,
    error: null,
  };
}

/**
 * Issue a request for quotation to every shortlisted supplier and stop the run.
 * Each invitation carries its own single-use token, and the link that token
 * opens is the only credential a supplier needs to answer.
 */
async function pauseForRfqInvitations(
  request: ProcurementRequest,
  shortlist: SupplierMatch[],
  actor: Actor,
): Promise<PipelineResult> {
  const expiresAt = addDays(todayIso(), 7);

  withTransaction(() => {
    for (const match of shortlist) {
      insertRfqInvitation({
        requestId: request.id,
        supplierId: match.supplier.id,
        token: newId("rfqtok"),
        expiresAt,
      });
    }
    updateRequest(request.id, { status: "awaiting_quotes" });
    appendAudit({
      requestId: request.id,
      actor: actor.id,
      actorRole: actor.role,
      action: "rfq.invitations_created",
      entityType: "request",
      entityId: request.id,
      detail: {
        count: shortlist.length,
        suppliers: shortlist.map((match) => match.supplier.name),
        expiresAt,
      },
    });
  });

  return {
    requestId: request.id,
    status: "awaiting_quotes",
    recommendedSupplier: null,
    totalAmount: null,
    currency: request.currency,
    summary: `Request for quotation sent to ${shortlist.length} supplier${shortlist.length === 1 ? "" : "s"} through the supplier portal. Responses are accepted until ${expiresAt}.`,
    error: null,
  };
}

/**
 * Steps 4 to 9: everything that happens once quotes exist. The simulated
 * pipeline and a portal request whose responses have landed both run this, so
 * an RFQ answered by a real supplier goes through exactly the same comparison,
 * risk, negotiation, approval and award path as a simulated one.
 */
async function runFromComparison(
  requestId: string,
  actor: Actor,
): Promise<PipelineResult> {
  const request = getRequest(requestId);
  if (!request) throw new Error("Request not found");
  const spec = getRequestSpec(requestId)!;

  await runStep(
    request,
    comparisonAgent,
    {
      urgency: spec.urgency,
      neededBy: request.neededBy,
      budgetAmount: request.budgetAmount,
    },
    actor,
  );

  const riskResult = await runStep(
    request,
    riskAgent,
    {
      quotes: listQuotes(requestId),
      suppliers: listSuppliers(),
      neededBy: request.neededBy,
    },
    actor,
  );

  const comparison = getComparison(requestId);
  const negotiation = await runStep(
    request,
    negotiationAgent,
    {
      quotes: listQuotes(requestId),
    },
    actor,
  );

  const recommendedQuote = comparison?.recommendedQuoteId
    ? getQuote(comparison.recommendedQuoteId)
    : null;
  const totalAmount = recommendedQuote?.totalPrice ?? null;

  const approvalResult = await runStep(
    request,
    approvalAgent,
    {
      totalAmount: totalAmount ?? request.budgetAmount ?? 0,
      currency: request.currency,
      riskBand: riskResult.output.band,
      blockingFlags: riskResult.output.blockingFlags.length,
    },
    actor,
  );

  if (approvalResult.output.autoApproved) {
    await raisePurchaseOrder(requestId, actor);
  } else if (approvalResult.output.currentStep) {
    updateRequest(requestId, { status: "awaiting_approval" });
  }

  // Every approval step the agent produced is recorded in one go, so a partial
  // write cannot leave the chain claiming fewer approvals than exist.
  withTransaction(() => {
    for (const step of approvalResult.output.steps) {
      appendAudit({
        requestId,
        actor: actor.id,
        actorRole: actor.role,
        action: step.automated ? "approval.auto_approved" : "approval.requested",
        entityType: "approval",
        entityId: step.id,
        detail: {
          stepOrder: step.stepOrder,
          role: step.role,
          thresholdAmount: step.thresholdAmount,
          status: step.status,
        },
      });
    }
  });

  const finalStatus = getRequest(requestId)!.status;
  withTransaction(() => {
    appendAudit({
      requestId,
      actor: actor.id,
      actorRole: actor.role,
      action: "pipeline.completed",
      entityType: "request",
      entityId: requestId,
      detail: {
        status: finalStatus,
        recommendedSupplier: riskResult.output.recommendedSupplier?.name ?? null,
        totalAmount,
      },
    });
  });

  return {
    requestId,
    status: finalStatus,
    recommendedSupplier: riskResult.output.recommendedSupplier?.name ?? null,
    totalAmount,
    currency: request.currency,
    summary: buildPipelineSummary({
      supplier: riskResult.output.recommendedSupplier?.name ?? null,
      totalAmount,
      currency: request.currency,
      saving: negotiation.output.realisedSaving,
      approval: approvalResult.output.currentStep?.role ?? null,
    }),
    error: null,
  };
}

/**
 * Pick the pipeline back up once quotes exist for a request that was paused in
 * the portal. A request without a single quotation cannot be compared, so it is
 * parked as blocked instead of the chain running over nothing.
 */
export async function resumeAfterQuotes(
  requestId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<PipelineResult> {
  const request = getRequest(requestId);
  if (!request) throw new Error("Request not found");

  if (listQuotes(requestId).length === 0) {
    withTransaction(() => {
      updateRequest(requestId, { status: "blocked" });
      appendAudit({
        requestId,
        actor: actor.id,
        actorRole: actor.role,
        action: "rfq.collection_closed",
        entityType: "request",
        entityId: requestId,
        detail: { quotes: 0, reason: "no_quotes" },
      });
    });
    return {
      requestId,
      status: "blocked",
      recommendedSupplier: null,
      totalAmount: null,
      currency: request.currency,
      summary: "The response window closed without a single quotation, so there is nothing to compare. The request is blocked pending a new approach.",
      error: null,
    };
  }

  try {
    return await runFromComparison(requestId, actor);
  } catch (error) {
    return pipelineFailure(requestId, error, actor, request.currency);
  }
}

/**
 * Steps that already committed stay committed, and each is individually
 * audited, so the log describes exactly how far the run got. What must not
 * happen is the request claiming a failure that was never recorded.
 */
function pipelineFailure(
  requestId: string,
  error: unknown,
  actor: Actor,
  fallbackCurrency: string,
): PipelineResult {
  const message = error instanceof Error ? error.message : String(error);
  withTransaction(() => {
    updateRequest(requestId, { status: "failed" });
    appendAudit({
      requestId,
      actor: actor.id,
      actorRole: actor.role,
      action: "pipeline.failed",
      entityType: "request",
      entityId: requestId,
      detail: { error: message },
    });
  });
  return {
    requestId,
    status: "failed",
    recommendedSupplier: null,
    totalAmount: null,
    currency: getRequest(requestId)?.currency ?? fallbackCurrency,
    summary: `Pipeline stopped: ${message}`,
    error: message,
  };
}

/** The questions a request cannot be sourced without an answer to. */
const CLARIFICATION_QUESTIONS: Record<string, { question: string; detail: string }> = {
  quantity_missing: {
    question: "How many do you need?",
    detail:
      "No quantity could be read from the request or its attachments, so suppliers cannot be asked to price a unit and quotes cannot be compared.",
  },
  quantity_unconfirmed: {
    question: "Is the quantity in your description the number of units you need?",
    detail:
      "A number was found in the text but could not be tied to a specific item, so sourcing does not know how many it refers to.",
  },
  quantity_conflict: {
    question: "Which quantity is correct, the one on the form or the one in your description?",
    detail:
      "The form and the description disagree. Sourcing is currently using the form value, so confirm which one is right.",
  },
};

export async function raisePurchaseOrder(
  requestId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> {
  const request = getRequest(requestId);
  if (!request) throw new Error("Request not found");

  if (getPurchaseOrder(requestId)) return;

  const comparison = getComparison(requestId);
  const approvals = listApprovals(requestId);
  const cleared = approvals.length > 0 && approvals.every((step) => step.status === "approved");
  const quote = comparison?.recommendedQuoteId
    ? getQuote(comparison.recommendedQuoteId)
    : null;

  const unresolved = unresolvedBlockingFlags(requestId);

  const result = await runStep(
    request,
    poAgent,
    {
      totalAmount: quote?.totalPrice ?? 0,
      currency: request.currency,
      approvalsCleared: cleared,
      blockingFlags: unresolved,
    },
    actor,
  );

  if (!result.output.skipped) {
    const po = getPurchaseOrder(requestId);
    withTransaction(() => {
      updateRequest(requestId, { status: "po_issued" });
      appendAudit({
        requestId,
        actor: actor.id,
        actorRole: actor.role,
        action: "po.issued",
        entityType: "purchase_order",
        entityId: po?.id ?? null,
        detail: { poNumber: po?.poNumber, supplier: po?.supplierName },
      });
    });
  } else if (unresolved.length > 0 && cleared) {
    // Approved by everyone, but the risk agent still says do not award. Say so
    // on the request rather than leaving it looking simply "Approved".
    withTransaction(() => {
      updateRequest(requestId, { status: "blocked" });
      appendAudit({
        requestId,
        actor: actor.id,
        actorRole: actor.role,
        action: "po.blocked",
        entityType: "request",
        entityId: requestId,
        detail: { unresolvedFlags: unresolved.map((flag) => flag.code) },
      });
    });
  }
}

/**
 * Critical findings on the recommended quote that no approver has accepted yet.
 * The risk agent sets these as blockers, and a recorded exception is the only
 * way past them.
 */
export function unresolvedBlockingFlags(requestId: string): RiskFlag[] {
  const recommended = listRisk(requestId).find((risk) => risk.isRecommended);
  if (!recommended) return [];

  const waived = new Set(
    listRiskExceptions(requestId).map((exception) => exception.flagCode),
  );

  return recommended.flags.filter(
    (flag) => flag.severity === "critical" && !waived.has(flag.code),
  );
}

export async function submitInvoice(
  requestId: string,
  input: InvoiceAgentInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<PipelineResult> {
  const request = getRequest(requestId);
  if (!request) throw new Error("Request not found");

  const startedAt = nowIso();
  const started = performance.now();
  const context: AgentContext = {
    request,
    rng: seededRandom(`${request.id}:invoice`),
  };

  try {
    const result = await invoiceAgent.run(context, input);
    const invoiceDetail = result.detail as {
      verdict: string;
      matched?: boolean;
    } | null;
    // The three-way-match verdict, its run record and its audit entry are one
    // outcome. Recording the match separately from deciding it is how an audit
    // trail starts disagreeing with the invoice it describes.
    withTransaction(() => {
      recordAgentRun({
        requestId,
        agent: "invoice",
        step: STEP_NUMBER.invoice,
        label: "invoice",
        status: "success",
        summary: result.summary,
        detail: result.detail,
        durationMs: Math.max(1, Math.round(performance.now() - started)),
        startedAt,
        finishedAt: nowIso(),
      });
      appendAudit({
        requestId,
        actor: actor.id,
        actorRole: actor.role,
        action: "invoice.matched",
        entityType: "invoice",
        entityId: input.invoiceNumber,
        detail: {
          verdict: invoiceDetail?.verdict ?? "unknown",
          matched: Boolean(invoiceDetail?.matched),
        },
      });
    });
    return {
      requestId,
      status: getRequest(requestId)!.status,
      recommendedSupplier: null,
      totalAmount: getPurchaseOrder(requestId)?.totalAmount ?? null,
      currency: request.currency,
      summary: result.summary,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAgentRun({
      requestId,
      agent: "invoice",
      step: STEP_NUMBER.invoice,
      label: "invoice",
      status: "failed",
      summary: `invoice agent failed: ${message}`,
      detail: { error: message },
      durationMs: Math.max(1, Math.round(performance.now() - started)),
      startedAt,
      finishedAt: nowIso(),
    });
    return {
      requestId,
      status: getRequest(requestId)!.status,
      recommendedSupplier: null,
      totalAmount: null,
      currency: request.currency,
      summary: `Invoice agent failed: ${message}`,
      error: message,
    };
  }
}

export interface DecisionResult {
  ok: boolean;
  message: string;
  raisedPurchaseOrder: boolean;
  /** HTTP status hint for API callers. `forbidden` maps to 403; everything
   * else that fails maps to 409 (a state conflict). */
  code?: "forbidden" | "conflict";
}

export async function decideApproval(
  requestId: string,
  stepId: string,
  decision: "approved" | "rejected",
  note: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<DecisionResult> {
  const step = getApprovalStep(requestId, stepId);
  if (!step) {
    return {
      ok: false,
      message: "That approval step does not belong to this request.",
      raisedPurchaseOrder: false,
      code: "conflict",
    };
  }
  if (step.status !== "pending") {
    return {
      ok: false,
      message: `This step was already ${step.status}.`,
      raisedPurchaseOrder: false,
      code: "conflict",
    };
  }
  if (actor.id === "system") {
    // The seed pipeline acts for the requester. Real decisions always carry a
    // logged-in user, whose authority is checked below.
  } else {
    const allowed = ROLE_TO_APPROVAL_STEP[step.role] ?? [];
    if (!allowed.includes(actor.role as Role)) {
      return {
        ok: false,
        message: `Your role (${actor.role}) is not authorised to decide the ${step.role} step.`,
        raisedPurchaseOrder: false,
        code: "forbidden",
      };
    }
  }

  const earlier = listApprovals(requestId).find(
    (approval) => approval.status === "pending" && approval.stepOrder < step.stepOrder,
  );
  if (earlier) {
    return {
      ok: false,
      message: `Step ${earlier.stepOrder} (${earlier.role}) must be decided first.`,
      raisedPurchaseOrder: false,
      code: "conflict",
    };
  }

  // Whether this clears the chain has to be judged against the approvals that
  // will still be pending once this step is marked, so the step being decided is
  // excluded explicitly rather than relying on write ordering.
  const stillPendingAfterwards = listApprovals(requestId).filter(
    (approval) => approval.status === "pending" && approval.id !== step.id,
  ).length;

  // Recording the decision and moving the request on are the same event. Note
  // the purchase order below is deliberately outside this transaction: it runs
  // its own agent and its own audit entries, and holding this transaction open
  // across that await would pin the write lock for the duration.
  const clearsChain = decision === "rejected" || stillPendingAfterwards === 0;

  withTransaction(() => {
    updateApprovalStep(stepId, {
      status: decision,
      decisionNote: note.trim() || null,
    });

    appendAudit({
      requestId,
      actor: actor.id,
      actorRole: actor.role,
      action: "approval.decided",
      entityType: "approval",
      entityId: step.id,
      detail: {
        stepOrder: step.stepOrder,
        role: step.role,
        decision,
        note: note.trim() || null,
      },
    });

    if (decision === "rejected") {
      updateRequest(requestId, { status: "rejected" });
    } else if (clearsChain) {
      updateRequest(requestId, { status: "approved" });
    }
  });

  if (decision === "rejected") {
    return {
      ok: true,
      message: `${step.role} rejected the request. Sourcing stops here and no purchase order is raised.`,
      raisedPurchaseOrder: false,
    };
  }

  const remaining = listApprovals(requestId).filter(
    (approval) => approval.status === "pending",
  );

  if (remaining.length > 0) {
    const next = remaining[0];
    return {
      ok: true,
      message: `${step.role} approved. Routed to ${next.role} (${next.approverName}).`,
      raisedPurchaseOrder: false,
    };
  }

  await raisePurchaseOrder(requestId, actor);

  const po = getPurchaseOrder(requestId);
  return {
    ok: true,
    message: po
      ? `All approvals cleared. Purchase order ${po.poNumber} raised against ${po.supplierName} for ${po.currency} ${Math.round(po.totalAmount).toLocaleString("en-ZA")}.`
      : "All approvals cleared.",
    raisedPurchaseOrder: Boolean(po),
  };
}

export function clearDerivedData(requestId: string): void {
  // Ten separate deletes, so all-or-nothing matters: a half-cleared request
  // would keep stale quotes alongside a rebuilt approval chain. Clarifications
  // are deliberately not cleared — they are the requester's answers, and a
  // rerun has to be able to read them.
  withTransaction(() => {
    deleteQuotes(requestId);
    deleteRisk(requestId);
    deleteComparison(requestId);
    deleteNegotiation(requestId);
    deleteApprovals(requestId);
    deleteInvoices(requestId);
    deletePurchaseOrders(requestId);
    deleteGoodsReceipts(requestId);
    deleteRfqInvitations(requestId);
    deleteAgentRuns(requestId);
  });
}

function buildPipelineSummary(input: {
  supplier: string | null;
  totalAmount: number | null;
  currency: string;
  saving: number;
  approval: string | null;
}): string {
  if (!input.supplier || input.totalAmount === null) {
    return "Sourcing did not reach a recommended supplier. Review the agent run history for the failing step.";
  }
  const money = `${input.currency} ${Math.round(input.totalAmount).toLocaleString("en-ZA")}`;
  const saving =
    input.saving > 0
      ? `, including ${input.currency} ${Math.round(input.saving).toLocaleString("en-ZA")} saved in negotiation`
      : "";
  return input.approval
    ? `Awarded to ${input.supplier} at ${money}${saving}. Awaiting ${input.approval} approval.`
    : `Awarded to ${input.supplier} at ${money}${saving}. Fully approved.`;
}
