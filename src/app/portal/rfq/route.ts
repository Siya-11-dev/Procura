import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { appendAudit } from "@/lib/db/audit";
import { withTransaction } from "@/lib/db/client";
import {
  findRfqInvitationByToken,
  getRequest,
  getRequestSpec,
  getSupplier,
  insertQuote,
  listRfqInvitations,
  updateRfqInvitation,
} from "@/lib/db/repository";
import { resumeAfterQuotes, type Actor } from "@/lib/pipeline";
import { checkRateLimit } from "@/lib/rate-limit";
import { nowIso, round, todayIso } from "@/lib/util";

const VAT_RATE = 15;

/**
 * The token is the only secret standing between an anonymous visitor and the
 * quotation forms, so a wrong token counts against its client immediately:
 * eight misses in five minutes buys a cooling-off period instead of unlimited
 * guesses.
 */
const TOKEN_GUESSING = { limit: 8, windowMs: 5 * 60_000 };

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function numberField(form: FormData, name: string, fallback: number): number {
  const raw = field(form, name);
  if (raw === "") return fallback;
  const parsed = Number.parseFloat(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Supplier answers arrive as a plain form post - the portal page ships no
 * client JavaScript, so the browser does the submitting and the redirect back
 * does the confirming. The token is the only credential a supplier holds, so
 * it is resolved before anything else is read.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const form = await request.formData();
  const token = field(form, "token");
  const back = `/portal?token=${encodeURIComponent(token)}`;

  const invitation = token ? findRfqInvitationByToken(token) : null;
  if (!invitation) {
    const verdict = checkRateLimit(`portal-rfq:${clientKey(request)}`, TOKEN_GUESSING);
    if (!verdict.allowed) {
      return new Response(
        "Too many attempts with that link. Wait a few minutes, then open the link from your email again.",
        {
          status: 429,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Retry-After": String(verdict.retryAfterSec),
          },
        },
      );
    }
    redirect("/portal?error=That invitation link is not valid.");
  }

  // A response that already landed does not get overwritten by a second post.
  if (invitation.status === "quoted") redirect(`${back}&done=quote`);
  if (invitation.status === "declined") redirect(`${back}&done=decline`);
  if (invitation.status === "expired" || invitation.expiresAt < todayIso()) {
    updateRfqInvitation(invitation.id, { status: "expired" });
    redirect(`${back}&error=${encodeURIComponent("The response window for this request has closed.")}`);
  }

  const procurementRequest = getRequest(invitation.requestId);
  if (!procurementRequest || procurementRequest.status !== "awaiting_quotes") {
    redirect(`${back}&error=${encodeURIComponent("This request is no longer collecting quotations.")}`);
  }

  const spec = getRequestSpec(invitation.requestId);
  const supplier = getSupplier(invitation.supplierId);
  if (!spec || !supplier) {
    redirect(`${back}&error=${encodeURIComponent("The request is not in a state that can be quoted.")}`);
  }

  const actor: Actor = {
    id: `supplier:${supplier.id}`,
    name: supplier.name,
    role: "supplier",
  };

  if (field(form, "action") === "decline") {
    const reason = field(form, "reason") || "Declined without a stated reason.";
    withTransaction(() => {
      updateRfqInvitation(invitation.id, {
        status: "declined",
        respondedAt: nowIso(),
        declineReason: reason,
      });
      appendAudit({
        requestId: invitation.requestId,
        actor: actor.id,
        actorRole: actor.role,
        action: "rfq.response_received",
        entityType: "rfq_invitation",
        entityId: invitation.id,
        detail: { response: "declined", supplier: supplier.name, reason },
      });
    });
    await closeIfAllWindowsAnswered(invitation.requestId);
    redirect(`${back}&done=decline`);
  }

  const unitPrice = numberField(form, "unitPrice", Number.NaN);
  const leadTimeDays = numberField(form, "leadTimeDays", Number.NaN);
  const shippingCost = numberField(form, "shippingCost", 0);
  const warrantyMonths = numberField(form, "warrantyMonths", 0);

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    redirect(`${back}&error=${encodeURIComponent("Enter a unit price greater than zero.")}`);
  }
  if (!Number.isFinite(leadTimeDays) || leadTimeDays < 1) {
    redirect(`${back}&error=${encodeURIComponent("Lead time must be at least one day.")}`);
  }
  if (!Number.isFinite(shippingCost) || shippingCost < 0) {
    redirect(`${back}&error=${encodeURIComponent("Delivery cost cannot be negative.")}`);
  }

  const quantity = spec.quantity;
  const subtotal = round(unitPrice * quantity, 2);
  const shipping = round(shippingCost, 2);
  const taxAmount = round((subtotal + shipping) * (VAT_RATE / 100), 2);
  const totalPrice = round(subtotal + shipping + taxAmount, 2);

  const notes = field(form, "notes");
  const paymentTerms = field(form, "paymentTerms") || "30 days";
  const incoterms =
    supplier.country === "South Africa" ? "DDP Johannesburg" : "DAP Johannesburg";

  withTransaction(() => {
    const quote = insertQuote({
      requestId: invitation.requestId,
      supplierId: supplier.id,
      unitPrice: round(unitPrice, 2),
      currency: procurementRequest.currency,
      quantity,
      subtotal,
      shippingCost: shipping,
      taxRate: VAT_RATE,
      totalPrice,
      minimumOrderQty: 1,
      leadTimeDays: Math.round(leadTimeDays),
      paymentTerms,
      warrantyMonths: Math.round(warrantyMonths),
      validityDays: 30,
      priceBreaks: [{ minQty: Math.max(1, Math.round(quantity)), unitPrice: round(unitPrice, 2) }],
      incoterms,
      notes: notes || null,
      status: "received",
      receivedAt: nowIso(),
      declineReason: null,
    });

    updateRfqInvitation(invitation.id, {
      status: "quoted",
      respondedAt: nowIso(),
      quoteId: quote.id,
    });

    appendAudit({
      requestId: invitation.requestId,
      actor: actor.id,
      actorRole: actor.role,
      action: "rfq.response_received",
      entityType: "rfq_invitation",
      entityId: invitation.id,
      detail: {
        response: "quoted",
        supplier: supplier.name,
        quoteId: quote.id,
        unitPrice: quote.unitPrice,
        totalPrice: quote.totalPrice,
        leadTimeDays: quote.leadTimeDays,
      },
    });
  });

  await closeIfAllWindowsAnswered(invitation.requestId);
  redirect(`${back}&done=quote`);
}

/**
 * The window is effectively closed once every invited supplier has answered or
 * declined: nobody is left who could still respond, so the run picks up from
 * the comparison step instead of waiting for a person to press a button.
 */
async function closeIfAllWindowsAnswered(requestId: string): Promise<void> {
  const outstanding = listRfqInvitations(requestId).filter(
    (entry) => entry.status === "invited" || entry.status === "viewed",
  );
  const request = getRequest(requestId);
  if (outstanding.length > 0 || request?.status !== "awaiting_quotes") return;

  await resumeAfterQuotes(requestId, {
    id: "supplier-portal",
    name: "Supplier portal",
    role: "system",
  });
}
