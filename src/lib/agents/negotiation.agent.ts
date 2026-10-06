import {
  applyNegotiatedPrice,
  getComparison,
  getNegotiation,
  getRequestSpec,
  listRisk,
  listSuppliers,
  upsertNegotiation,
} from "@/lib/db/repository";
import type {
  NegotiationLeverage,
  NegotiationMessage,
  Quote,
  RiskFlag,
  Supplier,
} from "@/lib/domain/types";
import { between, clamp, round } from "@/lib/util";
import { narrateSummary } from "./llm";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface NegotiationAgentInput {
  quotes: Quote[];
}

export interface NegotiationAgentOutput {
  status: "agreed" | "unsuccessful" | "not_applicable";
  agreedUnitPrice: number | null;
  realisedSaving: number;
  expectedSaving: number;
}

export const negotiationAgent: Agent<
  NegotiationAgentInput,
  NegotiationAgentOutput
> = {
  name: "negotiation",
  async run(
    context: AgentContext,
    input: NegotiationAgentInput,
  ): Promise<AgentResult<NegotiationAgentOutput>> {
    const { request, rng } = context;
    const comparison = getComparison(request.id);
    const suppliers = new Map(listSuppliers().map((s) => [s.id, s]));

    const recommendedQuote = input.quotes.find(
      (quote) => quote.id === comparison?.recommendedQuoteId,
    );
    if (!comparison || !recommendedQuote) {
      return {
        summary: "No recommended quotation to negotiate against. Negotiation skipped.",
        output: {
          status: "not_applicable",
          agreedUnitPrice: null,
          realisedSaving: 0,
          expectedSaving: 0,
        },
        detail: null,
      };
    }

    const spec = getRequestSpec(request.id);
    const risks = listRisk(request.id);
    const runnerUp = input.quotes
      .filter((quote) => quote.id !== recommendedQuote.id)
      .sort((a, b) => a.totalPrice - b.totalPrice)[0];

    const supplier = suppliers.get(recommendedQuote.supplierId)!;
    const listUnitPrice = recommendedQuote.unitPrice;
    const allTotals = input.quotes.map((quote) => quote.totalPrice);
    const medianTotal = median(allTotals);

    const walkawayTotal = runnerUp
      ? runnerUp.totalPrice
      : round(recommendedQuote.totalPrice * 0.94, 2);
    const walkawayUnitPrice = round(
      (walkawayTotal - recommendedQuote.shippingCost) / recommendedQuote.quantity,
      2,
    );

    // The target is always an ask below list. The walkaway is a floor, never an
    // anchor: when the winner is already the cheapest bid the runner-up sits
    // above list, and anchoring to it would collapse the target onto list and
    // make the whole negotiation a no-op.
    const targetUnitPrice = round(
      clamp(
        Math.min(listUnitPrice * 0.965, walkawayUnitPrice * 0.98),
        listUnitPrice * 0.9,
        listUnitPrice * 0.99,
      ),
      2,
    );
    const openingUnitPrice = round(
      clamp(targetUnitPrice * 0.965, listUnitPrice * 0.88, targetUnitPrice),
      2,
    );

    const leverage = buildLeverage({
      supplier,
      quote: recommendedQuote,
      runnerUp,
      medianTotal,
      spec,
      riskFlags: risks.find((risk) => risk.isRecommended)?.flags ?? [],
    });

    const responsiveness = between(rng, 0.7, 1.25);
    const baseFlexibility = clamp(
      leverage.filter((point) => point.strength === "strong").length * 0.03 +
        (supplier.financialHealth === "watch" ? 0.02 : 0),
      0,
      0.12,
    );
    const flexibility = round(baseFlexibility * responsiveness, 3);

    const gapToMedian = (listUnitPrice - medianUnitPrice(input.quotes)) / listUnitPrice;
    const concessionRate = clamp(
      0.012 + flexibility * 0.5 + gapToMedian * 0.35,
      0.008,
      0.09,
    );
    const counterUnitPrice = round(
      clamp(listUnitPrice * (1 - concessionRate), targetUnitPrice, listUnitPrice),
      2,
    );

    const accepted = counterUnitPrice <= targetUnitPrice;
    const agreedUnitPrice = accepted
      ? counterUnitPrice
      : round((counterUnitPrice + targetUnitPrice) / 2, 2);

    const agreedIsWithinWalkaway = agreedUnitPrice <= walkawayUnitPrice + 0.01;
    const status = agreedIsWithinWalkaway ? "agreed" : "unsuccessful";

    const expectedConcession = ((listUnitPrice - counterUnitPrice) / listUnitPrice) * 100;
    leverage.push({
      point: "Supplier responsiveness",
      strength:
        responsiveness >= 1.1 ? "strong" : responsiveness >= 0.9 ? "moderate" : "weak",
      detail: `Trade history on ${supplier.name} suggests they move roughly ${expectedConcession.toFixed(1)}% off list when the award is contested, which sets how hard to push before they walk.`,
    });

    const transcript = buildTranscript({
      supplier,
      currency: request.currency,
      openingUnitPrice,
      counterUnitPrice,
      targetUnitPrice,
      listUnitPrice,
      accepted,
      agreedUnitPrice,
    });

    if (status === "agreed") {
      applyNegotiatedPrice(recommendedQuote.id, agreedUnitPrice);
    }

    const realisedSaving = round((listUnitPrice - agreedUnitPrice) * recommendedQuote.quantity, 2);
    const expectedSaving = round((listUnitPrice - targetUnitPrice) * recommendedQuote.quantity, 2);

    const strategy = buildStrategy({
      supplier,
      status,
      openingUnitPrice,
      listUnitPrice,
      agreedUnitPrice,
      walkawayUnitPrice,
      runnerUp,
      leverage,
    });

    upsertNegotiation({
      requestId: request.id,
      quoteId: recommendedQuote.id,
      supplierId: supplier.id,
      supplierName: supplier.name,
      listUnitPrice,
      openingUnitPrice,
      targetUnitPrice,
      walkawayUnitPrice,
      counterUnitPrice,
      agreedUnitPrice: status === "agreed" ? agreedUnitPrice : null,
      expectedSaving,
      realisedSaving: status === "agreed" ? realisedSaving : 0,
      leverage,
      strategy,
      status,
      transcript,
    });

    const pct = ((listUnitPrice - agreedUnitPrice) / listUnitPrice) * 100;
    const summary = await narrateSummary({
      agent: "Negotiation",
      title: request.title,
      facts: `Supplier: ${supplier.name}. List ${request.currency} ${listUnitPrice.toLocaleString("en-ZA")} per unit; settled at ${request.currency} ${agreedUnitPrice.toLocaleString("en-ZA")} (${pct.toFixed(1)}% off list). Saved ${request.currency} ${Math.round(realisedSaving).toLocaleString("en-ZA")} on the lot.`,
      fallback:
        status === "agreed"
          ? `Opened at ${request.currency} ${openingUnitPrice.toLocaleString("en-ZA")} against a list price of ${request.currency} ${listUnitPrice.toLocaleString("en-ZA")} and settled at ${request.currency} ${agreedUnitPrice.toLocaleString("en-ZA")}, ${pct.toFixed(1)}% off list and ${request.currency} ${Math.round(realisedSaving).toLocaleString("en-ZA")} saved on the lot.`
          : `${supplier.name} held above the walkaway price. Negotiation closed unsuccessful and the award falls back to ${runnerUp ? suppliers.get(runnerUp.supplierId)?.name : "the next ranked supplier"}.`,
    });

    return {
      summary,
      output: {
        status,
        agreedUnitPrice: status === "agreed" ? agreedUnitPrice : null,
        realisedSaving: status === "agreed" ? realisedSaving : 0,
        expectedSaving,
      },
      detail: getNegotiation(request.id),
    };
  },
};

