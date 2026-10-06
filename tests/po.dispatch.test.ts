import { describe, expect, it, vi } from "vitest";
import { setupTestDb, approveEverything, resolveAllBlockers } from "./helpers";

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: {
      id: "usr_test_lead",
      name: "Nomsa Khumalo",
      email: "nomsa.khumalo@procura.co.za",
      role: "procurement_lead",
    },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { auth } from "@/auth";
import { listAudit } from "@/lib/db/audit";
import {
  createRequest,
  getPurchaseOrder,
  type NewRequest,
} from "@/lib/db/repository";
import {
  acknowledgePurchaseOrderAction,
  dispatchPurchaseOrderAction,
} from "@/app/actions";
import { runSourcingPipeline } from "@/lib/pipeline";

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

async function requestWithIssuedPo() {
  const request = createRequest(MID_SIZE_REQUEST);
  await runSourcingPipeline(request.id);
  resolveAllBlockers(request.id);
  await approveEverything(request.id);
  const po = getPurchaseOrder(request.id);
  expect(po).not.toBeNull();
  return po!;
}

describe("PO dispatch", () => {
  it("records how the order went out, exactly once", async () => {
    const po = await requestWithIssuedPo();
    expect(po.dispatchedAt).toBeNull();
    expect(po.dispatchChannel).toBeNull();

    const first = await dispatchPurchaseOrderAction(po.requestId, "email");
    expect(first.ok).toBe(true);

    const stored = getPurchaseOrder(po.requestId)!;
    expect(stored.dispatchedAt).not.toBeNull();
    expect(stored.dispatchChannel).toBe("email");
    expect(stored.status).toBe("issued");

    const entries = listAudit(po.requestId).filter(
      (entry) => entry.action === "po.dispatched",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({
      poNumber: po.poNumber,
      channel: "email",
    });

    const second = await dispatchPurchaseOrderAction(po.requestId, "edi");
    expect(second.ok).toBe(false);
    expect(getPurchaseOrder(po.requestId)!.dispatchChannel).toBe("email");
  });

  it("refuses to dispatch for a role outside the dispatch allow-list", async () => {
    const po = await requestWithIssuedPo();

    vi.mocked(auth).mockResolvedValueOnce({
      user: {
        id: "usr_requester",
        name: "Amahle Dlamini",
        email: "amahle.dlamini@procura.co.za",
        role: "requester",
      },
    } as never);

    const result = await dispatchPurchaseOrderAction(po.requestId, "email");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot do this/i);
    expect(getPurchaseOrder(po.requestId)!.dispatchedAt).toBeNull();
  });
});

describe("PO acknowledgement", () => {
  it("refuses an acknowledgement for a PO the supplier never received", async () => {
    const po = await requestWithIssuedPo();

    const result = await acknowledgePurchaseOrderAction(po.requestId, "ACK-1");
    expect(result.ok).toBe(false);
    expect(getPurchaseOrder(po.requestId)!.acknowledgedAt).toBeNull();
  });

  it("records the supplier's confirmation against the dispatched order", async () => {
    const po = await requestWithIssuedPo();
    await dispatchPurchaseOrderAction(po.requestId, "portal");

    const result = await acknowledgePurchaseOrderAction(po.requestId, "SC-88213");
    expect(result.ok).toBe(true);

    const stored = getPurchaseOrder(po.requestId)!;
    expect(stored.acknowledgedAt).not.toBeNull();
    expect(stored.ackReference).toBe("SC-88213");
    expect(stored.status).toBe("acknowledged");
    expect(stored.dispatchChannel).toBe("portal");

    const entries = listAudit(po.requestId).filter(
      (entry) => entry.action === "po.acknowledged",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({ reference: "SC-88213" });
  });

  it("does not acknowledge the same order twice", async () => {
    const po = await requestWithIssuedPo();
    await dispatchPurchaseOrderAction(po.requestId, "email");
    await acknowledgePurchaseOrderAction(po.requestId, "SC-1");

    const second = await acknowledgePurchaseOrderAction(po.requestId, "SC-2");
    expect(second.ok).toBe(false);
    expect(getPurchaseOrder(po.requestId)!.ackReference).toBe("SC-1");
  });
});
