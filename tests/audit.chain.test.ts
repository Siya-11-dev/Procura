import { describe, it, expect } from "vitest";
import { setupTestDb, approveEverything } from "./helpers";
import { createRequest, type NewRequest } from "@/lib/db/repository";
import { getDb } from "@/lib/db/client";
import { getPurchaseOrder } from "@/lib/db/repository";
import { runSourcingPipeline, submitInvoice } from "@/lib/pipeline";
import { appendAudit, verifyAuditChain } from "@/lib/db/audit";
import { round } from "@/lib/util";

setupTestDb();

const REQUEST: NewRequest = {
  title: "Audit trail test",
  rawDescription:
    "Integration test request used to verify the append-only audit chain records pipeline activity.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Test Department",
  unit: "units",
  quantity: 2,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

describe("audit chain", () => {
  it("verifies a chain built by a full pipeline run", async () => {
    const request = createRequest(REQUEST);
    await runSourcingPipeline(request.id);

    const result = verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBeGreaterThan(10);
  });

  it("records a matching grant and an invoice decision", async () => {
    const request = createRequest(REQUEST);
    await runSourcingPipeline(request.id);

    appendAudit({
      requestId: request.id,
      actor: "test-actor",
      actorRole: "compliance_officer",
      action: "risk.exception_granted",
      entityType: "risk_exception",
      entityId: "delivery_date_missed",
      detail: { justification: "Expedited freight was approved." },
    });

    await approveEverything(request.id);
    const po = getPurchaseOrder(request.id);
    if (po) {
      await submitInvoice(po.requestId, {
        invoiceNumber: "AUDIT-INV-1",
        invoiceAmount: round(po.subtotal + po.shippingCost, 2),
        taxAmount: po.taxAmount,
        receivedDate: po.expectedDelivery,
      });
    }

    expect(verifyAuditChain().valid).toBe(true);
  });

  it("forbids updates and deletes at the storage layer", () => {
    const request = createRequest(REQUEST);
    appendAudit({
      requestId: request.id,
      actor: "test-actor",
      actorRole: "admin",
      action: "request.created",
      entityType: "request",
      entityId: request.id,
      detail: {},
    });

    const db = getDb();
    expect(() =>
      db.prepare("UPDATE audit_log SET actor = 'rogue' WHERE seq = 1").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM audit_log WHERE seq = 1").run(),
    ).toThrow(/append-only/);
  });

  it("detects a rewritten entry when the write-guard is removed", async () => {
    const request = createRequest(REQUEST);
    await runSourcingPipeline(request.id);
    expect(verifyAuditChain().valid).toBe(true);

    const db = getDb();
    db.exec("DROP TRIGGER audit_log_no_update");
    db.prepare("UPDATE audit_log SET action = 'tampered' WHERE seq = 1").run();

    const result = verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).not.toBeNull();
  });
});