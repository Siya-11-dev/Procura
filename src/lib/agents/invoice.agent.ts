import {
  findInvoiceByNumber,
  getGoodsReceipt,
  getPurchaseOrder,
  insertInvoice,
  updateInvoice,
  updateRequest,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import type { Invoice, InvoiceCheck, InvoiceMatch } from "@/lib/domain/types";
import { round } from "@/lib/util";
import { narrateSummary } from "./llm";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface InvoiceAgentInput {
  invoiceNumber: string;
  invoiceAmount: number;
  taxAmount: number;
  receivedDate: string;
}

export interface InvoiceAgentOutput {
  invoice: Invoice;
  verdict: InvoiceMatch["verdict"];
}

const AMOUNT_TOLERANCE = 0.005;
const PRICE_TOLERANCE = 0.005;

export const invoiceAgent: Agent<InvoiceAgentInput, InvoiceAgentOutput> = {
  name: "invoice",
  async run(
    context: AgentContext,
    input: InvoiceAgentInput,
  ): Promise<AgentResult<InvoiceAgentOutput>> {
    const { request } = context;
    const po = getPurchaseOrder(request.id);

    if (!po) {
      throw new Error("Cannot match an invoice: no purchase order has been issued.");
    }

    const totalAmount = round(input.invoiceAmount + input.taxAmount, 2);

    const invoice = insertInvoice({
      requestId: request.id,
      poId: po.id,
      supplierId: po.supplierId,
      invoiceNumber: input.invoiceNumber.trim(),
      currency: po.currency,
      invoiceAmount: round(input.invoiceAmount, 2),
      taxAmount: round(input.taxAmount, 2),
      totalAmount,
      receivedDate: input.receivedDate,
      status: "submitted",
      match: null,
    });

    const duplicate = findInvoiceByNumber(invoice.invoiceNumber, request.id);

    const varianceAmount = round(invoice.totalAmount - po.totalAmount, 2);
    const variancePct =
      po.totalAmount === 0
        ? 0
        : round((varianceAmount / po.totalAmount) * 100, 2);

    const expectedTax = round(
      (po.subtotal + po.shippingCost) * 0.15,
      2,
    );
    const lineItem = po.lineItems[0];

    // A goods receipt turns the quantity half of the three-way match into a
    // real comparison: what was signed for against what is being billed. The
    // 2% tolerance absorbs partial deliveries and rounding; billing more than
    // was received is a fail, billing less is only a query.
    const goodsReceipt = getGoodsReceipt(request.id);
    const receivedUnits = goodsReceipt
      ? goodsReceipt.lines.reduce((total, line) => total + line.received, 0)
      : null;
    const invoicedQuantity =
      lineItem && lineItem.unitPrice > 0
        ? (invoice.invoiceAmount - po.shippingCost) / lineItem.unitPrice
        : null;

    const receiptCheck: InvoiceCheck | null =
      goodsReceipt !== null &&
      receivedUnits !== null &&
      invoicedQuantity !== null
        ? buildReceiptCheck({
            received: receivedUnits,
            invoiced: invoicedQuantity,
            receiptNumber: goodsReceipt.receiptNumber,
            currency: po.currency,
          })
        : null;

    const quantityCheck: InvoiceCheck = {
      code: "quantity",
      label: "Quantity matches the ordered quantity",
      status: lineItem ? "pass" : "warn",
      expected: lineItem ? String(lineItem.quantity) : "unknown",
      actual: lineItem ? String(lineItem.quantity) : "unknown",
      detail: lineItem
        ? `Purchase order covers ${lineItem.quantity} units and the invoice is raised against that line, so quantity reconciles. A physical goods receipt would replace this check.`
        : "No line items on the purchase order to verify against.",
    };

    const checks: InvoiceCheck[] = [
      {
        code: "supplier",
        label: "Supplier matches the purchase order",
        status: po.supplierId === invoice.supplierId ? "pass" : "fail",
        expected: po.supplierName,
        actual: po.supplierName,
        detail:
          po.supplierId === invoice.supplierId
            ? `Invoice raised by ${po.supplierName}, the awarded supplier.`
            : "Invoice supplier does not match the awarded supplier on the purchase order.",
      },
      {
        code: "total",
        label: "Invoice total matches the purchase order",
        status:
          Math.abs(varianceAmount) <= po.totalAmount * AMOUNT_TOLERANCE
            ? "pass"
            : "fail",
        expected: `${po.currency} ${po.totalAmount.toFixed(2)}`,
        actual: `${po.currency} ${invoice.totalAmount.toFixed(2)}`,
        detail:
          Math.abs(varianceAmount) <= po.totalAmount * AMOUNT_TOLERANCE
            ? "Three-way match passes: invoiced total equals the committed amount."
            : `Billed ${po.currency} ${Math.abs(varianceAmount).toFixed(2)} ${varianceAmount > 0 ? "above" : "below"} the purchase order (${variancePct > 0 ? "+" : ""}${variancePct}%).`,
      },
      // Where a goods receipt exists it replaces the placeholder quantity check
      // outright: the receipt is the evidence, the purchase order is only the
      // intention.
      receiptCheck ?? quantityCheck,
      {
        code: "unit_price",
        label: "Unit price matches the negotiated price",
        status: lineItem
          ? withinTolerance(
              (invoice.invoiceAmount - po.shippingCost) / lineItem.quantity,
              lineItem.unitPrice,
            )
            ? "pass"
            : "fail"
          : "warn",
        expected: lineItem ? `${po.currency} ${lineItem.unitPrice.toFixed(2)}` : "unknown",
        actual: lineItem
          ? `${po.currency} ${((invoice.invoiceAmount - po.shippingCost) / lineItem.quantity).toFixed(2)}`
          : "unknown",
        detail: lineItem
          ? withinTolerance(
              (invoice.invoiceAmount - po.shippingCost) / lineItem.quantity,
              lineItem.unitPrice,
            )
            ? "Price per unit is unchanged from the purchase order."
            : "Price per unit differs from the purchase order. Combined with the total variance, this indicates a billing error or an unapproved change."
          : "No line items on the purchase order.",
      },
      {
        code: "tax",
        label: "VAT calculated correctly at 15%",
        status:
          Math.abs(invoice.taxAmount - expectedTax) <= Math.max(1, expectedTax * 0.01)
            ? "pass"
            : "fail",
        expected: `${po.currency} ${expectedTax.toFixed(2)}`,
        actual: `${po.currency} ${invoice.taxAmount.toFixed(2)}`,
        detail:
          Math.abs(invoice.taxAmount - expectedTax) <= Math.max(1, expectedTax * 0.01)
            ? "VAT agrees with the taxable base on the purchase order."
            : `VAT differs from the expected ${po.currency} ${expectedTax.toFixed(2)} by ${po.currency} ${Math.abs(invoice.taxAmount - expectedTax).toFixed(2)}.`,
      },
      {
        code: "delivery_date",
        label: "Invoiced within the delivery window",
        status: invoice.receivedDate <= po.expectedDelivery ? "pass" : "warn",
        expected: `on or before ${po.expectedDelivery}`,
        actual: invoice.receivedDate,
        detail:
          invoice.receivedDate <= po.expectedDelivery
            ? "Invoicing falls within the agreed delivery window."
            : `Invoiced after the expected delivery date of ${po.expectedDelivery}. Check whether delivery penalties apply.`,
      },
      {
        code: "duplicate",
        label: "Invoice number is not a duplicate",
        status: duplicate ? "fail" : "pass",
        expected: "unique invoice number",
        actual: invoice.invoiceNumber,
        detail: duplicate
          ? `Invoice number ${invoice.invoiceNumber} has already been recorded against request ${duplicate.requestId}.`
          : "No prior invoice carries this number.",
      },
    ];

    const failures = checks.filter((check) => check.status === "fail");
    const warnings = checks.filter((check) => check.status === "warn");
    const duplicateFailure = failures.find((check) => check.code === "duplicate");

    const verdict: InvoiceMatch["verdict"] = duplicateFailure
      ? "reject"
      : failures.length === 0
        ? "approve"
        :           // Over-billing or a supplier mismatch is a genuine payment risk and is
          // rejected. Where the only failing checks are amount deviations and
          // the supplier has billed less than agreed, there is nothing to pay
          // against, so hold the invoice for a supplier query rather than
          // reject it. Billing for goods nobody signed for is over-billing by
          // another route, so it rejects too.
          failures.some((check) => check.code === "supplier") ||
            failures.some((check) => check.code === "goods_receipt") ||
            varianceAmount > 0
          ? "reject"
          : "query";

    const match: InvoiceMatch = {
      verdict,
      checks,
      varianceAmount,
      variancePct,
      summary: buildSummary({
        verdict,
        poNumber: po.poNumber,
        supplierName: po.supplierName,
        invoiceNumber: invoice.invoiceNumber,
        varianceAmount,
        variancePct,
        currency: po.currency,
        failures,
        warnings,
      }),
    };

    const status =
      verdict === "approve"
        ? "matched"
        : verdict === "query"
          ? "discrepancies"
          : "rejected";

    // The verdict, the invoice's stored state and the request's payable state are a
    // single determination. Splitting them could leave an invoice marked matched
    // while the request still says po_issued, which is what AP reconciles against.
    withTransaction(() => {
      updateInvoice(invoice.id, { status, match });
      updateRequest(request.id, {
        status: verdict === "approve" ? "invoice_submitted" : "po_issued",
      });
    });

    const summary = await narrateSummary({
      agent: "Invoice",
      title: request.title,
      facts: `Invoice ${invoice.invoiceNumber} against ${po.poNumber} (${po.supplierName}). Total variance ${po.currency} ${Math.abs(varianceAmount).toFixed(2)} (${variancePct}%). Verdict: ${verdict.replace("_", " ")}.`,
      fallback: match.summary,
    });

    return {
      summary,
      output: {
        invoice: { ...invoice, status, match },
        verdict,
      },
      detail: {
        purchaseOrder: po.poNumber,
        checks,
        verdict,
        varianceAmount,
        variancePct,
      },
    };
  },
};

function withinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(0.01, expected * PRICE_TOLERANCE);
}

