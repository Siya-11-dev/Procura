"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appendAudit } from "@/lib/db/audit";
import { withTransaction } from "@/lib/db/client";
import {
  answerClarification,
  createRequest,
  expireRfqInvitations,
  getPurchaseOrder,
  getRequest,
  getRequestSpec,
  getSupplier,
  insertGoodsReceipt,
  insertQuote,
  insertRiskException,
  listOpenClarifications,
  listRfqInvitations,
  nextReceiptNumber,
  updatePurchaseOrderDispatch,
  updateRequest,
  updateRfqInvitation,
} from "@/lib/db/repository";
import { storeDocument, type UploadFile } from "@/lib/documents/store";
import type {
  Currency,
  DispatchChannel,
  GoodsReceiptLine,
  Urgency,
} from "@/lib/domain/types";
import {
  decideApproval,
  raisePurchaseOrder,
  resumeAfterQuotes,
  runSourcingPipeline,
  submitInvoice,
  type Actor,
} from "@/lib/pipeline";
import { requireAuth, requireRoles } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import { CATEGORY_PROFILES } from "@/lib/agents/parsing";
import { buildSimulatedQuote, shouldDecline } from "@/lib/agents/quote.agent";
import type { SupplierMatch } from "@/lib/agents/supplier.agent";
import { nowIso, round, seededRandom, todayIso } from "@/lib/util";

export interface ActionState {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  /** Attachments that were refused, with the reason, shown to the requester. */
  rejectedDocuments?: string[];
  /** Set when the action succeeded but wants the client to navigate itself. */
  redirectTo?: string;
}

const APPROVE_ROLES: readonly Role[] = [
  "procurement_lead",
  "finance_director",
  "cfo",
  "ceo",
  "compliance_officer",
  "admin",
];

const INVOICE_ROLES: readonly Role[] = ["finance_director", "cfo", "admin"];
const RERUN_ROLES: readonly Role[] = ["procurement_lead", "admin"];
const RISK_EXCEPTION_ROLES: readonly Role[] = [
  "procurement_lead",
  "cfo",
  "ceo",
  "compliance_officer",
  "admin",
];
const CLARIFICATION_ROLES: readonly Role[] = [
  "requester",
  "procurement_lead",
  "admin",
];
const DISPATCH_ROLES: readonly Role[] = ["procurement_lead", "admin"];
const RECEIPT_ROLES: readonly Role[] = ["requester", "procurement_lead", "admin"];
const RFQ_ROLES: readonly Role[] = ["procurement_lead", "admin"];

function actorFor(user: { id: string; name: string; role: string }): Actor {
  return { id: user.id, name: user.name, role: user.role };
}