function buildLeverage(input: {
  supplier: Supplier;
  quote: Quote;
  runnerUp: Quote | undefined;
  medianTotal: number;
  spec: ReturnType<typeof getRequestSpec>;
  riskFlags: RiskFlag[];
}): NegotiationLeverage[] {
  const { supplier, quote, runnerUp, medianTotal, spec, riskFlags } = input;
  const leverage: NegotiationLeverage[] = [];

  if (runnerUp) {
    const gap = quote.totalPrice - runnerUp.totalPrice;
    leverage.push({
      point: "Competitive tension",
      strength: gap / quote.totalPrice > 0.08 ? "strong" : "moderate",
      detail: `The next ranked bid is ${gap.toLocaleString("en-ZA")} cheaper, so this award is genuinely contestable and the supplier knows it.`,
    });
  }

  const vsMedian = ((quote.totalPrice - medianTotal) / medianTotal) * 100;
  leverage.push({
    point: "Market benchmark",
    strength: vsMedian > 4 ? "strong" : vsMedian > -2 ? "moderate" : "weak",
    detail:
      vsMedian > 0
        ? `This bid sits ${vsMedian.toFixed(1)}% above the ${input.quote.currency} ${Math.round(medianTotal).toLocaleString("en-ZA")} median received, which is the anchor for the opening position.`
        : `This bid is already ${Math.abs(vsMedian).toFixed(1)}% below the median, so leverage is limited to terms rather than price.`,
  });

  leverage.push({
    point: "Volume commitment",
    strength: quote.quantity >= 50 ? "strong" : "moderate",
    detail:
      quote.quantity >= 50
        ? `At ${quote.quantity} units the next price break sits at ${quote.priceBreaks[2]?.minQty ?? quote.quantity * 5} units. A framework agreement covering both is worth offering for a deeper discount.`
        : `Consolidating this lot with repeat demand could unlock the ${quote.priceBreaks[1]?.minQty ?? quote.quantity * 2}-unit break they already quoted.`,
  });

  leverage.push({
    point: "Terms as currency",
    strength: /deposit/i.test(quote.paymentTerms) ? "strong" : "moderate",
    detail: `They asked for ${quote.paymentTerms}. Trading an extended payment term for a price concession usually costs less than a direct discount.`,
  });

  if (supplier.financialHealth !== "strong") {
    leverage.push({
      point: "Counterparty condition",
      strength: "strong",
      detail: `Their financial health is recorded as ${supplier.financialHealth}, which makes them more receptive to staged payment in exchange for a better price.`,
    });
  }

  const critical = riskFlags.find((flag) => flag.severity === "critical");
  if (critical) {
    leverage.push({
      point: "Leveraging the risk position",
      strength: "strong",
      detail: `${critical.label}: ${critical.detail} A remediation commitment is a fair condition of any price concession.`,
    });
  }

  if (spec?.niceToHave.length) {
    leverage.push({
      point: "Traded additions",
      strength: "weak",
      detail: `The requester flagged ${spec.niceToHave.join(", ")} as desirable. These can be conceded in exchange for price rather than paid for.`,
    });
  }

  return leverage;
}