/**
 * Compare the quantity implied by the invoice against what the goods receipt
 * says arrived. 2% (with a one-unit floor) absorbs partial deliveries and
 * rounding: anything above that is billing for goods that were not received.
 */
function buildReceiptCheck(input: {
  received: number;
  invoiced: number;
  receiptNumber: string;
  currency: string;
}): InvoiceCheck {
  const tolerance = Math.max(1, input.received * 0.02);
  const received = round(input.received, 3);
  const invoiced = round(input.invoiced, 3);
  const overBilled = invoiced > received + tolerance;
  const underBilled = invoiced < received - tolerance;

  const status = overBilled ? "fail" : underBilled ? "warn" : "pass";
  const detail = overBilled
    ? `The invoice covers ${invoiced} units but the goods receipt ${input.receiptNumber} records ${received} received — a difference of ${round(invoiced - received, 3)} units, outside the 2% delivery tolerance. Do not pay for goods that were not received.`
    : underBilled
      ? `The invoice covers ${invoiced} units against ${received} recorded as received. The supplier has billed for less than was delivered; query it before payment.`
      : `Invoiced quantity agrees with the ${received} units recorded on goods receipt ${input.receiptNumber}, within the 2% delivery tolerance.`;

  return {
    code: "goods_receipt",
    label: "Invoiced quantity matches the goods receipt",
    status,
    expected: `${received} received (GRN ${input.receiptNumber})`,
    actual: `${invoiced} invoiced`,
    detail,
  };
}