export async function submitRequestAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Any signed-in employee may raise a request.
  const auth = await requireAuth();
  if (auth.error) return { ok: false, message: auth.error.message };
  const actor = actorFor(auth.actor);

  const title = text(formData, "title");
  const rawDescription = text(formData, "rawDescription");
  const requesterName = text(formData, "requesterName") || auth.actor.name;
  const requesterEmail = text(formData, "requesterEmail") || auth.actor.email;
  const requesterDepartment = text(formData, "requesterDepartment");
  const unit = text(formData, "unit") || "units";
  const quantity = number(formData, "quantity");
  const currency = (text(formData, "currency") || "ZAR") as Currency;
  const budgetAmount = number(formData, "budgetAmount");
  const neededBy = text(formData, "neededBy") || null;
  const urgency = (text(formData, "urgency") || "normal") as Urgency;
  // The portal mode hands the RFQ to the suppliers themselves instead of
  // simulating their responses, so the choice is made before the pipeline runs.
  const quoteMode = text(formData, "quoteMode") === "portal" ? "portal" : "simulated";

  const fieldErrors: Record<string, string> = {};
  if (title.length < 5) fieldErrors.title = "Give the request a short title.";
  if (rawDescription.length < 20) {
    fieldErrors.rawDescription =
      "Describe what you need in at least a sentence. The agents work from this text.";
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(requesterEmail)) {
    fieldErrors.requesterEmail = "Enter a valid email address.";
  }
  if (requesterDepartment.length < 2) fieldErrors.requesterDepartment = "Required.";
  if (quantity !== null && quantity <= 0) {
    fieldErrors.quantity = "Quantity must be greater than zero.";
  }
  if (budgetAmount !== null && budgetAmount <= 0) {
    fieldErrors.budgetAmount = "Budget must be greater than zero.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, message: "Check the highlighted fields.", fieldErrors };
  }

  // The request and the record of it being created are one event. If the audit
  // append fails there must be no orphaned request sitting in the list with no
  // entry explaining where it came from.
  const request = withTransaction(() => {
    const created = createRequest({
      title,
      rawDescription,
      requesterName,
      requesterEmail,
      requesterDepartment,
      unit,
      quantity,
      currency,
      budgetAmount,
      neededBy,
      urgency,
      quoteMode,
    });

    appendAudit({
      requestId: created.id,
      actor: actor.id,
      actorRole: actor.role,
      action: "request.created",
      entityType: "request",
      entityId: created.id,
      detail: { title, reference: created.reference },
    });

    return created;
  });

  // Attachments are stored before the pipeline runs so the Request Agent reads
  // them on this first pass. A rejected file never blocks the request itself;
  // the requester is told which files were not stored.
  const rejected: string[] = [];
  let stored = 0;
  let unread = 0;
  const attachments = files(formData, "documents");
  for (const file of attachments) {
    const outcome = await storeDocument(
      request.id,
      file,
      actor.id,
      stored,
    );
    if (!outcome.ok) {
      rejected.push(`${outcome.name}: ${outcome.reason}`);
      continue;
    }
    stored += 1;
    if (outcome.document.extractStatus === "read") {
      appendAudit({
        requestId: request.id,
        actor: actor.id,
        actorRole: actor.role,
        action: "document.attached",
        entityType: "request_document",
        entityId: outcome.document.id,
        detail: {
          name: outcome.document.originalName,
          byteSize: outcome.document.byteSize,
          sha256: outcome.document.sha256,
          extractStatus: outcome.document.extractStatus,
          charCount: outcome.document.charCount,
        },
      });
    } else {
      unread += 1;
      appendAudit({
        requestId: request.id,
        actor: actor.id,
        actorRole: actor.role,
        action: "document.attached",
        entityType: "request_document",
        entityId: outcome.document.id,
        detail: {
          name: outcome.document.originalName,
          byteSize: outcome.document.byteSize,
          sha256: outcome.document.sha256,
          extractStatus: outcome.document.extractStatus,
          reason: outcome.document.extractReason,
        },
      });
    }
  }

  const result = await runSourcingPipeline(request.id, actor);

  revalidatePath("/");
  revalidatePath(`/requests/${request.id}`);

  const attachmentNote = [
    stored > 0
      ? `${stored} attachment${stored === 1 ? "" : "s"} read by the agents`
      : "",
    unread > 0 ? `${unread} stored but not readable` : "",
    rejected.length > 0 ? `${rejected.length} rejected` : "",
  ]
    .filter(Boolean)
    .join(", ");

  if (result.error) {
    return {
      ok: false,
      message: `The request was saved but sourcing stopped: ${result.error}${
        attachmentNote ? ` (${attachmentNote})` : ""
      }`,
      rejectedDocuments: rejected,
    };
  }

  // Two pauses are legitimate outcomes of a first run, not failures: questions
  // the requester has to answer, or an RFQ waiting on suppliers. Both still
  // take the requester to the request, where the pause is visible and actionable.
  if (result.status === "needs_clarification" || result.status === "awaiting_quotes") {
    return {
      ok: true,
      message: `${result.summary}${attachmentNote ? ` (${attachmentNote})` : ""}`,
      rejectedDocuments: rejected,
      redirectTo: `/requests/${request.id}`,
    };
  }

  if (attachmentNote) {
    // Surface the outcome without blocking the redirect to the request.
    return {
      ok: true,
      message: `Request created. ${attachmentNote}.`,
      rejectedDocuments: rejected,
      redirectTo: `/requests/${request.id}`,
    };
  }

  redirect(`/requests/${request.id}`);
}

export async function decideApprovalAction(
  requestId: string,
  stepId: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };

  const auth = await requireRoles(APPROVE_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const result = await decideApproval(
    requestId,
    stepId,
    decision,
    note,
    actorFor(auth.actor),
  );
  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return { ok: result.ok, message: result.message };
}

