import { describe, it, expect } from "vitest";
import { setupTestDb } from "./helpers";
import { createRequest } from "@/lib/db/repository";
import { approvalAgent } from "@/lib/agents/approval.agent";
import { seededRandom } from "@/lib/util";
import { ROLE_TO_APPROVAL_STEP } from "@/lib/auth/roles";
import type { ApprovalStep, RiskBand } from "@/lib/domain/types";

setupTestDb();

const ROLE_AT = [
  "Procurement Lead",
  "Finance Director",
  "Chief Financial Officer",
  "Chief Executive Officer",
];

async function routeSteps(input: {
  totalAmount: number;
  riskBand?: RiskBand;
  blockingFlags?: number;
}): Promise<ApprovalStep[]> {
  const request = createRequest({
    title: "Approval routing test",
    rawDescription:
      "Integration test request covering the approval agent's delegation chain for a mid-sized procurement.",
    requesterName: "Test User",
    requesterEmail: "test.user@procura.co.za",
    requesterDepartment: "Test Department",
    unit: "units",
    quantity: 1,
    currency: "ZAR",
    budgetAmount: null,
    neededBy: null,
    urgency: "normal",
  });
  const result = await approvalAgent.run(
    { request, rng: seededRandom(`${request.id}:approval`) },
    {
      totalAmount: input.totalAmount,
      currency: request.currency,
      riskBand: input.riskBand ?? "low",
      blockingFlags: input.blockingFlags ?? 0,
    },
  );
  return result.output.steps;
}

describe("approval agent — delegation chain", () => {
  it("routes amounts under R50k to a single Procurement Lead step", async () => {
    const steps = await routeSteps({ totalAmount: 45_000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].role).toBe("Procurement Lead");
    expect(steps[0].thresholdAmount).toBe(50_000);
  });

  it("adds the Finance Director above R50k", async () => {
    const steps = await routeSteps({ totalAmount: 120_000 });
    expect(steps.map((step) => step.role)).toEqual(ROLE_AT.slice(0, 2));
  });

  it("adds the CFO above R250k", async () => {
    const steps = await routeSteps({ totalAmount: 600_000 });
    expect(steps.map((step) => step.role)).toEqual(ROLE_AT.slice(0, 3));
  });

  it("escalates above R1m to the CEO", async () => {
    const steps = await routeSteps({ totalAmount: 2_000_000 });
    expect(steps.map((step) => step.role)).toEqual(ROLE_AT);
  });

  it("never leaves an approval desk empty", async () => {
    const steps = await routeSteps({ totalAmount: 0 });
    expect(steps.length).toBeGreaterThan(0);
  });
});

describe("approval agent — automation and risk gates", () => {
  it("auto-approves a low-risk amount within the R25k delegated ceiling", async () => {
    const result = await approvalAgent.run(
      {
        request: createRequest({
          title: "Auto-approve test",
          rawDescription:
            "A modest spend within the procurement lead's delegated authority, low risk.",
          requesterName: "Test User",
          requesterEmail: "test.user@procura.co.za",
          requesterDepartment: "Test Department",
          unit: "units",
          quantity: 1,
          currency: "ZAR",
          budgetAmount: null,
          neededBy: null,
          urgency: "normal",
        }),
        rng: seededRandom("auto-approve:approval"),
      },
      { totalAmount: 12_000, currency: "ZAR", riskBand: "low", blockingFlags: 0 },
    );
    expect(result.output.autoApproved).toBe(true);
    expect(result.output.currentStep).toBeNull();
    expect(result.output.steps[0].automated).toBe(true);
  });

  it("requires a human above the R25k delegated ceiling", async () => {
    const steps = await routeSteps({ totalAmount: 30_000 });
    expect(steps[0].automated).toBe(false);
    expect(steps[0].status).toBe("pending");
  });

  it("inserts a Compliance & Risk Review ahead of financial approvals at elevated risk", async () => {
    const steps = await routeSteps({ totalAmount: 100_000, riskBand: "elevated" });
    const first = steps[0];
    expect(first.role).toBe("Compliance & Risk Review");
    expect(first.thresholdAmount).toBe(0);
    // The two financial steps still follow in authority order.
    expect(steps.map((step) => step.role).slice(1)).toEqual(ROLE_AT.slice(0, 2));
  });

  it("forces a compliance gate when the risk agent is still holding blockers", async () => {
    const steps = await routeSteps({ totalAmount: 10_000, blockingFlags: 1 });
    expect(steps[0].role).toBe("Compliance & Risk Review");
    expect(steps.some((step) => step.status === "pending")).toBe(true);
  });

  it("never auto-approves while a compliance gate is required", async () => {
    const result = await approvalAgent.run(
      {
        request: createRequest({
          title: "Blocked auto-approve test",
          rawDescription:
            "A small spend that still carries an unresolved critical risk finding.",
          requesterName: "Test User",
          requesterEmail: "test.user@procura.co.za",
          requesterDepartment: "Test Department",
          unit: "units",
          quantity: 1,
          currency: "ZAR",
          budgetAmount: null,
          neededBy: null,
          urgency: "normal",
        }),
        rng: seededRandom("blocked-auto:approval"),
      },
      { totalAmount: 10_000, currency: "ZAR", riskBand: "low", blockingFlags: 2 },
    );
    expect(result.output.autoApproved).toBe(false);
  });

  it("only ever emits steps that an account role is authorised to decide", async () => {
    const highRisk = await routeSteps({ totalAmount: 2_000_000, riskBand: "high" });
    const everyRole = new Set(
      [highRisk, await routeSteps({ totalAmount: 10_000 })]
        .flatMap((steps: ApprovalStep[]) => steps)
        .map((step) => step.role),
    );
    for (const role of everyRole) {
      expect(
        ROLE_TO_APPROVAL_STEP[role],
        `step role "${role}" must map to at least one account role`,
      ).toBeDefined();
      expect((ROLE_TO_APPROVAL_STEP[role] ?? []).length).toBeGreaterThan(0);
    }
  });
});