import {
  deleteQuotes,
  insertQuote,
  type NewQuote,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import type { Category, Quote, Supplier } from "@/lib/domain/types";
import { addDays, between, clamp, round, todayIso } from "@/lib/util";
import { CATEGORY_PROFILES } from "./parsing";
import { narrateSummary } from "./llm";
import type { SupplierMatch } from "./supplier.agent";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface QuoteAgentInput {
  shortlist: SupplierMatch[];
  category: Category;
  quantity: number;
}

export interface QuoteAgentOutput {
  quotes: Quote[];
  declines: { supplier: string; reason: string }[];
  invitedCount: number;
  responseCount: number;
  rangeLow: number;
  rangeHigh: number;
  medianTotal: number;
}

const VAT_RATE = 15;

export const quoteAgent: Agent<QuoteAgentInput, QuoteAgentOutput> = {
  name: "quote",
  async run(
    context: AgentContext,
    input: QuoteAgentInput,
  ): Promise<AgentResult<QuoteAgentOutput>> {
    const { request, rng } = context;
    const { shortlist } = input;
    const profile = CATEGORY_PROFILES[input.category];

    const quantity = input.quantity;
    const declines: { supplier: string; reason: string }[] = [];

    // Replacing the quote set is one outcome: a failure part-way through the
    // invitations must not leave the request with some suppliers quoted and
    // others silently dropped.
    const quotes: Quote[] = withTransaction(() => {
      deleteQuotes(request.id);

      const collected: Quote[] = [];
      for (const match of shortlist) {
        const { supplier } = match;

        const decline = shouldDecline(
          match,
          quantity,
          profile.priceRange,
          rng,
        );
        if (decline) {
          declines.push({ supplier: supplier.name, reason: decline });
          continue;
        }

        const quote = buildQuote({
          requestId: request.id,
          supplier,
          quantity,
          currency: request.currency,
          category: input.category,
          rng,
        });
        collected.push(insertQuote(quote));
      }
      return collected;
    });

    quotes.sort((a, b) => a.totalPrice - b.totalPrice);

    const totals = quotes.map((quote) => quote.totalPrice);
    const rangeLow = totals.length ? Math.min(...totals) : 0;
    const rangeHigh = totals.length ? Math.max(...totals) : 0;
    const medianTotal = median(totals);

    const summary = await narrateSummary({
      agent: "Quote",
      title: request.title,
      facts: `Category: ${input.category}. Invited: ${shortlist.length}. Responded: ${quotes.length}. Range: ${request.currency} ${rangeLow.toLocaleString("en-ZA")} to ${request.currency} ${rangeHigh.toLocaleString("en-ZA")}.`,
      fallback:
        quotes.length === 0
          ? "No supplier responded with a quotation. Escalating for a sourcing decision."
          : `Collected ${quotes.length} quotations from ${shortlist.length} invited suppliers, ` +
            `ranging ${request.currency} ${Math.round(rangeLow).toLocaleString("en-ZA")} to ${Math.round(rangeHigh).toLocaleString("en-ZA")}.`,
    });

    return {
      summary,
      output: {
        quotes,
        declines,
        invitedCount: shortlist.length,
        responseCount: quotes.length,
        rangeLow,
        rangeHigh,
        medianTotal,
      },
      detail: {
        invited: shortlist.map((match) => ({
          supplier: match.supplier.name,
          country: match.supplier.country,
          terms: "RFQ issued by email and portal",
        })),
        declines,
        quotes: quotes.map((quote) => ({
          supplierId: quote.supplierId,
          unitPrice: quote.unitPrice,
          totalPrice: quote.totalPrice,
          leadTimeDays: quote.leadTimeDays,
          paymentTerms: quote.paymentTerms,
          warrantyMonths: quote.warrantyMonths,
        })),
      },
    };
  },
};

/**
 * The commercial reasons a supplier might not answer an RFQ. The simulated
 * pipeline and the portal collection both use it, so a supplier that would
 * have declined in a simulated run declines in a portal one too.
 */
export function shouldDecline(
  match: SupplierMatch,
  quantity: number,
  priceRange: [number, number],
  rng: () => number,
): string | null {
  const { supplier } = match;
  const notional = quantity * priceRange[1];

  if (supplier.minOrderValue > notional * 1.5) {
    return `Minimum order value of ${supplier.currency} ${supplier.minOrderValue.toLocaleString("en-ZA")} exceeds the value of this lot`;
  }

  if (supplier.responseRate < 80 && rng() > supplier.responseRate / 100) {
    return "Did not respond to the RFQ within the response window";
  }

  if (supplier.financialHealth === "distressed" && rng() > 0.4) {
    return "Capacity constraints, declined for the current period";
  }

  if (supplier.onTimeRate < 80 && rng() > 0.75) {
    return "No stock available in the required lead time";
  }

  return null;
}

interface BuildQuoteInput {
  requestId: string;
  supplier: Supplier;
  quantity: number;
  currency: Quote["currency"];
  category: Category;
  rng: () => number;
}

function buildQuote(input: BuildQuoteInput): NewQuote {
  const profile = CATEGORY_PROFILES[input.category];
  const { supplier, quantity, rng } = input;

  const volumeFactor = volumeDiscount(quantity);
  const countryFactor = supplier.country === "South Africa" ? 1.02 : 0.9;
  const healthFactor =
    supplier.financialHealth === "strong"
      ? 0.98
      : supplier.financialHealth === "stable"
        ? 1.02
        : supplier.financialHealth === "watch"
          ? 0.9
          : 1.12;
  const qualityFactor = 1 + (supplier.qualityScore - 85) / 320;
  const noise = between(rng, 0.95, 1.09);

  const [low, high] = profile.priceRange;
  // Sample a position across the whole band rather than pinning every supplier
  // to roughly 76% of it, which priced all nine categories near their ceiling
  // and left the shortlist with almost no price competition. Quality still
  // tilts the position upward through qualityFactor, so the correlation the old
  // formula expressed explicitly is preserved.
  const bandPosition = between(rng, 0.12, 0.88);
  const mid = low + (high - low) * bandPosition;
  const unitPrice = round(mid * volumeFactor * countryFactor * healthFactor * qualityFactor * noise, 2);

  const subtotal = round(unitPrice * quantity, 2);
  const shippingCost = round(
    supplier.country === "South Africa"
      ? subtotal * between(rng, 0.005, 0.02)
      : subtotal * between(rng, 0.04, 0.11),
    2,
  );
  const taxAmount = round((subtotal + shippingCost) * (VAT_RATE / 100), 2);
  const totalPrice = round(subtotal + shippingCost + taxAmount, 2);

  const [minLead, maxLead] = profile.leadTimeRange;
  const offshorePenalty = supplier.country === "South Africa" ? 0 : 14;
  const reliabilityPenalty = Math.round((100 - supplier.onTimeRate) / 4);
  const leadTimeDays = Math.max(
    1,
    Math.round(
      between(rng, minLead, maxLead) + offshorePenalty + reliabilityPenalty,
    ),
  );

  const terms = pickTerms(supplier.financialHealth, subtotal, profile.paymentTerms, rng);
  const warrantyMonths =
    input.category === "professional-services"
      ? 0
      : Math.round(between(rng, 12, supplier.qualityScore > 90 ? 60 : 36) / 12) * 12;

  const priceBreaks = [
    { minQty: Math.max(1, Math.round(quantity)), unitPrice },
    { minQty: Math.round(quantity * 2), unitPrice: round(unitPrice * 0.94, 2) },
    { minQty: Math.round(quantity * 5), unitPrice: round(unitPrice * 0.87, 2) },
  ];

  const notes: string[] = [];
  if (supplier.currency !== input.currency) {
    notes.push(
      `Supplier bills in ${supplier.currency}; FX exposure sits with ${supplier.name} at quote validity.`,
    );
  }
  if (supplier.country !== "South Africa") {
    notes.push(`Shipped from ${supplier.city}, ${supplier.country} on ${incoterm(supplier.country)}.`);
  }
  if (warrantyMonths >= 36) {
    notes.push(`${warrantyMonths}-month warranty included on all units.`);
  }
  if (priceBreaks[2].minQty > quantity) {
    notes.push(
      `Volume break available at ${priceBreaks[2].minQty} units at ${input.currency} ${priceBreaks[2].unitPrice.toLocaleString("en-ZA")} each.`,
    );
  }

  return {
    requestId: input.requestId,
    supplierId: supplier.id,
    unitPrice,
    currency: input.currency,
    quantity,
    subtotal,
    shippingCost,
    taxRate: VAT_RATE,
    totalPrice,
    minimumOrderQty: Math.max(1, Math.round(quantity * 0.5)),
    leadTimeDays,
    paymentTerms: terms,
    warrantyMonths,
    validityDays: pick([30, 30, 45, 60], rng),
    priceBreaks,
    incoterms: incoterm(supplier.country),
    notes: notes.join(" "),
    status: "received",
    receivedAt: `${todayIso()}T${String(6 + Math.floor(rng() * 9)).padStart(2, "0")}:${String(Math.floor(rng() * 60)).padStart(2, "0")}:00.000Z`,
    declineReason: null,
  };
}

function volumeDiscount(quantity: number): number {
  if (quantity >= 500) return 0.82;
  if (quantity >= 250) return 0.86;
  if (quantity >= 100) return 0.9;
  if (quantity >= 50) return 0.94;
  if (quantity >= 25) return 0.97;
  return 1;
}

function pickTerms(
  health: Supplier["financialHealth"],
  subtotal: number,
  options: string[],
  rng: () => number,
): string {
  if (health === "distressed" || health === "watch") {
    return options.find((term) => /deposit|On delivery/i.test(term)) ?? "30% deposit";
  }
  if (subtotal > 250_000) {
    return options.find((term) => /deposit/i.test(term)) ?? "50% deposit";
  }
  return pick(options, rng);
}

function incoterm(country: string): string {
  return country === "South Africa" ? "DDP Johannesburg" : "DAP Johannesburg";
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round((sorted[mid - 1] + sorted[mid]) / 2, 2)
    : sorted[mid];
}

export function expectedDelivery(leadTimeDays: number, neededBy: string | null): string {
  const projected = addDays(todayIso(), leadTimeDays);
  if (neededBy && new Date(projected) > new Date(neededBy)) {
    return neededBy;
  }
  return projected;
}

export function normaliseScore(value: number, min: number, max: number): number {
  return clamp((value - min) / (max - min || 1), 0, 1);
}

/** Build the quote a supplier would return, given a seeded sequence of draws. */
export const buildSimulatedQuote = buildQuote;