export async function submitInvoiceAction(
  requestId: string,
  input: {
    invoiceNumber: string;
    invoiceAmount: number;
    taxAmount: number;
    receivedDate: string;
  },
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };
  const auth = await requireRoles(INVOICE_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };
  if (!getPurchaseOrder(requestId)) {
    return {
      ok: false,
      message: "There is no purchase order to match this invoice against yet.",
    };
  }
  if (input.invoiceNumber.trim().length < 3) {
    return { ok: false, message: "Enter the supplier's invoice number." };
  }
  if (input.invoiceAmount <= 0) {
    return { ok: false, message: "Invoice amount must be greater than zero." };
  }
  if (!input.receivedDate) {
    return { ok: false, message: "Enter the date the invoice was received." };
  }

  const result = await submitInvoice(
    requestId,
    {
      invoiceNumber: input.invoiceNumber.trim(),
      invoiceAmount: round(input.invoiceAmount, 2),
      taxAmount: round(input.taxAmount, 2),
      receivedDate: input.receivedDate || todayIso(),
    },
    actorFor(auth.actor),
  );

  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return { ok: !result.error, message: result.summary };
}

export async function rerunPipelineAction(requestId: string): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };
  const auth = await requireRoles(RERUN_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  appendAudit({
    requestId,
    actor: auth.actor.id,
    actorRole: auth.actor.role,
    action: "request.rerun",
    entityType: "request",
    entityId: requestId,
    detail: {},
  });

  const result = await runSourcingPipeline(requestId, actorFor(auth.actor));
  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return { ok: !result.error, message: result.summary };
}

export async function acceptRiskAction(
  requestId: string,
  flagCode: string,
  justification: string,
  approverName: string,
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };
  const auth = await requireRoles(RISK_EXCEPTION_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  if (justification.trim().length < 10) {
    return {
      ok: false,
      message: "Record why you are accepting this risk, in at least a sentence.",
    };
  }

  // Accepting a finding in writing and the record of who accepted it are the same
  // decision. A stored exception with no audit entry would release the purchase
  // order with no accountable approver behind it.
  withTransaction(() => {
    insertRiskException({
      requestId,
      flagCode,
      justification: justification.trim(),
      approverName: approverName.trim() || auth.actor.name,
    });

    appendAudit({
      requestId,
      actor: auth.actor.id,
      actorRole: auth.actor.role,
      action: "risk.exception_granted",
      entityType: "risk_exception",
      entityId: flagCode,
      detail: { justification: justification.trim() },
    });
  });

  // Accepting the finding is what releases the purchase order, so try again.
  await raisePurchaseOrder(requestId, actorFor(auth.actor));

  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return {
    ok: true,
    message: getPurchaseOrder(requestId)
      ? "Risk accepted and the purchase order has been raised."
      : "Risk accepted. The purchase order will be raised once the approvals are cleared.",
  };
}

/**
 * Answer the open questions the pipeline stopped on, then run it again. The
 * answers are written first and the request quantity is updated from any
 * quantity answer, so the rerun either no longer trips the rule or finds the
 * question already answered and proceeds either way.
 */
export async function answerClarificationAction(
  requestId: string,
  answers: Record<string, string>,
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };

  const auth = await requireRoles(CLARIFICATION_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const open = listOpenClarifications(requestId);
  const answered = open.filter((entry) => (answers[entry.id] ?? "").trim().length > 0);
  if (answered.length === 0) {
    return {
      ok: false,
      message: "Write an answer for each question before resuming sourcing.",
    };
  }

  withTransaction(() => {
    for (const entry of answered) {
      const answer = answers[entry.id].trim();
      answerClarification({
        id: entry.id,
        requestId,
        answer,
        answeredBy: auth.actor.name,
      });
      appendAudit({
        requestId,
        actor: auth.actor.id,
        actorRole: auth.actor.role,
        action: "clarification.answered",
        entityType: "clarification",
        entityId: entry.id,
        detail: { code: entry.code, question: entry.question, answer },
      });

      // A quantity answer changes what was ordered, so it lands on the request
      // itself: the columns and the spec must not disagree about the volume.
      if (entry.code.startsWith("quantity_")) {
        const parsed = Number.parseFloat(answer.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(parsed) && parsed > 0) {
          updateRequest(requestId, { quantity: round(parsed, 3) });
        }
      }
    }
  });

  const result = await runSourcingPipeline(requestId, actorFor(auth.actor));
  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return { ok: !result.error, message: result.summary };
}

