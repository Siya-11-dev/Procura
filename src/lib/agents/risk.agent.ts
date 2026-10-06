import {
  deleteRisk,
  getComparison,
  getRequestSpec,
  insertRisk,
  listRisk,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import { evaluateBudget } from "@/lib/budgets";
import type {
  Category,
  Currency,
  Quote,
  RiskBand,
  RiskFlag,
  Supplier,
} from "@/lib/domain/types";
import { addDays, clamp, daysBetween, formatMoney, round, todayIso } from "@/lib/util";
import { narrateSummary } from "./llm";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface RiskAgentInput {
  quotes: Quote[];
  suppliers: Supplier[];
  neededBy: string | null;
}

export interface RiskAgentOutput {
  recommendedSupplier: Supplier | null;
  band: RiskBand | null;
  blockingFlags: RiskFlag[];
}

const COUNTRY_RISK: Record<string, number> = {
  "South Africa": 88,
  Singapore: 92,
  "United Kingdom": 90,
  Germany: 95,
};

const FINANCIAL_SCORE: Record<Supplier["financialHealth"], number> = {
  strong: 95,
  stable: 78,
  watch: 52,
  distressed: 25,
};

export const riskAgent: Agent<RiskAgentInput, RiskAgentOutput> = {
  name: "risk",
  async run(context: AgentContext, input: RiskAgentInput): Promise<AgentResult<RiskAgentOutput>> {
    const { request } = context;
    const spec = getRequestSpec(request.id);
    const comparison = getComparison(request.id);

    const recommendedQuoteId = comparison?.recommendedQuoteId ?? null;
    const blockers: RiskFlag[] = [];
    let recommendedBand: RiskBand | null = null;

    // The new assessment supersedes the old one wholesale. Replacing it per
    // supplier would let a failure leave a mix of two runs, where a supplier
    // carries a stale verdict the summary no longer accounts for.
    withTransaction(() => {
      deleteRisk(request.id);

      for (const quote of input.quotes) {
        const supplier = input.suppliers.find((s) => s.id === quote.supplierId);
        if (!supplier) continue;

        const assessment = assess({
          request,
          quote,
          supplier,
          spec,
          neededBy: input.neededBy,
          competitorCount: input.quotes.length,
          recommended: quote.id === recommendedQuoteId,
        });

        insertRisk({
          requestId: request.id,
          quoteId: quote.id,
          supplierId: supplier.id,
          overallScore: assessment.overall,
          financialScore: assessment.financial,
          deliveryScore: assessment.delivery,
          complianceScore: assessment.compliance,
          concentrationScore: assessment.concentration,
          band: assessment.band,
          flags: assessment.flags,
          recommendation: assessment.recommendation,
          isRecommended: quote.id === recommendedQuoteId,
        });

        if (quote.id === recommendedQuoteId) {
          recommendedBand = assessment.band;
          blockers.push(
            ...assessment.flags.filter((flag) => flag.severity === "critical"),
          );
        }
      }
    });

    const recommendedQuote = input.quotes.find(
      (quote) => quote.id === recommendedQuoteId,
    );
    const recommendedSupplier =
      input.suppliers.find(
        (supplier) => supplier.id === recommendedQuote?.supplierId,
      ) ?? null;

    const recommendedRisk = listRisk(request.id).find(
      (risk) => risk.quoteId === recommendedQuote?.id,
    );
    const overrun = recommendedRisk?.flags.find(
      (flag) => flag.code === "budget_overrun",
    );

    const summary = await narrateSummary({
      agent: "Risk",
      title: request.title,
      facts: `Assessed ${input.quotes.length} suppliers. Recommended supplier scores ${recommendedBand ?? "n/a"} risk. Blocking issues: ${blockers.length}.`,
      fallback:
        recommendedSupplier === null
          ? "No recommended supplier to assess. Risk review skipped."
          : `Assessed ${input.quotes.length} shortlisted suppliers; the recommended supplier scores ${recommendedBand === "low" ? "low" : recommendedBand} risk. ` +
            (overrun
              ? `${overrun.label} and it must be cleared before the PO is raised. `
              : "") +
            (blockers.length > 0
              ? `${blockers.length} blocking issue${blockers.length === 1 ? "" : "s"} must be resolved before the PO is raised.`
              : "No blocking risk; the remaining flags become conditions on the award."),
    });

    return {
      summary,
      output: { recommendedSupplier, band: recommendedBand, blockingFlags: blockers },
      detail: { assessed: input.quotes.length, blockingFlags: blockers },
    };
  },
};

interface AssessInput {
  request: {
    id: string;
    neededBy: string | null;
    currency: Currency;
    budgetAmount: number | null;
    requesterDepartment: string;
    category: Category | null;
  };
  quote: Quote;
  supplier: Supplier;
  spec: ReturnType<typeof getRequestSpec>;
  neededBy: string | null;
  competitorCount: number;
  recommended: boolean;
}

function assess(input: AssessInput) {
  const { supplier, quote, spec, neededBy } = input;
  const flags: RiskFlag[] = [];

  const financial = round(
    clamp(
      FINANCIAL_SCORE[supplier.financialHealth] * 0.7 +
        clamp(supplier.yearsInBusiness / 30, 0, 1) * 30,
      0,
      100,
    ),
    1,
  );

  if (supplier.financialHealth === "watch" || supplier.financialHealth === "distressed") {
    flags.push({
      code: "financial_health",
      label: `Financial health: ${supplier.financialHealth}`,
      severity: supplier.financialHealth === "distressed" ? "critical" : "warning",
      detail: `Counterparty risk is elevated. Mitigate with staged payment or a parent guarantee.`,
    });
  }

  if (supplier.yearsInBusiness < 4) {
    flags.push({
      code: "new_supplier",
      label: `Only ${supplier.yearsInBusiness} years trading`,
      severity: "warning",
      detail: "Limited trading history. Consider a trial order before committing the full volume.",
    });
  }

  const projectedDelivery = addDays(todayIso(), quote.leadTimeDays);
  const lateDelivery = Boolean(neededBy && projectedDelivery > neededBy);
  const delivery = round(
    clamp(
      supplier.onTimeRate * 0.65 +
        (lateDelivery ? 0 : 35) +
        (supplier.financialHealth === "strong" ? 5 : 0) -
        5,
      0,
      100,
    ),
    1,
  );

  if (lateDelivery) {
    flags.push({
      code: "delivery_date_missed",
      label: "Cannot meet the required date",
      severity: "critical",
      detail: `Lead time of ${quote.leadTimeDays} days lands on ${projectedDelivery}, after the required ${neededBy}.`,
    });
  }

  if (supplier.onTimeRate < 82) {
    flags.push({
      code: "delivery_performance",
      label: `${supplier.onTimeRate}% on-time delivery`,
      severity: "warning",
      detail: "Below the 85% service level most contracts require. Include delivery penalties.",
    });
  }

  const requiredCerts = spec?.requiredCertifications ?? [];
  const held = supplier.certifications.map((cert) => cert.toLowerCase());
  const missing = requiredCerts.filter(
    (cert) =>
      !held.some((candidate) => candidate.startsWith(cert.toLowerCase().split(" ")[0])),
  );
  const countryBase = COUNTRY_RISK[supplier.country] ?? 70;
  const compliance = round(
    clamp(
      100 - (missing.length / Math.max(requiredCerts.length, 1)) * 60 -
        (supplier.yearsInBusiness < 4 ? 10 : 0) -
        (100 - countryBase) * 0.3,
      0,
      100,
    ),
    1,
  );

  for (const cert of missing) {
    flags.push({
      code: "missing_certification",
      label: `Missing ${cert}`,
      severity: "warning",
      detail: `Sourcing required ${cert}. The award is conditional on the certificate being provided before the PO is issued.`,
    });
  }

  // Sanctions screening belongs to the supplier, not the quote: a match fails
  // every line the supplier bids on, and it is the one finding an approver
  // cannot waive after the fact.
  const screenedAgo =
    supplier.sanctionsCheckedAt === null
      ? null
      : daysBetween(supplier.sanctionsCheckedAt, todayIso());

  if (supplier.sanctionsResult === "hit") {
    flags.push({
      code: "sanctions_hit",
      label: "Sanctions screening returned a match",
      severity: "critical",
      detail:
        "The screening run against this supplier returned a match. The award cannot proceed until compliance confirms the match is a false positive or the supplier is replaced.",
    });
  } else if (screenedAgo === null) {
    flags.push({
      code: "sanctions_unscreened",
      label: "No sanctions screening on record",
      severity: "warning",
      detail:
        "This supplier has never been screened. Run the screening before the PO is issued; it is the check that cannot be recovered after payment.",
    });
  } else if (screenedAgo > 365) {
    flags.push({
      code: "sanctions_stale",
      label: `Sanctions screening is ${screenedAgo} days old`,
      severity: "warning",
      detail:
        "Lists change continuously, so a screen older than a year does not describe the supplier today. Re-screen before the PO is issued.",
    });
  }

  // B-BBEE evidence only matters for South African suppliers, and only the
  // certificate backing the claimed level is checked: an expired certificate
  // means the level can no longer be claimed on this award.
  if (supplier.country === "South Africa") {
    if (supplier.bbbeeExpiry === null || supplier.bbbeeLevel === null) {
      flags.push({
        code: "bbbee_missing",
        label: "No B-BBEE certificate on record",
        severity: "warning",
        detail:
          "The supplier claims a transformation level but no certificate backs it. Obtain a valid certificate before the PO is issued.",
      });
    } else if (supplier.bbbeeExpiry < todayIso()) {
      flags.push({
        code: "bbbee_expired",
        label: `B-BBEE certificate expired on ${supplier.bbbeeExpiry}`,
        severity: "warning",
        detail:
          "The certificate backing the claimed level has lapsed, so the level cannot be claimed on this award until a renewed certificate is supplied.",
      });
    } else if (daysBetween(todayIso(), supplier.bbbeeExpiry) <= 60) {
      flags.push({
        code: "bbbee_expiring",
        label: `B-BBEE certificate expires on ${supplier.bbbeeExpiry}`,
        severity: "info",
        detail:
          "The certificate expires within 60 days, so it may lapse before delivery completes. Ask for the renewal with the award.",
      });
    }
  }

  const isOffshore = supplier.country !== "South Africa";
  const concentration = round(
    clamp(
      92 - (isOffshore ? 22 : 0) - (input.competitorCount <= 1 ? 25 : 0),
      0,
      100,
    ),
    1,
  );

  if (input.competitorCount <= 2) {
    flags.push({
      code: "thin_competition",
      label: `Only ${input.competitorCount} supplier${input.competitorCount === 1 ? "" : "s"} bid`,
      severity: "info",
      detail: "Limited competitive tension means the price should be treated as a floor, not a market clearing price.",
    });
  }

  if (isOffshore) {
    flags.push({
      code: "offshore_supply",
      label: `Offshore supply from ${supplier.country}`,
      severity: "warning",
      detail: `${quote.leadTimeDays}-day lead time plus ${supplier.currency} exposure against a ${input.request.currency} budget. Rate confirmed at invoice.`,
    });
  }

  if (supplier.currency !== input.request.currency && isOffshore) {
    flags.push({
      code: "fx_exposure",
      label: `${supplier.currency}/${input.request.currency} exposure`,
      severity: "info",
      detail: "Consider requesting a ZAR-denominated quote or a fixed exchange rate clause.",
    });
  }

  if (quote.validityDays < 30) {
    flags.push({
      code: "short_validity",
      label: `Quote valid for only ${quote.validityDays} days`,
      severity: "info",
      detail: `Re-validate price before the PO is issued if approval takes longer than that.`,
    });
  }

  const budget = input.request.budgetAmount;
  if (budget !== null && budget > 0) {
    const ratio = quote.totalPrice / budget;
    const money = (value: number) => formatMoney(value, input.request.currency);

    if (ratio > 1) {
      flags.push({
        code: "budget_overrun",
        label: `${Math.round((ratio - 1) * 100)}% over the requested budget`,
        severity: ratio > 1.1 ? "critical" : "warning",
        detail:
          `This quote lands at ${money(quote.totalPrice)} against a ${money(budget)} budget, an overrun of ${money(quote.totalPrice - budget)}. ` +
          (ratio > 3
            ? "An overrun this large almost always means the brief is mis-scoped rather than the price being wrong, so confirm the quantity and unit before anyone approves this."
            : "The approver has to accept the overrun explicitly or ask the supplier to requote."),
      });
    } else if (ratio >= 0.9) {
      flags.push({
        code: "budget_pressure",
        label: "Within 10% of the budget ceiling",
        severity: "info",
        detail: `Only ${money(budget - quote.totalPrice)} of headroom is left, so any variation or change order will push this over budget.`,
      });
    }
  }

  // The department's own ceiling, checked once on the recommended quote: the
  // approval agent routes around it, and this flag is what puts the reason on
  // the risk panel the approver actually reads.
  if (input.recommended) {
    const position = evaluateBudget({
      department: input.request.requesterDepartment,
      category: spec?.category ?? input.request.category,
      totalAmount: quote.totalPrice,
    });
    if (position.overBudget && position.budget) {
      flags.push({
        code: "budget_exhausted",
        label: `${input.request.requesterDepartment} is at its budget ceiling`,
        severity: "warning",
        detail:
          `${formatMoney(position.committed, input.request.currency)} is already committed against a ` +
          `${formatMoney(position.budget.annualLimit, input.request.currency)} ceiling, and this award would take the department to ` +
          `${formatMoney(position.projected, input.request.currency)}. The budget owner has to approve an exception.`,
      });
    }
  }

  const overall = round(
    financial * 0.3 + delivery * 0.3 + compliance * 0.25 + concentration * 0.15,
    1,
  );
  const band = bandFor(overall);
  const critical = flags.filter((flag) => flag.severity === "critical");

  const recommendation =
    critical.length > 0
      ? "Do not award until the critical items are resolved. Escalate to the Approval Agent with the mitigation plan attached."
      : band === "elevated" || band === "high"
        ? "Award with conditions. Attach the flagged mitigations to the purchase order and set a review date."
        : "Clear to award. Monitor delivery and quality against the agreed service levels.";

  return {
    financial,
    delivery,
    compliance,
    concentration,
    overall,
    band,
    flags,
    recommendation,
  };
}

export function bandFor(score: number): RiskBand {
  if (score >= 82) return "low";
  if (score >= 68) return "moderate";
  if (score >= 52) return "elevated";
  return "high";
}
