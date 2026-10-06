import {
  getComparison,
  getNegotiation,
  getQuote,
  getRequestSpec,
  insertPurchaseOrder,
  nextPoNumber,
  updateRequest,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import type { PurchaseOrder, RiskFlag } from "@/lib/domain/types";
import { addDays, formatDate, round, todayIso } from "@/lib/util";
import { narrateSummary } from "./llm";
import { SHIP_TO, type Agent, type AgentContext, type AgentResult } from "./types";

export interface PoAgentInput {
  totalAmount: number;
  currency: string;
  approvalsCleared: boolean;
  blockingFlags: RiskFlag[];
}

export interface PoAgentOutput {
  purchaseOrder: PurchaseOrder | null;
  skipped: boolean;
  reason: string | null;
}

export const poAgent: Agent<PoAgentInput, PoAgentOutput> = {
  name: "po",
  async run(context: AgentContext, input: PoAgentInput): Promise<AgentResult<PoAgentOutput>> {
    const { request } = context;
    const comparison = getComparison(request.id);
    const quoteId = comparison?.recommendedQuoteId ?? null;
    const spec = getRequestSpec(request.id);
    const negotiation = getNegotiation(request.id);

    if (!quoteId || !spec) {
      const reason = "No recommended quotation is available to raise a purchase order against.";
      return {
        summary: reason,
        output: { purchaseOrder: null, skipped: true, reason },
        detail: null,
      };
    }

    if (!input.approvalsCleared) {
      const reason = "Approvals are still outstanding, so no purchase order was raised.";
      return {
        summary: reason,
        output: { purchaseOrder: null, skipped: true, reason },
        detail: null,
      };
    }

    // The risk agent's critical flags are a commitment, not advice. An award
    // cannot be converted into a PO while one is unresolved, otherwise the
    // control is decorative.
    if (input.blockingFlags.length > 0) {
      const reason = `Blocked by ${input.blockingFlags.length} unresolved critical risk finding${
        input.blockingFlags.length === 1 ? "" : "s"
      } (${input.blockingFlags.map((flag) => flag.code).join(", ")}). An approver has to record an exception before the PO can be raised.`;
      return {
        summary: reason,
        output: { purchaseOrder: null, skipped: true, reason },
        detail: { blockingFlags: input.blockingFlags },
      };
    }

    const recommendedRow = comparison?.rows.find(
      (row) => row.quoteId === comparison.recommendedQuoteId,
    );
    if (!comparison || !recommendedRow) {
      const reason = "The recommended quote could not be resolved to a supplier.";
      return {
        summary: reason,
        output: { purchaseOrder: null, skipped: true, reason },
        detail: null,
      };
    }

    const quantity = request.quantity ?? spec.quantity;
    const unitPrice = negotiation?.agreedUnitPrice ?? recommendedRow.unitPrice;
    const subtotal = round(unitPrice * quantity, 2);
    const shippingCost = round(subtotal * 0.012, 2);
    const taxAmount = round((subtotal + shippingCost) * 0.15, 2);
    const totalAmount = round(subtotal + shippingCost + taxAmount, 2);

    const quote = getQuote(quoteId);
    const leadTimeDays = quote?.leadTimeDays ?? 14;
    const promisedDelivery = addDays(todayIso(), leadTimeDays);
    const meetsDeadline = request.neededBy === null || promisedDelivery <= request.neededBy;
    const expectedDelivery = meetsDeadline ? promisedDelivery : request.neededBy!;

    const poNumber = nextPoNumber();

    // The order and the status it implies are one outcome. Splitting them could
    // leave a purchase order committed against a request that never moved to
    // po_issued, which reads as a request that was sourced but not awarded.
    const purchaseOrder = withTransaction(() => {
      const created = insertPurchaseOrder({
        requestId: request.id,
        poNumber,
        quoteId,
        supplierId: recommendedRow.supplierId,
        supplierName: recommendedRow.supplierName,
        currency: request.currency,
        subtotal,
        shippingCost,
        taxAmount,
        totalAmount,
        paymentTerms: negotiation?.agreedUnitPrice ? "Net 45" : "Net 30",
        incoterms: "DDP Johannesburg",
        shipTo: SHIP_TO,
        lineItems: [
          {
            description: `${spec.summary.split(":")[1]?.trim() ?? request.title} — ${recommendedRow.supplierName}`,
            quantity,
            unit: spec.unit,
            unitPrice,
            lineTotal: subtotal,
          },
        ],
        expectedDelivery,
        status: "issued",
        issuedAt: new Date().toISOString(),
      });

      updateRequest(request.id, { status: "po_issued" });
      return created;
    });

    const lateWarning = meetsDeadline
      ? ""
      : ` Lead time of ${leadTimeDays} days lands after the required ${formatDate(request.neededBy)}, so the supplier has been committed to the required date at their own risk.`;

    const summary = await narrateSummary({
      agent: "PO",
      title: request.title,
      facts: `PO ${poNumber} against ${recommendedRow.supplierName} for ${request.currency} ${Math.round(totalAmount).toLocaleString("en-ZA")}. Delivery expected ${formatDate(expectedDelivery)}.`,
      fallback: `Purchase order ${poNumber} raised against ${recommendedRow.supplierName} for ${request.currency} ${Math.round(totalAmount).toLocaleString("en-ZA")}, delivery expected ${formatDate(expectedDelivery)}.${lateWarning}`,
    });

    return {
      summary,
      output: { purchaseOrder, skipped: false, reason: null },
      detail: { ...purchaseOrder, leadTimeDays, meetsDeadline },
    };
  },
};