/**
 * Send the purchase order to the supplier and record how it went out. The
 * timestamp and channel are written by hand rather than inferred from status:
 * dispatching is a fact about the supplier relationship, not a pipeline state.
 */
export async function dispatchPurchaseOrderAction(
  requestId: string,
  channel: DispatchChannel,
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };

  const auth = await requireRoles(DISPATCH_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const po = getPurchaseOrder(requestId);
  if (!po) {
    return { ok: false, message: "There is no purchase order to dispatch yet." };
  }
  if (po.dispatchedAt) {
    return {
      ok: false,
      message: `${po.poNumber} was already dispatched by ${po.dispatchChannel} on ${po.dispatchedAt.slice(0, 10)}.`,
    };
  }

  withTransaction(() => {
    updatePurchaseOrderDispatch(requestId, {
      dispatchedAt: nowIso(),
      dispatchChannel: channel,
    });
    appendAudit({
      requestId,
      actor: auth.actor.id,
      actorRole: auth.actor.role,
      action: "po.dispatched",
      entityType: "purchase_order",
      entityId: po.id,
      detail: { poNumber: po.poNumber, supplier: po.supplierName, channel },
    });
  });

  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return {
    ok: true,
    message: `${po.poNumber} dispatched to ${po.supplierName} by ${channel}.`,
  };
}

/** Record that the supplier confirmed the purchase order. */
export async function acknowledgePurchaseOrderAction(
  requestId: string,
  reference: string,
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };

  const auth = await requireRoles(DISPATCH_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const po = getPurchaseOrder(requestId);
  if (!po) {
    return { ok: false, message: "There is no purchase order to acknowledge." };
  }
  if (!po.dispatchedAt) {
    return {
      ok: false,
      message: "Dispatch the purchase order to the supplier before recording an acknowledgement.",
    };
  }
  if (po.acknowledgedAt) {
    return { ok: false, message: `${po.poNumber} was already acknowledged.` };
  }

  withTransaction(() => {
    updatePurchaseOrderDispatch(requestId, {
      acknowledgedAt: nowIso(),
      ackReference: reference.trim() || null,
      status: "acknowledged",
    });
    appendAudit({
      requestId,
      actor: auth.actor.id,
      actorRole: auth.actor.role,
      action: "po.acknowledged",
      entityType: "purchase_order",
      entityId: po.id,
      detail: {
        poNumber: po.poNumber,
        supplier: po.supplierName,
        reference: reference.trim() || null,
      },
    });
  });

  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return {
    ok: true,
    message: `${po.supplierName} acknowledged ${po.poNumber}${reference.trim() ? ` against reference ${reference.trim()}` : ""}.`,
  };
}

/**
 * Record what physically arrived. The receipt is what turns the invoice's
 * quantity check from a look at the purchase order into a real three-way match,
 * so it is written with the same transaction discipline as the invoice itself.
 */
export async function recordGoodsReceiptAction(
  requestId: string,
  input: {
    lines: GoodsReceiptLine[];
    notes?: string;
    receivedDate?: string;
  },
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };

  const auth = await requireRoles(RECEIPT_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const po = getPurchaseOrder(requestId);
  if (!po) {
    return { ok: false, message: "There is no purchase order to receive against." };
  }

  const lines = input.lines.filter(
    (line) =>
      typeof line.received === "number" &&
      Number.isFinite(line.received) &&
      line.received >= 0,
  );
  if (lines.length === 0) {
    return { ok: false, message: "Record at least one received line." };
  }

  const complete = lines.every((line) => line.received >= line.ordered);
  const receiptNumber = nextReceiptNumber();
  const receivedDate = input.receivedDate || todayIso();

  const receipt = withTransaction(() => {
    const created = insertGoodsReceipt({
      requestId,
      poId: po.id,
      receiptNumber,
      receivedDate,
      receivedBy: auth.actor.name,
      lines,
      notes: input.notes?.trim() || null,
      status: complete ? "complete" : "partial",
    });

    if (complete) {
      updatePurchaseOrderDispatch(requestId, { status: "fulfilled" });
    }

    appendAudit({
      requestId,
      actor: auth.actor.id,
      actorRole: auth.actor.role,
      action: "goods_receipt.recorded",
      entityType: "goods_receipt",
      entityId: created.id,
      detail: {
        receiptNumber,
        status: created.status,
        receivedDate,
        lines: lines.map((line) => ({
          description: line.description,
          ordered: line.ordered,
          received: line.received,
        })),
      },
    });

    return created;
  });

  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return {
    ok: true,
    message:
      receipt.status === "complete"
        ? `${receiptNumber} recorded: every line fully received and ${po.poNumber} marked fulfilled.`
        : `${receiptNumber} recorded as a partial delivery of ${po.poNumber}.`,
  };
}