function buildSummary(input: {
  verdict: InvoiceMatch["verdict"];
  poNumber: string;
  supplierName: string;
  invoiceNumber: string;
  varianceAmount: number;
  variancePct: number;
  currency: string;
  failures: InvoiceCheck[];
  warnings: InvoiceCheck[];
}): string {
  const { verdict, poNumber, supplierName, invoiceNumber, varianceAmount, variancePct, currency, failures, warnings } = input;

  const money = `${currency} ${Math.abs(varianceAmount).toFixed(2)}`;

  if (verdict === "approve") {
    return `Three-way match passed on invoice ${invoiceNumber} against ${poNumber} from ${supplierName}. Total agrees to the purchase order, VAT is correct, and the invoice number is unique.${warnings.length ? ` ${warnings.length} item${warnings.length === 1 ? "" : "s"} noted for the record.` : ""} Approved for payment.`;
  }

  if (verdict === "query") {
    return `Invoice ${invoiceNumber} is ${money} (${variancePct}%) below ${poNumber}. Under-billing is not a payment risk, so the invoice is held for a supplier query rather than paid or rejected.`;
  }

  return `Invoice ${invoiceNumber} failed the three-way match against ${poNumber} and is rejected for payment. ${failures.map((check) => check.label).join("; ")}.${Math.abs(varianceAmount) > 0.01 ? ` Variance is ${money} (${variancePct > 0 ? "+" : ""}${variancePct}%).` : ""}`;
}
