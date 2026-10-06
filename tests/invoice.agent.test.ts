import { describe, it, expect } from "vitest";
import { setupTestDb, approveEverything, resolveAllBlockers } from "./helpers";
import {
  createRequest,
  getPurchaseOrder,
  type NewRequest,
} from "@/lib/db/repository";
import { runSourcingPipeline, submitInvoice } from "@/lib/pipeline";
import { getRequestBundle } from "@/lib/queries";
import { round } from "@/lib/util";

setupTestDb();

const CRM_REQUEST: NewRequest = {
  title: "Annual CRM licence renewal",
  rawDescription:
    "Our CRM licence renewal is due. 85 users, enterprise tier with advanced reporting. " +
    "Must be POPIA compliant and we need an ISO 27001 certified vendor given we hold customer data. " +
    "Roughly R250,000 a year.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Sales",
  unit: "seat",
  quantity: 85,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

async function requestWithIssuedPo() {
  const request = createRequest(CRM_REQUEST);
  await runSourcingPipeline(request.id);
  resolveAllBlockers(request.id);
  await approveEverything(request.id);
  const po = getPurchaseOrder(request.id);
  expect(po).not.toBeNull();
  return { request, po: po! };
}

describe("invoice agent — three-way match", () => {
  it("approves a clean invoice at the exact PO total with VAT at 15%", async () => {
    const { po } = await requestWithIssuedPo();
    const taxableBase = round(po.subtotal + po.shippingCost, 2);
    const expectedTax = round(taxableBase * 0.15, 2);

    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-CLEAN-1",
      invoiceAmount: taxableBase,
      taxAmount: expectedTax,
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    expect(bundle.invoice?.match?.verdict).toBe("approve");
    expect(bundle.invoice?.taxAmount).toBe(expectedTax);
    expect(bundle.request.status).toBe("invoice_submitted");
    expect(bundle.invoice?.match?.checks.every((check) => check.status === "pass"))
      .toBe(true);
  });

  it("rejects an invoice billed 8% above the PO and keeps the request payable-state clean", async () => {
    const { po } = await requestWithIssuedPo();
    const over = round((po.subtotal + po.shippingCost) * 1.085, 2);

    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-OVER-1",
      invoiceAmount: over,
      taxAmount: round(over * 0.15, 2),
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    expect(bundle.invoice?.match?.verdict).toBe("reject");
    expect(bundle.invoice?.match?.checks.some((check) => check.code === "total" && check.status === "fail"))
      .toBe(true);
    expect(bundle.invoice?.match?.checks.some((check) => check.code === "unit_price" && check.status === "fail"))
      .toBe(true);
    // A rejected invoice must not move the request to a paid state.
    expect(bundle.request.status).toBe("po_issued");
  });

  it("queries a single under-billing variance instead of rejecting", async () => {
    const { po } = await requestWithIssuedPo();
    const taxableBase = round(po.subtotal + po.shippingCost, 2);

    // Billed at the exact taxable base but with tax well below the expected
    // 15%, so the only failing check is an under-billed total.
    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-UNDER-1",
      invoiceAmount: taxableBase,
      taxAmount: round(taxableBase * 0.1, 2),
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    expect(bundle.invoice?.match?.verdict).toBe("query");
    const failures = bundle.invoice?.match?.checks.filter((check) => check.status === "fail") ?? [];
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((check) => check.code !== "supplier" && check.code !== "duplicate"))
      .toBe(true);
    expect(bundle.invoice?.match?.varianceAmount).toBeLessThan(0);
  });

  it("rejects a duplicate invoice number already used by another request", async () => {
    const { po } = await requestWithIssuedPo();
    const taxableBase = round(po.subtotal + po.shippingCost, 2);
    const tax = round(taxableBase * 0.15, 2);

    // A second, unrelated order invoices under the same number first. When the
    // number is then used here the duplicate must be caught, because the
    // supplier cannot legitimately invoice two orders with one number.
    const other = await requestWithIssuedPo();
    await submitInvoice(other.request.id, {
      invoiceNumber: "INV-DUP-1",
      invoiceAmount: round(other.po.subtotal + other.po.shippingCost, 2),
      taxAmount: round((other.po.subtotal + other.po.shippingCost) * 0.15, 2),
      receivedDate: other.po.expectedDelivery,
    });

    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-DUP-1",
      invoiceAmount: taxableBase,
      taxAmount: tax,
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    expect(bundle.invoice?.match?.verdict).toBe("reject");
    const duplicate = bundle.invoice?.match?.checks.find((check) => check.code === "duplicate");
    expect(duplicate?.status).toBe("fail");
  });
});

describe("invoice agent — VAT reconciliation", () => {
  it("calculates expected VAT as exactly 15% of the taxable base", async () => {
    const { po } = await requestWithIssuedPo();
    const taxableBase = round(po.subtotal + po.shippingCost, 2);
    const expectedTax = round(taxableBase * 0.15, 2);
    expect(po.taxAmount).toBe(expectedTax);
  });
});