function buildTranscript(input: {
  supplier: Supplier;
  currency: string;
  openingUnitPrice: number;
  counterUnitPrice: number;
  targetUnitPrice: number;
  listUnitPrice: number;
  accepted: boolean;
  agreedUnitPrice: number;
}): NegotiationMessage[] {
  const { supplier, currency: symbol, openingUnitPrice, counterUnitPrice, targetUnitPrice, listUnitPrice, accepted, agreedUnitPrice } = input;
  const currency = `${symbol} `;

  const messages: NegotiationMessage[] = [
    {
      from: "procura",
      at: stamp(0),
      message: `Thanks for the quotation. We have competing bids and are consolidating spend with this supplier into a repeat order. Can you meet ${currency}${openingUnitPrice.toLocaleString("en-ZA")} per unit, with net 45 terms?`,
    },
    {
      from: "supplier",
      at: stamp(1),
      message: `We can come down, but not that far. ${currency}${counterUnitPrice.toLocaleString("en-ZA")} per unit is as low as we go on list of ${currency}${listUnitPrice.toLocaleString("en-ZA")}, and we'd need a 30% deposit to hold the lead time.`,
    },
  ];

  if (accepted) {
    messages.push({
      from: "procura",
      at: stamp(2),
      message: `${currency}${counterUnitPrice.toLocaleString("en-ZA")} is below our target of ${currency}${targetUnitPrice.toLocaleString("en-ZA")}, so we can accept it. We will hold the deposit on the condition of the ${supplier.onTimeRate}% delivery service level being written into the PO.`,
    });
    messages.push({
      from: "supplier",
      at: stamp(3),
      message: `Confirmed at ${currency}${agreedUnitPrice.toLocaleString("en-ZA")} per unit. We'll have the PO acknowledgement back the same day.`,
    });
  } else {
    messages.push({
      from: "procura",
      at: stamp(2),
      message: `That is above what our target of ${currency}${targetUnitPrice.toLocaleString("en-ZA")} allows. Final position is ${currency}${targetUnitPrice.toLocaleString("en-ZA")}, and we can make a firm award today.`,
    });
    messages.push({
      from: "supplier",
      at: stamp(3),
      message: `We are not able to move below ${currency}${counterUnitPrice.toLocaleString("en-ZA")} on this volume. If the position changes we are happy to be considered again.`,
    });
  }

  return messages;
}

