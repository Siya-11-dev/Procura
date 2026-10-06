import { describe, it, expect } from "vitest";
import { setupTestDb } from "./helpers";
import { getDb, inTransaction, withTransaction } from "@/lib/db/client";
import { appendAudit, verifyAuditChain } from "@/lib/db/audit";
import {
  createRequest,
  getRequest,
  insertRiskException,
  listApprovals,
  updateRequest,
  type NewRequest,
} from "@/lib/db/repository";

setupTestDb();

const REQUEST: NewRequest = {
  title: "Transaction test",
  rawDescription:
    "Request used to prove that grouped writes either all commit or none do.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Test Department",
  unit: "units",
  quantity: 1,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

/** Distinct from the request's own value, so a rollback is observable. */
const CHANGED_URGENCY = "critical" as const;

describe("withTransaction", () => {
  it("commits every write when the body returns normally", () => {
    const request = createRequest(REQUEST);

    withTransaction(() => {
      updateRequest(request.id, { quantity: 42 });
      updateRequest(request.id, { urgency: CHANGED_URGENCY });
    });

    const stored = getRequest(request.id);
    expect(stored?.quantity).toBe(42);
    expect(stored?.urgency).toBe(CHANGED_URGENCY);
  });

  it("returns the body's value to the caller", () => {
    expect(withTransaction(() => 42)).toBe(42);
  });

  it("discards every write when the body throws", () => {
    const request = createRequest(REQUEST);
    const original = getRequest(request.id)!.urgency;

    expect(() =>
      withTransaction(() => {
        updateRequest(request.id, { urgency: CHANGED_URGENCY });
        throw new Error("simulated failure mid-burst");
      }),
    ).toThrow(/simulated failure mid-burst/);

    expect(getRequest(request.id)?.urgency).toBe(original);
  });

  it("leaves no transaction open after a rollback", () => {
    expect(inTransaction()).toBe(false);
    expect(() =>
      withTransaction(() => {
        throw new Error("boom");
      }),
    ).toThrow();
    expect(inTransaction()).toBe(false);

    // A connection with a leaked open transaction would fail this write.
    const request = createRequest(REQUEST);
    updateRequest(request.id, { quantity: 7 });
    expect(getRequest(request.id)?.quantity).toBe(7);
  });

  it("reports transaction depth only while inside the body", () => {
    expect(inTransaction()).toBe(false);
    withTransaction(() => {
      expect(inTransaction()).toBe(true);
    });
    expect(inTransaction()).toBe(false);
  });

  describe("nesting", () => {
    it("commits an inner transaction as part of the outer one", () => {
      const request = createRequest(REQUEST);

      withTransaction(() => {
        updateRequest(request.id, { quantity: 11 });
        withTransaction(() => {
          updateRequest(request.id, { urgency: CHANGED_URGENCY });
        });
      });

      expect(getRequest(request.id)?.quantity).toBe(11);
      expect(getRequest(request.id)?.urgency).toBe(CHANGED_URGENCY);
    });

    it("rolls the inner transaction back without discarding the outer work", () => {
      const request = createRequest(REQUEST);

      withTransaction(() => {
        updateRequest(request.id, { quantity: 11 });

        expect(() =>
          withTransaction(() => {
            updateRequest(request.id, { urgency: CHANGED_URGENCY });
            throw new Error("inner failure");
          }),
        ).toThrow(/inner failure/);
      });

      const stored = getRequest(request.id);
      expect(stored?.quantity).toBe(11);
      expect(stored?.urgency).toBe(REQUEST.urgency);
      expect(stored?.urgency).not.toBe(CHANGED_URGENCY);
    });

    it("rolls the whole chain back when the outer body throws", () => {
      const request = createRequest(REQUEST);

      expect(() =>
        withTransaction(() => {
          withTransaction(() => {
            updateRequest(request.id, { quantity: 99 });
          });
          throw new Error("outer failure");
        }),
      ).toThrow(/outer failure/);

      expect(getRequest(request.id)?.quantity).toBe(REQUEST.quantity);
    });
  });
});

describe("audit chain under failure", () => {
  it("leaves no trace of a change that rolled back", () => {
    const request = createRequest(REQUEST);

    expect(() =>
      withTransaction(() => {
        appendAudit({
          requestId: request.id,
          actor: "test-actor",
          actorRole: "admin",
          action: "request.created",
          entityType: "request",
          entityId: request.id,
          detail: { attempt: "will be rolled back" },
        });
        throw new Error("the change failed");
      }),
    ).toThrow();

    const seq = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ?")
      .get(request.id) as { n: number };
    expect(seq.n).toBe(0);
  });

  it("keeps the chain verifiable after a mixed batch of commits and rollbacks", async () => {
    const good = createRequest(REQUEST);

    withTransaction(() => {
      appendAudit({
        requestId: good.id,
        actor: "test-actor",
        actorRole: "admin",
        action: "request.created",
        entityType: "request",
        entityId: good.id,
        detail: {},
      });
    });

    try {
      withTransaction(() => {
        appendAudit({
          requestId: good.id,
          actor: "test-actor",
          actorRole: "admin",
          action: "pipeline.started",
          entityType: "request",
          entityId: good.id,
          detail: {},
        });
        throw new Error("pipeline failed");
      });
    } catch {
      // Expected: the rollback is the behaviour under test.
    }

    withTransaction(() => {
      appendAudit({
        requestId: good.id,
        actor: "test-actor",
        actorRole: "admin",
        action: "pipeline.completed",
        entityType: "request",
        entityId: good.id,
        detail: {},
      });
    });

    const result = verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(2);
  });

  it("keeps entries appended from inside a caller transaction in that transaction", () => {
    const request = createRequest(REQUEST);

    withTransaction(() => {
      updateRequest(request.id, { status: "sourcing" });
      appendAudit({
        requestId: request.id,
        actor: "test-actor",
        actorRole: "admin",
        action: "pipeline.started",
        entityType: "request",
        entityId: request.id,
        detail: { status: "sourcing" },
      });
    });

    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get("pipeline.started") as { n: number };
    expect(row.n).toBe(1);
    expect(verifyAuditChain().valid).toBe(true);
  });
});

describe("grouped mutation and audit", () => {
  it("does not record an approval decision whose write failed", () => {
    const request = createRequest(REQUEST);

    const statusBefore = getRequest(request.id)!.status;

    expect(() =>
      withTransaction(() => {
        updateRequest(request.id, { status: "approved" });
        appendAudit({
          requestId: request.id,
          actor: "test-actor",
          actorRole: "admin",
          action: "approval.decided",
          entityType: "approval",
          entityId: "step-1",
          detail: { decision: "approved" },
        });
        throw new Error("audit write failed");
      }),
    ).toThrow(/audit write failed/);

    expect(getRequest(request.id)?.status).toBe(statusBefore);

    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get("approval.decided") as { n: number };
    expect(row.n).toBe(0);
  });

  it("keeps an approval chain intact when a later step cannot be written", () => {
    const request = createRequest(REQUEST);
    const steps = listApprovals(request.id);

    expect(steps).toHaveLength(0);

    // Approving in the same connection writes an exception row and an audit entry
    // as one unit; a constraint failure in the middle must undo both.
    expect(() =>
      withTransaction(() => {
        insertRiskException({
          requestId: request.id,
          flagCode: "budget_overrun",
          justification: "Accepted in writing.",
          approverName: "Test Approver",
        });
        appendAudit({
          requestId: request.id,
          actor: "test-actor",
          actorRole: "admin",
          action: "risk.exception_granted",
          entityType: "risk_exception",
          entityId: "budget_overrun",
          detail: {},
        });
        throw new Error("approval could not be completed");
      }),
    ).toThrow();

    const exceptions = getDb()
      .prepare("SELECT COUNT(*) AS n FROM risk_exceptions WHERE request_id = ?")
      .get(request.id) as { n: number };
    expect(exceptions.n).toBe(0);
    expect(verifyAuditChain().valid).toBe(true);
  });
});