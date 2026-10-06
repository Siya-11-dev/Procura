import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import {
  insertRiskException,
  listApprovals,
  listRisk,
} from "@/lib/db/repository";
import { decideApproval } from "@/lib/pipeline";
import { seedBaseline } from "@/lib/seed";

/**
 * Point every test at a private, freshly deleted SQLite file so no test ever
 * touches the developer's working database, and each test starts empty. Call
 * once at the top of a test file (before any `it` is defined).
 */
export function setupTestDb(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "procura-test-"));
  const dbFile = path.join(dir, "test.db");

  beforeEach(() => {
    resetDbForTests(dbFile);
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = dbFile + suffix;
      if (existsSync(target)) unlinkSync(target);
    }
    seedBaseline();
  });
}

/** Approve every pending approval step, in sequence, mirroring the seed. */
export async function approveEverything(requestId: string): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    const pending = listApprovals(requestId).find(
      (step) => step.status === "pending",
    );
    if (!pending) break;
    await decideApproval(
      requestId,
      pending.id,
      "approved",
      "Test: approved without escalation.",
    );
  }
}

/**
 * Record a written exception for every critical finding on the recommended
 * supplier. This mirrors what a real approver does before the PO is raised
 * and prevents a waived approval chain from staying blocked on risk.
 */
export function resolveAllBlockers(requestId: string): void {
  const recommended = listRisk(requestId).find((risk) => risk.isRecommended);
  for (const flag of recommended?.flags.filter(
    (riskFlag) => riskFlag.severity === "critical",
  ) ?? []) {
    insertRiskException({
      requestId,
      flagCode: flag.code,
      justification: "Test: mitigation accepted in writing.",
      approverName: "Test Approver",
    });
  }
}

