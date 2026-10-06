import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers";
import {
  createRequest,
  getComparison,
  getRequest,
  insertBudget,
  listQuotes,
  listRisk,
  listSuppliers,
  type NewRequest,
} from "@/lib/db/repository";
import { getDb } from "@/lib/db/client";
import { riskAgent } from "@/lib/agents/risk.agent";
import { runSourcingPipeline } from "@/lib/pipeline";
import { seededRandom, todayIso } from "@/lib/util";
import { addDays } from "@/lib/util";

setupTestDb();

const REQUEST: NewRequest = {
  title: "Task chairs for the studio",
  rawDescription: "We need 10 task chairs for the studio, black mesh, adjustable height.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Studio Operations",
  unit: "chair",
  quantity: 10,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

/** Run the risk agent over a request that already has quotes and a comparison. */
async function assessRisk(requestId: string) {
  const request = getRequest(requestId)!;
  await riskAgent.run(
    { request, rng: seededRandom(`${requestId}:risk`) },
    {
      quotes: listQuotes(requestId),
      suppliers: listSuppliers(),
      neededBy: request.neededBy,
    },
  );
  return listRisk(requestId);
}

function flagsFor(risks: Awaited<ReturnType<typeof assessRisk>>, supplierId: string) {
  const row = risks.find((risk) => risk.supplierId === supplierId);
  expect(row, `expected an assessment for supplier ${supplierId}`).toBeDefined();
  return row!.flags.map((flag) => ({ code: flag.code, severity: flag.severity }));
}

/** A quote from a South African supplier, the only kind the B-BBEE checks judge. */
function southAfricanQuote(requestId: string) {
  const suppliers = listSuppliers();
  const quote = listQuotes(requestId).find((candidate) => {
    const supplier = suppliers.find((row) => row.id === candidate.supplierId);
    return supplier?.country === "South Africa";
  });
  expect(quote, "expected at least one shortlisted South African supplier").toBeDefined();
  return quote!;
}

async function requestWithQuotes() {
  const request = createRequest(REQUEST);
  await runSourcingPipeline(request.id);
  return request;
}

describe("compliance screening", () => {
  it("accepts the current screening and B-BBEE evidence on the seeded market", async () => {
    const request = await requestWithQuotes();
    const risks = await assessRisk(request.id);

    const codes = risks.flatMap((risk) => risk.flags.map((flag) => flag.code));
    expect(codes).not.toContain("sanctions_hit");
    expect(codes).not.toContain("sanctions_unscreened");
    expect(codes).not.toContain("sanctions_stale");
    expect(codes).not.toContain("bbbee_missing");
    expect(codes).not.toContain("bbbee_expired");
  });

  it("warns when the last sanctions screen is older than a year", async () => {
    const request = await requestWithQuotes();
    const quote = listQuotes(request.id)[0];

    getDb()
      .prepare(
        "UPDATE suppliers SET sanctions_checked_at = ?, sanctions_result = 'clear' WHERE id = ?",
      )
      .run(addDays(todayIso(), -400), quote.supplierId);

    const flags = flagsFor(await assessRisk(request.id), quote.supplierId);
    const stale = flags.find((flag) => flag.code === "sanctions_stale");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("warning");
  });

  it("warns when a supplier has never been screened", async () => {
    const request = await requestWithQuotes();
    const quote = listQuotes(request.id)[0];

    getDb()
      .prepare("UPDATE suppliers SET sanctions_checked_at = NULL WHERE id = ?")
      .run(quote.supplierId);

    const flags = flagsFor(await assessRisk(request.id), quote.supplierId);
    expect(flags.find((flag) => flag.code === "sanctions_unscreened")).toBeDefined();
  });

  it("blocks on a screening match, which an approver cannot waive", async () => {
    const request = await requestWithQuotes();
    const quote = listQuotes(request.id)[0];

    getDb()
      .prepare("UPDATE suppliers SET sanctions_result = 'hit' WHERE id = ?")
      .run(quote.supplierId);

    const risks = await assessRisk(request.id);
    const flags = flagsFor(risks, quote.supplierId);
    const hit = flags.find((flag) => flag.code === "sanctions_hit");
    expect(hit?.severity).toBe("critical");

    const row = risks.find((risk) => risk.supplierId === quote.supplierId)!;
    expect(row.recommendation).toMatch(/Do not award/i);
  });

  it("warns when the B-BBEE certificate backing the level has lapsed", async () => {
    const request = await requestWithQuotes();
    const quote = southAfricanQuote(request.id);

    getDb()
      .prepare("UPDATE suppliers SET bbbee_expiry = ?, bbbee_level = 2 WHERE id = ?")
      .run(addDays(todayIso(), -30), quote.supplierId);

    const flags = flagsFor(await assessRisk(request.id), quote.supplierId);
    expect(flags.find((flag) => flag.code === "bbbee_expired")).toBeDefined();
  });

  it("warns when a supplier claims a level with no certificate on record", async () => {
    const request = await requestWithQuotes();
    const quote = southAfricanQuote(request.id);

    getDb()
      .prepare("UPDATE suppliers SET bbbee_expiry = NULL, bbbee_level = NULL WHERE id = ?")
      .run(quote.supplierId);

    const flags = flagsFor(await assessRisk(request.id), quote.supplierId);
    expect(flags.find((flag) => flag.code === "bbbee_missing")).toBeDefined();
  });

  it("puts the department's exhausted ceiling on the recommended quote", async () => {
    const request = await requestWithQuotes();
    insertBudget({
      department: "Studio Operations",
      annualLimit: 1_000,
      ownerName: "Budget Owner",
    });

    const risks = await assessRisk(request.id);
    const recommended = risks.find((risk) => risk.isRecommended);
    expect(recommended).toBeDefined();

    const flag = recommended!.flags.find((item) => item.code === "budget_exhausted");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("warning");
    expect(flag?.label).toMatch(/Studio Operations/);

    // Only the recommended award is judged against the ceiling: a losing bid
    // commits nothing.
    const losing = risks.filter((risk) => !risk.isRecommended);
    expect(
      losing.every((risk) =>
        risk.flags.every((item) => item.code !== "budget_exhausted"),
      ),
    ).toBe(true);
  });

  it("keeps the recommended quote and the assessment in step", async () => {
    const request = await requestWithQuotes();
    const comparison = getComparison(request.id)!;
    const risks = await assessRisk(request.id);

    const recommended = risks.filter((risk) => risk.isRecommended);
    expect(recommended).toHaveLength(1);
    expect(comparison.recommendedQuoteId).not.toBeNull();
    expect(recommended[0].quoteId).toBe(comparison.recommendedQuoteId);
  });
});
