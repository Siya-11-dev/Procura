import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb, approveEverything, resolveAllBlockers } from "./helpers";
import {
  createRequest,
  getPurchaseOrder,
  insertRiskException,
  listRisk,
  type NewRequest,
} from "@/lib/db/repository";
import { raisePurchaseOrder, runSourcingPipeline } from "@/lib/pipeline";

setupTestDb();

const MID_SIZE_REQUEST: NewRequest = {
  title: "Annual CRM licence renewal",
  rawDescription:
    "Our CRM licence renewal is due. 85 users, enterprise tier with advanced reporting. " +
    "Must be POPIA compliant and ISO 27001 certified. Roughly R250,000 a year.",
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

describe("PO agent — issuance gates", () => {
  it("does not raise a PO while approvals are still outstanding", async () => {
    const request = createRequest(MID_SIZE_REQUEST);
    await runSourcingPipeline(request.id);

    expect(getPurchaseOrder(request.id)).toBeNull();
    expect(request.status !== "po_issued");
  });

  it("raises the PO once every approval is cleared and blockers are waived", async () => {
    const request = createRequest(MID_SIZE_REQUEST);
    await runSourcingPipeline(request.id);
    resolveAllBlockers(request.id);
    await approveEverything(request.id);

    const po = getPurchaseOrder(request.id);
    expect(po).not.toBeNull();
    expect(po?.poNumber).toMatch(/^PO-\d{4}-\d{4}$/);
  });
});

describe("PO agent — risk blockers", () => {
  let requestId: string;

  beforeEach(async () => {
    // Deliveries cannot meet a deadline that is already in the past, so the
    // risk agent raises a critical delivery flag on the recommended supplier.
    const overdue = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const request = createRequest({
      ...MID_SIZE_REQUEST,
      neededBy: overdue,
      urgency: "critical",
    });
    requestId = request.id;
    await runSourcingPipeline(requestId);
  });

  it("stops the PO while an unresolved critical finding blocks the award", async () => {
    const critical = listRisk(requestId)
      .find((risk) => risk.isRecommended)
      ?.flags.filter((flag) => flag.severity === "critical") ?? [];

    expect(critical.length).toBeGreaterThan(0);

    await approveEverything(requestId);
    expect(getPurchaseOrder(requestId)).toBeNull();
  });

  it("releases the PO once an approver records a written exception", async () => {
    await approveEverything(requestId);
    expect(getPurchaseOrder(requestId)).toBeNull();

    const recommended = listRisk(requestId).find((risk) => risk.isRecommended)!;
    const blocking = recommended.flags.find((flag) => flag.severity === "critical");
    expect(blocking).toBeDefined();

    for (const flag of recommended.flags.filter(
      (candidate) => candidate.severity === "critical",
    )) {
      insertRiskException({
        requestId,
        flagCode: flag.code,
        justification: "Delivery can be met through expedited freight on this order.",
        approverName: "Test Approver",
      });
    }
    await raisePurchaseOrder(requestId);

    const po = getPurchaseOrder(requestId);
    expect(po).not.toBeNull();
  });
});