function stamp(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

function buildStrategy(input: {
  supplier: Supplier;
  status: "agreed" | "unsuccessful";
  openingUnitPrice: number;
  listUnitPrice: number;
  agreedUnitPrice: number;
  walkawayUnitPrice: number;
  runnerUp: Quote | undefined;
  leverage: NegotiationLeverage[];
}): string {
  const { status, openingUnitPrice, listUnitPrice, agreedUnitPrice, walkawayUnitPrice, runnerUp, leverage } = input;

  const strong = leverage.filter((point) => point.strength === "strong");
  const basis = strong.length
    ? strong.map((point) => point.point.toLowerCase()).join(", ")
    : "the benchmark position";

  if (status === "agreed") {
    return `Anchor ${((listUnitPrice - openingUnitPrice) / listUnitPrice * 100).toFixed(1)}% below list on the strength of ${basis}. Hold the walkaway of ${walkawayUnitPrice.toFixed(2)} as the point at which the award moves to ${runnerUp ? "the second-ranked supplier" : "a re-tender"}. Settled at ${agreedUnitPrice.toFixed(2)}, inside the walkaway.`;
  }

  return `Anchor ${((listUnitPrice - openingUnitPrice) / listUnitPrice * 100).toFixed(1)}% below list on the strength of ${basis}. The supplier would not move below their counter, which is above the walkaway of ${walkawayUnitPrice.toFixed(2)}. Escalate to ${runnerUp ? "the next ranked supplier" : "a wider re-tender"} rather than pay above the walkaway.`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round((sorted[mid - 1] + sorted[mid]) / 2, 2)
    : sorted[mid];
}

function medianUnitPrice(quotes: Quote[]): number {
  const byTotal = quotes
    .map((quote) => ({
      total: quote.totalPrice,
      unit: (quote.totalPrice - quote.shippingCost) / quote.quantity,
    }))
    .sort((a, b) => a.total - b.total);
  const mid = Math.floor(byTotal.length / 2);
  return byTotal.length % 2 === 0
    ? round((byTotal[mid - 1].unit + byTotal[mid].unit) / 2, 2)
    : round(byTotal[mid].unit, 2);
}
