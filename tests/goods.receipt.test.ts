import { describe, expect, it, vi } from "vitest";
import { setupTestDb, approveEverything, resolveAllBlockers } from "./helpers";

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: {
      id: "usr_test_receiver",
      name: "Amahle Dlamini",
      email: "amahle.dlamini@procura.co.za",
      role: "requester",
    },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listAudit } from "@/lib/db/audit";
import {
  createRequest,
  getGoodsReceipt,
  getPurchaseOrder,
  type NewRequest,
} from "@/lib/db/repository";
import { recordGoodsReceiptAction } from "@/app/actions";
import { runSourcingPipeline, submitInvoice } from "@/lib/pipeline";
import { getRequestBundle } from "@/lib/queries";
import { round } from "@/lib/util";

setupTestDb();

const CRM_REQUEST: NewRequest = {
  title: "Annual CRM licence renewal",
  rawDescription:
    "Our CRM licence renewal is due. 85 users, enterprise tier with advanced reporting. " +
    "Must be POPIA compliant and we need an ISO 27001 certified vendor. Roughly R250,000 a year.",
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
  return po!;
}

function receiptLines(
  po: NonNullable<ReturnType<typeof getPurchaseOrder>>,
  received: number,
) {
  return po.lineItems.map((line) => ({
    description: line.description,
    ordered: line.quantity,
    received,
    unit: line.unit,
  }));
}

describe("goods receipt notes", () => {
  it("refuses a receipt against a request with no purchase order", async () => {
    const request = createRequest(CRM_REQUEST);

    const result = await recordGoodsReceiptAction(request.id, {
      lines: [{ description: "Seats", ordered: 85, received: 85, unit: "seat" }],
    });

    expect(result.ok).toBe(false);
    expect(getGoodsReceipt(request.id)).toBeNull();
  });

  it("marks the order fulfilled when every line is fully received", async () => {
    const po = await requestWithIssuedPo();

    const result = await recordGoodsReceiptAction(po.requestId, {
      lines: receiptLines(po, 85),
      notes: "Delivered to reception, checked against the packing list.",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/fully received/i);

    const receipt = getGoodsReceipt(po.requestId)!;
    expect(receipt.status).toBe("complete");
    expect(receipt.receiptNumber).toMatch(/^GRN-\d{4}-\d{4}$/);
    expect(receipt.receivedBy).toBe("Amahle Dlamini");
    expect(receipt.lines[0].received).toBe(85);
    expect(getPurchaseOrder(po.requestId)!.status).toBe("fulfilled");

    const entries = listAudit(po.requestId).filter(
      (entry) => entry.action === "goods_receipt.recorded",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({
      receiptNumber: receipt.receiptNumber,
      status: "complete",
    });
  });

  it("keeps the order open while the delivery is only partial", async () => {
    const po = await requestWithIssuedPo();

    const result = await recordGoodsReceiptAction(po.requestId, {
      lines: receiptLines(po, 40),
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/partial delivery/i);

    const receipt = getGoodsReceipt(po.requestId)!;
    expect(receipt.status).toBe("partial");
    expect(receipt.lines[0].received).toBe(40);
    expect(getPurchaseOrder(po.requestId)!.status).not.toBe("fulfilled");
  });
});

describe("three-way match against the receipt", () => {
  it("approves an invoice for what the receipt says arrived", async () => {
    const po = await requestWithIssuedPo();
    await recordGoodsReceiptAction(po.requestId, { lines: receiptLines(po, 85) });

    const taxableBase = round(po.subtotal + po.shippingCost, 2);
    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-GRN-PASS",
      invoiceAmount: taxableBase,
      taxAmount: round(taxableBase * 0.15, 2),
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    const check = bundle.invoice?.match?.checks.find(
      (candidate) => candidate.code === "goods_receipt",
    );
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
    expect(bundle.invoice?.match?.verdict).toBe("approve");
    expect(bundle.request.status).toBe("invoice_submitted");
  });

  it("rejects an invoice billed in full against a short delivery", async () => {
    const po = await requestWithIssuedPo();
    await recordGoodsReceiptAction(po.requestId, { lines: receiptLines(po, 40) });

    // The supplier bills for the whole order although only 40 of 85 seats
    // arrived. The receipt is the evidence, so the mismatch must reject.
    const taxableBase = round(po.subtotal + po.shippingCost, 2);
    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-GRN-OVER",
      invoiceAmount: taxableBase,
      taxAmount: round(taxableBase * 0.15, 2),
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    const check = bundle.invoice?.match?.checks.find(
      (candidate) => candidate.code === "goods_receipt",
    );
    expect(check?.status).toBe("fail");
    expect(bundle.invoice?.match?.verdict).toBe("reject");
    expect(bundle.request.status).toBe("po_issued");
  });

  it("queries a supplier who billed for less than the receipt records", async () => {
    const po = await requestWithIssuedPo();
    await recordGoodsReceiptAction(po.requestId, { lines: receiptLines(po, 85) });

    const line = po.lineItems[0];
    const short = round(line.unitPrice * (line.quantity - 5) + po.shippingCost, 2);
    await submitInvoice(po.requestId, {
      invoiceNumber: "INV-GRN-UNDER",
      invoiceAmount: short,
      taxAmount: round(short * 0.15, 2),
      receivedDate: po.expectedDelivery,
    });

    const bundle = getRequestBundle(po.requestId)!;
    const check = bundle.invoice?.match?.checks.find(
      (candidate) => candidate.code === "goods_receipt",
    );
    expect(check?.status).toBe("warn");
    expect(bundle.invoice?.match?.verdict).toBe("query");
  });
});
