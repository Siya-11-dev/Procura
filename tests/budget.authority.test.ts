import { describe, expect, it } from "vitest";
import { approveEverything, resolveAllBlockers, setupTestDb } from "./helpers";
import {
  createRequest,
  departmentCommittedSpend,
  findBudget,
  getPurchaseOrder,
  insertBudget,
  listApprovalAuthority,
  type NewRequest,
} from "@/lib/db/repository";
import { evaluateBudget } from "@/lib/budgets";
import { DEFAULT_APPROVAL_CHAIN, approvalAgent } from "@/lib/agents/approval.agent";
import { runSourcingPipeline } from "@/lib/pipeline";
import { getDb } from "@/lib/db/client";
import { seededRandom } from "@/lib/util";

setupTestDb();

function requestFor(department: string): NewRequest {
  return {
    title: "Budget routing test",
    rawDescription:
      "Integration test request covering budget enforcement and the delegation ladder for a mid-sized procurement.",
    requesterName: "Test User",
    requesterEmail: "test.user@procura.co.za",
    requesterDepartment: department,
    unit: "units",
    quantity: 1,
    currency: "ZAR",
    budgetAmount: null,
    neededBy: null,
    urgency: "normal",
  };
}

async function routeSteps(input: {
  department: string;
  totalAmount: number;
}) {
  const request = createRequest(requestFor(input.department));
  const result = await approvalAgent.run(
    { request, rng: seededRandom(`${request.id}:approval`) },
    {
      totalAmount: input.totalAmount,
      currency: request.currency,
      riskBand: "low",
      blockingFlags: 0,
    },
  );
  return result.output.steps;
}

describe("budget positions", () => {
  it("projects committed spend plus the award against the ceiling", () => {
    insertBudget({
      department: "Field Operations",
      annualLimit: 500_000,
      ownerName: "Budget Owner",
    });

    const inside = evaluateBudget({
      department: "Field Operations",
      category: null,
      totalAmount: 100_000,
    });
    expect(inside.budget?.annualLimit).toBe(500_000);
    expect(inside.overBudget).toBe(false);
    expect(inside.projected).toBe(100_000);

    const outside = evaluateBudget({
      department: "Field Operations",
      category: null,
      totalAmount: 600_000,
    });
    expect(outside.overBudget).toBe(true);
    expect(outside.projected).toBe(600_000);
  });

  it("has no position for a department the organisation never funded", () => {
    const position = evaluateBudget({
      department: "Unbudgeted Department",
      category: null,
      totalAmount: 10_000,
    });
    expect(position.budget).toBeNull();
    expect(position.overBudget).toBe(false);
  });

  it("prefers a category line over the department-wide fallback", () => {
    insertBudget({
      department: "Capital Projects",
      annualLimit: 1_000_000,
      ownerName: "Budget Owner",
    });
    insertBudget({
      department: "Capital Projects",
      category: "it-hardware",
      annualLimit: 100_000,
      ownerName: "Hardware Owner",
    });

    const specific = findBudget("Capital Projects", "it-hardware");
    expect(specific?.category).toBe("it-hardware");
    expect(specific?.annualLimit).toBe(100_000);

    const fallback = findBudget("Capital Projects", "software");
    expect(fallback?.category).toBeNull();
    expect(fallback?.annualLimit).toBe(1_000_000);

    const noCategory = findBudget("Capital Projects", null);
    expect(noCategory?.annualLimit).toBe(1_000_000);
  });

  it("counts issued purchase orders as committed departmental spend", async () => {
    const request = createRequest(requestFor("Sales"));
    await runSourcingPipeline(request.id);
    resolveAllBlockers(request.id);
    await approveEverything(request.id);
    const po = getPurchaseOrder(request.id);
    expect(po).not.toBeNull();

    expect(departmentCommittedSpend("Sales")).toBe(po!.totalAmount);

    // The same ceiling that looked empty before the order now has the order
    // sitting against it, which is what stops a second award slipping past.
    const position = evaluateBudget({
      department: "Sales",
      category: null,
      totalAmount: po!.totalAmount,
    });
    expect(position.committed).toBe(po!.totalAmount);
    expect(position.projected).toBe(po!.totalAmount * 2);
    expect(position.overBudget).toBe(false);
  });
});

describe("budget enforcement in the approval route", () => {
  it("stops at the budget owner first when the ceiling is exhausted", async () => {
    insertBudget({
      department: "Field Operations",
      annualLimit: 1_000,
      ownerName: "Budget Owner",
    });

    const steps = await routeSteps({
      department: "Field Operations",
      totalAmount: 100_000,
    });

    expect(steps[0].role).toBe("Budget Exception");
    expect(steps[0].approverName).toBe("Budget Owner");
    expect(steps[0].status).toBe("pending");
    expect(steps[0].automated).toBe(false);
    expect(steps[0].decisionNote).toMatch(/exhausted/i);
    // The financial approvals still follow behind the exception.
    expect(steps.map((step) => step.role).slice(1)).toContain("Procurement Lead");
  });

  it("does not insert an exception while the department has headroom", async () => {
    insertBudget({
      department: "Field Operations",
      annualLimit: 5_000_000,
      ownerName: "Budget Owner",
    });

    const steps = await routeSteps({
      department: "Field Operations",
      totalAmount: 100_000,
    });

    expect(steps.map((step) => step.role)).not.toContain("Budget Exception");
    expect(steps[0].role).toBe("Procurement Lead");
  });

  it("never auto-approves an exhausted department, however small the order", async () => {
    insertBudget({
      department: "Field Operations",
      annualLimit: 1_000,
      ownerName: "Budget Owner",
    });

    const steps = await routeSteps({
      department: "Field Operations",
      totalAmount: 5_000,
    });

    expect(steps[0].role).toBe("Budget Exception");
    expect(steps.every((step) => step.status === "pending")).toBe(true);
  });
});

describe("delegation ladder from the database", () => {
  it("seeds the built-in chain as active authority rows", () => {
    const rows = listApprovalAuthority();
    expect(rows).toHaveLength(DEFAULT_APPROVAL_CHAIN.length);

    for (const [index, threshold] of DEFAULT_APPROVAL_CHAIN.entries()) {
      expect(rows[index].stepOrder).toBe(threshold.stepOrder);
      expect(rows[index].role).toBe(threshold.role);
      expect(rows[index].approverName).toBe(threshold.approver);
      expect(rows[index].thresholdAmount).toBe(threshold.upTo);
    }
  });

  it("routes against the stored thresholds, not the compiled defaults", async () => {
    getDb()
      .prepare(
        "UPDATE approval_authority SET approver_name = ?, threshold_amount = ? WHERE step_order = 1",
      )
      .run("Budget Clerk", 150_000);

    const steps = await routeSteps({
      department: "Test Department",
      totalAmount: 120_000,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0].role).toBe("Procurement Lead");
    expect(steps[0].approverName).toBe("Budget Clerk");
    expect(steps[0].thresholdAmount).toBe(150_000);
  });

  it("drops a deactivated level from the ladder entirely", async () => {
    getDb()
      .prepare("UPDATE approval_authority SET active = 0 WHERE step_order = 1")
      .run();

    expect(listApprovalAuthority()).toHaveLength(3);

    const steps = await routeSteps({
      department: "Test Department",
      totalAmount: 45_000,
    });

    // With the R50k level gone, the same amount now lands on Finance Director.
    expect(steps[0].role).toBe("Finance Director");
    expect(steps[0].thresholdAmount).toBe(250_000);
  });
});
