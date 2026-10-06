import { departmentCommittedSpend, findBudget } from "@/lib/db/repository";
import type { Budget, Category } from "@/lib/domain/types";

export interface BudgetPosition {
  /** The ceiling covering this department/category, when one exists. */
  budget: Budget | null;
  /** Already committed by purchase orders raised in this department. */
  committed: number;
  /** Committed spend plus the award this request would add. */
  projected: number;
  /** True when the award would push the department past its ceiling. */
  overBudget: boolean;
}

/**
 * Where a department stands against its ceiling once this award is added.
 *
 * Budgets are matched per department with a category-specific line preferred
 * over the department-wide fallback, and committed spend is read from issued
 * purchase orders: an order that exists is money the department has actually
 * committed, while a request still being sourced has committed nothing.
 */
export function evaluateBudget(input: {
  department: string;
  category: Category | null;
  totalAmount: number;
}): BudgetPosition {
  const budget = findBudget(input.department, input.category);
  const committed = departmentCommittedSpend(input.department);
  const projected = committed + Math.max(0, input.totalAmount);

  return {
    budget,
    committed,
    projected,
    overBudget: budget !== null && projected > budget.annualLimit,
  };
}
