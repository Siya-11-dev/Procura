import {
  deleteApprovals,
  getComparison,
  getPurchaseOrder,
  getRequestSpec,
  insertApprovalStep,
  listApprovalAuthority,
  listRisk,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import { evaluateBudget } from "@/lib/budgets";
import type { ApprovalStep, Currency, RiskBand } from "@/lib/domain/types";
import { formatMoney } from "@/lib/util";
import { narrateSummary } from "./llm";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface ApprovalAgentInput {
  totalAmount: number;
  currency: Currency;
  riskBand: RiskBand | null;
  blockingFlags: number;
}

export interface ApprovalAgentOutput {
  steps: ApprovalStep[];
  currentStep: ApprovalStep | null;
  autoApproved: boolean;
}

interface Threshold {
  stepOrder: number;
  role: string;
  approver: string;
  upTo: number;
}

/**
 * The built-in delegation ladder. The approval agent prefers the rows in
 * `approval_authority` and only falls back to this when the table is empty, so
 * a seeded database and a fresh one route identically.
 */
export const DEFAULT_APPROVAL_CHAIN: Threshold[] = [
  { stepOrder: 1, role: "Procurement Lead", approver: "Nomsa Khumalo", upTo: 50_000 },
  { stepOrder: 2, role: "Finance Director", approver: "Riaan Steyn", upTo: 250_000 },
  { stepOrder: 3, role: "Chief Financial Officer", approver: "Thandiwe Mokoena", upTo: 1_000_000 },
  { stepOrder: 4, role: "Chief Executive Officer", approver: "Daniel Fischer", upTo: Number.MAX_SAFE_INTEGER },
];

/** The active ladder, read from the database with the built-in chain as fallback. */
function approvalChain(): Threshold[] {
  const rows = listApprovalAuthority();
  if (rows.length === 0) return DEFAULT_APPROVAL_CHAIN;
  return rows.map((row) => ({
    stepOrder: row.stepOrder,
    role: row.role,
    approver: row.approverName,
    upTo: row.thresholdAmount,
  }));
}

const AUTO_APPROVAL_CEILING = 25_000;

export const approvalAgent: Agent<ApprovalAgentInput, ApprovalAgentOutput> = {
  name: "approval",
  async run(
    context: AgentContext,
    input: ApprovalAgentInput,
  ): Promise<AgentResult<ApprovalAgentOutput>> {
    const { request } = context;

    if (getPurchaseOrder(request.id)) {
      return {
        summary: "A purchase order already exists for this request, so the approval route was not rebuilt.",
        output: { steps: [], currentStep: null, autoApproved: false },
        detail: null,
      };
    }

    const chain = approvalChain();
    const spec = getRequestSpec(request.id);

    // Delegation is cumulative: the request walks the chain up to the first
    // level whose authority covers the amount, and every earlier level must
    // approve. An amount under R50k therefore never reaches the Finance
    // Director, so a small order is not held up by senior sign-off it does not
    // need. If nothing covers the amount the full chain is used.
    const authorityIndex = chain.findIndex(
      (threshold) => input.totalAmount <= threshold.upTo,
    );
    const required =
      authorityIndex === -1
        ? chain
        : chain.slice(0, authorityIndex + 1);

    // A department that has already spent its ceiling stops at the budget owner
    // before any financial approval is asked for. Without this the ceiling is
    // only ever advisory: the chain would approve the award and the budget row
    // would never be consulted.
    const budget = evaluateBudget({
      department: request.requesterDepartment,
      category: spec?.category ?? request.category,
      totalAmount: input.totalAmount,
    });
    const needsBudgetException = budget.overBudget && budget.budget !== null;

    const lowRisk = input.riskBand === "low" || input.riskBand === null;
    const needsCompliance =
      input.riskBand === "elevated" || input.riskBand === "high" || input.blockingFlags > 0;

    // Rebuilding the route is one decision. Committing steps one at a time after
    // deleting the old chain would leave an approver holding a step number from
    // a truncated chain, and a request nobody is recorded as owing a decision to.
    const steps: ApprovalStep[] = withTransaction(() => {
      deleteApprovals(request.id);

      const built: ApprovalStep[] = [];
      let order = 1;
      if (needsBudgetException && budget.budget) {
        built.push(
          buildStep(
            request.id,
            order++,
            "Budget Exception",
            budget.budget.ownerName,
            0,
            "pending",
            `Departmental budget of ${formatMoney(budget.budget.annualLimit, input.currency)} is exhausted: ${formatMoney(budget.committed, input.currency)} committed plus ${formatMoney(input.totalAmount, input.currency)} here would take ${request.requesterDepartment} to ${formatMoney(budget.projected, input.currency)}.`,
          ),
        );
      }
      if (needsCompliance) {
        built.push(
          buildStep(request.id, order++, "Compliance & Risk Review", "Lerato Mabaso", 0, "pending"),
        );
      }

      for (const threshold of required) {
        const autoApprove =
          order === 1 &&
          input.totalAmount <= AUTO_APPROVAL_CEILING &&
          lowRisk &&
          !needsCompliance &&
          !needsBudgetException;

        built.push(
          buildStep(
            request.id,
            order++,
            threshold.role,
            threshold.approver,
            threshold.upTo,
            autoApprove ? "approved" : "pending",
            autoApprove
              ? "Auto-approved: within the procurement lead's delegated authority and low risk."
              : null,
            autoApprove,
          ),
        );
      }
      return built;
    });

    const currentStep = steps.find((step) => step.status === "pending") ?? null;

    const comparison = getComparison(request.id);
    const risks = listRisk(request.id);
    const recommendedRisk = risks.find((risk) => risk.isRecommended);

    const summary = await narrateSummary({
      agent: "Approval",
      title: request.title,
      facts: `Value: ${formatMoney(input.totalAmount, input.currency)}. Risk band: ${input.riskBand ?? "n/a"}. Steps: ${steps.length}. Current: ${currentStep?.role ?? "none"}.`,
      fallback:
        steps.length === 0
          ? "No approval route was generated."
          : currentStep === null
            ? `All ${steps.length} approval steps are cleared. The purchase order can be raised.`
            : `Routed to ${currentStep.role} (${currentStep.approverName}). ${steps.length} step${steps.length === 1 ? "" : "s"} in the chain for ${formatMoney(input.totalAmount, input.currency)}.`,
    });

    return {
      summary,
      output: { steps, currentStep, autoApproved: currentStep === null },
      detail: {
        steps,
        budget: needsBudgetException && budget.budget
          ? {
              department: request.requesterDepartment,
              committed: budget.committed,
              projected: budget.projected,
              annualLimit: budget.budget.annualLimit,
              owner: budget.budget.ownerName,
            }
          : null,
        rationale: buildRoutingRationale({
          totalAmount: input.totalAmount,
          riskBand: input.riskBand,
          spec,
          riskRecommendation: recommendedRisk?.recommendation ?? null,
          savingsVsBudget: comparison?.savingsVsBudget ?? null,
          currency: input.currency,
          chain,
          budgetException: needsBudgetException ? budget : null,
        }),
      },
    };
  },
};

function buildStep(
  requestId: string,
  stepOrder: number,
  role: string,
  approverName: string,
  thresholdAmount: number,
  status: ApprovalStep["status"],
  decisionNote: string | null = null,
  automated = false,
): ApprovalStep {
  return insertApprovalStep({
    requestId,
    stepOrder,
    role,
    approverName,
    thresholdAmount,
    status,
    decisionNote,
    decidedAt: null,
    automated,
  });
}

function buildRoutingRationale(input: {
  totalAmount: number;
  riskBand: RiskBand | null;
  spec: ReturnType<typeof getRequestSpec>;
  riskRecommendation: string | null;
  savingsVsBudget: number | null;
  currency: Currency;
  chain: Threshold[];
  budgetException: { committed: number; projected: number } | null;
}): string {
  const parts: string[] = [];

  const level = input.chain.find((threshold) => input.totalAmount <= threshold.upTo);
  parts.push(
    level && level.upTo < Number.MAX_SAFE_INTEGER
      ? `${formatMoney(input.totalAmount, input.currency)} falls under the ${level.role} authority limit of ${formatMoney(level.upTo, input.currency)}.`
      : `${formatMoney(input.totalAmount, input.currency)} exceeds every delegated authority limit, so it escalates to the CEO.`,
  );

  if (input.budgetException) {
    parts.push(
      `The department has committed ${formatMoney(input.budgetException.committed, input.currency)} already, so this award takes it to ${formatMoney(input.budgetException.projected, input.currency)} and needs a budget exception.`,
    );
  }

  if (input.riskBand) {
    parts.push(
      input.riskBand === "low"
        ? "Supplier risk is low, so the standard chain applies."
        : `Supplier risk is ${input.riskBand}, so a Compliance & Risk Review was inserted ahead of the financial approvals.`,
    );
  }

  if (input.savingsVsBudget !== null) {
    parts.push(
      input.savingsVsBudget >= 0
        ? `The award is ${formatMoney(input.savingsVsBudget, input.currency)} under the requested budget.`
        : `The award is ${formatMoney(Math.abs(input.savingsVsBudget), input.currency)} over the requested budget and needs an explicit exception.`,
    );
  }

  if (input.riskRecommendation) {
    parts.push(input.riskRecommendation);
  }

  if (input.spec?.clarifications.length) {
    parts.push(
      `The requester has ${input.spec.clarifications.length} open assumption${input.spec.clarifications.length === 1 ? "" : "s"} that the approver should confirm.`,
    );
  }

  return parts.join(" ");
}