/**
 * Collect the outstanding portal responses: each supplier still sitting on the
 * RFQ gets the answer it would have given, then the window closes and the
 * pipeline resumes from the comparison step. A request where nobody answered
 * comes back blocked rather than compared against nothing.
 */
export async function collectRfqResponsesAction(
  requestId: string,
): Promise<ActionState> {
  const request = getRequest(requestId);
  if (!request) return { ok: false, message: "Request not found." };

  const auth = await requireRoles(RFQ_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  if (request.status !== "awaiting_quotes") {
    return {
      ok: false,
      message: "This request is not collecting quotations right now.",
    };
  }

  const spec = getRequestSpec(requestId);
  if (!spec) {
    return { ok: false, message: "The request has no parsed specification yet." };
  }

  const invitations = listRfqInvitations(requestId);
  const outstanding = invitations.filter(
    (invitation) => invitation.status === "invited" || invitation.status === "viewed",
  );
  const priceRange = CATEGORY_PROFILES[spec.category].priceRange;
  let collected = 0;

  withTransaction(() => {
    for (const invitation of outstanding) {
      const supplier = getSupplier(invitation.supplierId);
      if (!supplier) continue;

      // Seeded per supplier, exactly as the simulated pipeline seeds it, so a
      // portal request without a live supplier behaves like the same supplier
      // would have behaved in a straight simulated run.
      const rng = seededRandom(`${requestId}:${invitation.supplierId}:portal`);
      const decline = shouldDecline(asMatch(supplier), spec.quantity, priceRange, rng);

      if (decline) {
        updateRfqInvitation(invitation.id, {
          status: "declined",
          respondedAt: nowIso(),
          declineReason: decline,
        });
        continue;
      }

      const quote = insertQuote(
        buildSimulatedQuote({
          requestId,
          supplier,
          quantity: spec.quantity,
          currency: request.currency,
          category: spec.category,
          rng,
        }),
      );

      updateRfqInvitation(invitation.id, {
        status: "quoted",
        respondedAt: nowIso(),
        quoteId: quote.id,
      });
      collected += 1;
      appendAudit({
        requestId,
        actor: auth.actor.id,
        actorRole: auth.actor.role,
        action: "rfq.response_received",
        entityType: "rfq_invitation",
        entityId: invitation.id,
        detail: {
          supplier: supplier.name,
          totalPrice: quote.totalPrice,
          leadTimeDays: quote.leadTimeDays,
          via: "portal",
        },
      });
    }

    const expired = expireRfqInvitations(requestId);
    appendAudit({
      requestId,
      actor: auth.actor.id,
      actorRole: auth.actor.role,
      action: "rfq.collection_closed",
      entityType: "request",
      entityId: requestId,
      detail: {
        quotes: collected,
        declined: outstanding.length - collected - expired,
        expired,
      },
    });
  });

  const result = await resumeAfterQuotes(requestId, actorFor(auth.actor));
  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);

  return { ok: !result.error, message: result.summary };
}

function asMatch(supplier: NonNullable<ReturnType<typeof getSupplier>>): SupplierMatch {
  return {
    supplier,
    matchScore: 1,
    categoryFit: 1,
    certificationFit: 1,
    commercialFit: 1,
    trackRecord: 1,
    reasons: [],
    concerns: [],
  };
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Attachments from a multiple file input. An empty input submits a zero-byte
 * entry, which is filtered out here rather than reported to the requester as a
 * rejected attachment.
 *
 * Checked structurally rather than with `instanceof File` so that a runtime
 * handing over a bare Blob is not silently discarded: an attachment quietly
 * dropped here would look to the requester like a document the agents ignored.
 */
function files(formData: FormData, key: string): UploadFile[] {
  return formData
    .getAll(key)
    .filter(
      (value): value is File =>
        typeof Blob !== "undefined" && value instanceof Blob && value.size > 0,
    );
}

function number(formData: FormData, key: string): number | null {
  const raw = text(formData, key).replace(/[^0-9.]/g, "");
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
