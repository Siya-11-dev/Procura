import { describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers";

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: {
      id: "usr_test_requester",
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
  getRequest,
  getRequestSpec,
  listClarifications,
  listOpenClarifications,
  type NewRequest,
} from "@/lib/db/repository";
import { answerClarificationAction } from "@/app/actions";
import { runSourcingPipeline } from "@/lib/pipeline";

setupTestDb();

const NO_QUANTITY: NewRequest = {
  title: "Chairs for the design studio",
  rawDescription:
    "Please source task chairs for the new design studio floor. The old ones are beyond repair.",
  requesterName: "Amahle Dlamini",
  requesterEmail: "amahle.dlamini@procura.co.za",
  requesterDepartment: "Design",
  unit: "units",
  quantity: null,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

describe("clarification loop", () => {
  it("stops the run when nobody said how many are wanted", async () => {
    const request = createRequest(NO_QUANTITY);

    const result = await runSourcingPipeline(request.id);

    expect(result.status).toBe("needs_clarification");
    expect(result.summary).toMatch(/answer/i);

    const open = listOpenClarifications(request.id);
    expect(open).toHaveLength(1);
    expect(open[0].code).toBe("quantity_missing");
    expect(open[0].question.length).toBeGreaterThan(0);

    // The parsed read is stored before the pause, so the request page can show
    // what the agents understood alongside the questions they are waiting on.
    expect(getRequestSpec(request.id)).not.toBeNull();
    expect(getRequest(request.id)!.status).toBe("needs_clarification");

    const entries = listAudit(request.id).filter(
      (entry) => entry.action === "clarification.requested",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({ count: 1 });
  });

  it("stops when the form and the brief disagree about the volume", async () => {
    const request = createRequest({
      ...NO_QUANTITY,
      title: "Chairs for the design studio",
      rawDescription: "We need 24 task chairs for the studio, black mesh.",
      quantity: 10,
    });

    const result = await runSourcingPipeline(request.id);

    expect(result.status).toBe("needs_clarification");
    const open = listOpenClarifications(request.id);
    expect(open.map((entry) => entry.code)).toContain("quantity_conflict");
  });

  it("resumes from the answer and records who answered", async () => {
    const request = createRequest(NO_QUANTITY);
    await runSourcingPipeline(request.id);
    const open = listOpenClarifications(request.id);
    expect(open).toHaveLength(1);

    const result = await answerClarificationAction(request.id, {
      [open[0].id]: "24 chairs",
    });

    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/Sourcing is waiting on/i);

    const answered = listClarifications(request.id);
    expect(answered).toHaveLength(1);
    expect(answered[0].status).toBe("answered");
    expect(answered[0].answeredBy).toBe("Amahle Dlamini");
    expect(answered[0].answer).toBe("24 chairs");
    expect(listOpenClarifications(request.id)).toHaveLength(0);

    // The quantity the requester supplied lands on the request itself, so the
    // columns and the spec cannot disagree about what is being sourced.
    expect(getRequest(request.id)!.quantity).toBe(24);

    const entries = listAudit(request.id).filter(
      (entry) => entry.action === "clarification.answered",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({ code: "quantity_missing" });

    expect(getRequest(request.id)!.status).not.toBe("needs_clarification");
  });

  it("does not re-ask a question a person has already answered", async () => {
    const request = createRequest(NO_QUANTITY);
    await runSourcingPipeline(request.id);
    const open = listOpenClarifications(request.id);
    await answerClarificationAction(request.id, { [open[0].id]: "24 chairs" });

    // The same rule would still fire on a rerun, but a person has spoken for
    // the request, so the gate has nothing left to wait on.
    const rerun = await runSourcingPipeline(request.id);

    expect(rerun.status).not.toBe("needs_clarification");
    expect(listOpenClarifications(request.id)).toHaveLength(0);
    expect(listClarifications(request.id)).toHaveLength(1);
    expect(listClarifications(request.id)[0].status).toBe("answered");
  });

  it("refuses an empty answer instead of quietly resuming", async () => {
    const request = createRequest(NO_QUANTITY);
    await runSourcingPipeline(request.id);
    const open = listOpenClarifications(request.id);

    const result = await answerClarificationAction(request.id, {
      [open[0].id]: "   ",
    });

    expect(result.ok).toBe(false);
    expect(listOpenClarifications(request.id)).toHaveLength(1);
    expect(getRequest(request.id)!.status).toBe("needs_clarification");
  });
});
