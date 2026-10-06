import {
  getRequestSpec,
  listQuotes,
  listSuppliers,
  setQuoteStatus,
  upsertComparison,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import type {
  ComparisonRow,
  ComparisonWeights,
  Quote,
  Supplier,
  Urgency,
} from "@/lib/domain/types";
import { addDays, clamp, round, todayIso } from "@/lib/util";
import { narrateSummary } from "./llm";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface ComparisonAgentInput {
  urgency: Urgency;
  neededBy: string | null;
  budgetAmount: number | null;
}

export interface ComparisonAgentOutput {
  recommendedQuote: Quote | null;
  recommendedSupplier: Supplier | null;
  savingsVsBudget: number | null;
  savingsVsLowestBid: number;
}

const BASE_WEIGHTS: ComparisonWeights = {
  price: 0.35,
  quality: 0.2,
  delivery: 0.2,
  terms: 0.15,
  supplier: 0.1,
};

export const comparisonAgent: Agent<
  ComparisonAgentInput,
  ComparisonAgentOutput
> = {
  name: "comparison",
  async run(
    context: AgentContext,
    input: ComparisonAgentInput,
  ): Promise<AgentResult<ComparisonAgentOutput>> {
    const { request } = context;
    const quotes = listQuotes(request.id);
    const spec = getRequestSpec(request.id);
    const requiredCertifications = spec?.requiredCertifications ?? [];

    if (quotes.length === 0) {
      return {
        summary: "No quotations to compare. Sourcing cannot proceed without at least one bid.",
        output: {
          recommendedQuote: null,
          recommendedSupplier: null,
          savingsVsBudget: null,
          savingsVsLowestBid: 0,
        },
        detail: { rows: [], weights: BASE_WEIGHTS },
      };
    }

    const suppliers = new Map(listSuppliers().map((s) => [s.id, s]));
    const weights = deriveWeights(input.urgency, input.neededBy, quotes);

    const rows: ComparisonRow[] = quotes.map((quote) => {
      const supplier = suppliers.get(quote.supplierId)!;
      return scoreRow(quote, supplier, quotes, input.neededBy, requiredCertifications);
    });

    for (const row of rows) {
      row.totalScore = round(
        row.priceScore * weights.price +
          row.qualityScore * weights.quality +
          row.deliveryScore * weights.delivery +
          row.termsScore * weights.terms +
          row.supplierScore * weights.supplier,
        2,
      );
    }

    rows.sort((a, b) => b.totalScore - a.totalScore);
    rows.forEach((row, index) => {
      row.rank = index + 1;
    });

    const winner = rows[0];
    const lowest = rows.reduce((best, row) =>
      row.totalPrice < best.totalPrice ? row : best,
    );
    const savingsVsLowestBid = round(winner.totalPrice - lowest.totalPrice, 2);
    const pricePremiumPct = round(
      lowest.totalPrice === 0
        ? 0
        : ((winner.totalPrice - lowest.totalPrice) / lowest.totalPrice) * 100,
      2,
    );
    const savingsVsBudget = input.budgetAmount
      ? round(input.budgetAmount - winner.totalPrice, 2)
      : null;

    // The scored comparison and the per-quote verdicts it implies are one decision.
    // Committing the winner first and the quote statuses second would let a
    // failure leave a comparison recommending a quote marked rejected.
    withTransaction(() => {
      upsertComparison({
        requestId: request.id,
        weights,
        rows,
        recommendedQuoteId: winner.quoteId,
        recommendedSupplierId: winner.supplierId,
        budgetAmount: input.budgetAmount,
        savingsVsBudget,
        savingsPctVsBudget: input.budgetAmount
          ? round((savingsVsBudget! / input.budgetAmount) * 100, 2)
          : null,
        savingsVsLowestBid,
        pricePremiumPct,
        rationale: buildRationale(winner, lowest, input.budgetAmount, weights),
        tradeOffNote: buildTradeOffNote(winner, lowest, pricePremiumPct),
      });

      for (const quote of quotes) {
        setQuoteStatus(
          quote.id,
          quote.id === winner.quoteId ? "selected" : "rejected",
        );
      }
    });

    const recommendedQuote = quotes.find((q) => q.id === winner.quoteId) ?? null;
    const recommendedSupplier =
      suppliers.get(winner.supplierId) ?? null;

    const budgetNote =
      savingsVsBudget === null
        ? "no budget was set to measure against"
        : savingsVsBudget >= 0
          ? `${request.currency} ${Math.round(savingsVsBudget).toLocaleString("en-ZA")} under budget`
          : `${request.currency} ${Math.round(Math.abs(savingsVsBudget)).toLocaleString("en-ZA")} over budget`;

    const premiumNote =
      pricePremiumPct > 0.5
        ? ` A ${pricePremiumPct.toFixed(1)}% premium over the cheapest bid buys a materially stronger score on ${describeTopDimension(winner)}.`
        : " It is also the cheapest bid, so there is no trade-off to make.";

    const summary = await narrateSummary({
      agent: "Comparison",
      title: request.title,
      facts: `Weights: price ${weights.price}, quality ${weights.quality}, delivery ${weights.delivery}, terms ${weights.terms}, supplier ${weights.supplier}. Winner: ${winner.supplierName} (${winner.totalScore}/100). Budget position: ${budgetNote}.`,
      fallback: `${recommendedSupplier?.name ?? "Recommended supplier"} wins on weighted score at ${winner.totalScore.toFixed(1)}/100 and ${budgetNote}.${premiumNote}`,
    });

    return {
      summary,
      output: {
        recommendedQuote,
        recommendedSupplier,
        savingsVsBudget,
        savingsVsLowestBid,
      },
      detail: {
        weights,
        rows,
        cheapest: {
          supplier: lowest.supplierName,
          total: lowest.totalPrice,
        },
        recommended: {
          supplier: winner.supplierName,
          total: winner.totalPrice,
          score: winner.totalScore,
        },
      },
    };
  },
};

function deriveWeights(
  urgency: Urgency,
  neededBy: string | null,
  quotes: Quote[],
): ComparisonWeights {
  const weights = { ...BASE_WEIGHTS };

  if (urgency === "critical" || urgency === "high") {
    weights.delivery += 0.15;
    weights.price -= 0.1;
    weights.quality -= 0.05;
  }

  if (neededBy) {
    const anyLate = quotes.some(
      (quote) => addDays(todayIso(), quote.leadTimeDays) > neededBy,
    );
    if (anyLate) {
      weights.delivery += 0.05;
      weights.terms += 0.05;
      weights.price -= 0.05;
      weights.quality -= 0.05;
    }
  }

  const total = Object.values(weights).reduce((acc, value) => acc + value, 0);
  for (const key of Object.keys(weights) as (keyof ComparisonWeights)[]) {
    weights[key] = round(weights[key] / total, 3);
  }
  return weights;
}

function scoreRow(
  quote: Quote,
  supplier: Supplier,
  all: Quote[],
  neededBy: string | null,
  requiredCertifications: string[],
): ComparisonRow {
  const totals = all.map((q) => q.totalPrice);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const priceScore =
    max === min ? 100 : round((1 - (quote.totalPrice - min) / (max - min)) * 100, 1);

  const leadTimes = all.map((q) => q.leadTimeDays);
  const fastest = Math.min(...leadTimes);
  const slowest = Math.max(...leadTimes);
  const leadScore =
    slowest === fastest
      ? 100
      : round((1 - (quote.leadTimeDays - fastest) / (slowest - fastest)) * 100, 1);
  let deliveryScore = round(leadScore * 0.5 + supplier.onTimeRate * 0.5, 1);

  const projected = addDays(todayIso(), quote.leadTimeDays);
  const meetsDate = !neededBy || projected <= neededBy;
  if (!meetsDate) deliveryScore = round(deliveryScore * 0.6, 1);

  const termsScore = round(
    clamp(paymentTermScore(quote.paymentTerms) + warrantyScore(quote.warrantyMonths), 0, 100),
    1,
  );

  const missingCertifications = requiredCertifications.filter(
    (certification) => !supplier.certifications.includes(certification),
  );
  const certificationPenalty = missingCertifications.length * 12;
  const supplierScore = round(
    clamp((supplier.performanceRating / 5) * 100 - certificationPenalty, 0, 100),
    1,
  );

  const pros: string[] = [];
  const cons: string[] = [];

  if (requiredCertifications.length > 0 && missingCertifications.length === 0) {
    pros.push(`Holds every required certification (${requiredCertifications.join(", ")})`);
  }
  for (const missing of missingCertifications) {
    cons.push(`No ${missing} certification on file, which the request requires`);
  }

  if (priceScore >= 90) pros.push("Cheapest of the bids received");
  if (deliveryScore >= 90) pros.push(`Fastest delivery at ${quote.leadTimeDays} days`);
  if (!meetsDate) {
    cons.push(
      `Lead time of ${quote.leadTimeDays} days lands ${projected}, after the required date`,
    );
  }
  if (supplier.qualityScore >= 92) {
    pros.push(`Quality score of ${supplier.qualityScore}`);
  } else if (supplier.qualityScore < 82) {
    cons.push(`Quality score of ${supplier.qualityScore} is the weakest here`);
  }
  if (quote.warrantyMonths >= 36) {
    pros.push(`${quote.warrantyMonths}-month warranty`);
  }
  if (/deposit/i.test(quote.paymentTerms)) {
    cons.push(`Payment terms ${quote.paymentTerms} shift cash to the supplier`);
  } else if (quote.paymentTerms === "Net 60") {
    pros.push("Net 60 payment terms");
  }
  if (supplier.country !== "South Africa") {
    cons.push(`Offshore supply from ${supplier.country}`);
  }

  return {
    quoteId: quote.id,
    supplierId: supplier.id,
    supplierName: supplier.name,
    country: supplier.country,
    totalPrice: quote.totalPrice,
    unitPrice: quote.unitPrice,
    leadTimeDays: quote.leadTimeDays,
    paymentTerms: quote.paymentTerms,
    priceScore,
    qualityScore: supplier.qualityScore,
    deliveryScore,
    termsScore,
    supplierScore,
    totalScore: 0,
    rank: 0,
    pros,
    cons,
  };
}

function paymentTermScore(terms: string): number {
  if (/net\s?60/i.test(terms)) return 80;
  if (/net\s?45/i.test(terms)) return 70;
  if (/net\s?30/i.test(terms)) return 60;
  if (/net\s?15/i.test(terms)) return 45;
  if (/deposit/i.test(terms)) return 25;
  return 40;
}

function warrantyScore(months: number): number {
  return clamp((months / 60) * 20, 0, 20);
}

function describeTopDimension(row: ComparisonRow): string {
  const dimensions: [string, number][] = [
    ["quality", row.qualityScore],
    ["delivery reliability", row.deliveryScore],
    ["commercial terms", row.termsScore],
    ["supplier track record", row.supplierScore],
  ];
  dimensions.sort((a, b) => b[1] - a[1]);
  return dimensions[0][0];
}

function buildRationale(
  winner: ComparisonRow,
  lowest: ComparisonRow,
  budget: number | null,
  weights: ComparisonWeights,
): string {
  const parts = [
    `${winner.supplierName} scores ${winner.totalScore.toFixed(1)}/100 across price (${weights.price}), quality (${weights.quality}), delivery (${weights.delivery}), terms (${weights.terms}) and supplier track record (${weights.supplier}).`,
  ];

  if (winner.quoteId === lowest.quoteId) {
    parts.push("It is simultaneously the cheapest bid, so price is not being traded away.");
  } else {
    parts.push(
      `It costs ${(winner.totalPrice - lowest.totalPrice).toLocaleString("en-ZA")} more than ${lowest.supplierName}, but scores higher on ${describeTopDimension(winner)}.`,
    );
  }

  if (budget !== null) {
    parts.push(
      winner.totalPrice <= budget
        ? `It lands ${(budget - winner.totalPrice).toLocaleString("en-ZA")} below the stated budget.`
        : `It exceeds the stated budget by ${(winner.totalPrice - budget).toLocaleString("en-ZA")}.`,
    );
  }

  return parts.join(" ");
}

function buildTradeOffNote(
  winner: ComparisonRow,
  lowest: ComparisonRow,
  premiumPct: number,
): string | null {
  if (premiumPct <= 0.5) return null;
  return `Accepting a ${premiumPct.toFixed(1)}% premium over ${lowest.supplierName} buys ${winner.deliveryScore >= lowest.deliveryScore ? "faster, more reliable delivery" : "stronger commercial terms"} and a ${Math.round(winner.totalScore - lowest.totalScore)}-point higher overall score. The alternative is ${winner.leadTimeDays > lowest.leadTimeDays ? "slower delivery" : "a weaker quality position"} and a ${Math.round(lowest.totalScore)} score.`;
}
