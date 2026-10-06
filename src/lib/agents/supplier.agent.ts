import { listSuppliers } from "@/lib/db/repository";
import type { Category, Supplier } from "@/lib/domain/types";
import { clamp, round } from "@/lib/util";
import type { RequestSpec } from "@/lib/db/repository";
import { narrateSummary } from "./llm";
import type { Agent, AgentContext, AgentResult } from "./types";

export interface SupplierMatch {
  supplier: Supplier;
  matchScore: number;
  categoryFit: number;
  certificationFit: number;
  commercialFit: number;
  trackRecord: number;
  reasons: string[];
  concerns: string[];
}

export interface SupplierAgentOutput {
  shortlist: SupplierMatch[];
  poolSize: number;
  rejections: { supplier: string; reason: string }[];
}

const MAX_SHORTLIST = 6;

export const supplierAgent: Agent<RequestSpec, SupplierAgentOutput> = {
  name: "supplier",
  async run(context: AgentContext, spec: RequestSpec): Promise<AgentResult<SupplierAgentOutput>> {
    const { request } = context;
    const pool = listSuppliers();
    const matches: SupplierMatch[] = [];
    const rejections: { supplier: string; reason: string }[] = [];
    const budget = request.budgetAmount;

    for (const supplier of pool) {
      const categoryFit = scoreCategory(supplier.categories, spec.category);
      if (categoryFit === 0) {
        rejections.push({
          supplier: supplier.name,
          reason: "Does not supply this category",
        });
        continue;
      }

      const certificationFit = scoreCertifications(
        supplier.certifications,
        spec.requiredCertifications,
      );
      const commercialFit = scoreCommercial(supplier, request.quantity ?? 1, budget);
      const trackRecord = scoreTrackRecord(supplier, request.neededBy);

      const matchScore = round(
        categoryFit * 0.35 +
          certificationFit * 0.25 +
          commercialFit * 0.2 +
          trackRecord * 0.2,
        3,
      );

      const { reasons, concerns } = buildNarrative(
        supplier,
        spec,
        certificationFit,
        commercialFit,
        trackRecord,
      );

      matches.push({
        supplier,
        matchScore,
        categoryFit: round(categoryFit, 3),
        certificationFit: round(certificationFit, 3),
        commercialFit: round(commercialFit, 3),
        trackRecord: round(trackRecord, 3),
        reasons,
        concerns,
      });
    }

    matches.sort((a, b) => b.matchScore - a.matchScore);
    const shortlist = matches.slice(0, MAX_SHORTLIST);
    for (const match of matches.slice(MAX_SHORTLIST)) {
      rejections.push({
        supplier: match.supplier.name,
        reason: `Ranked below the shortlist (match ${Math.round(match.matchScore * 100)}%)`,
      });
    }

    const summary = await narrateSummary({
      agent: "Supplier",
      title: request.title,
      facts: `Category: ${spec.category}. Required certifications: ${spec.requiredCertifications.join(", ") || "none"}. Budget: ${budget === null ? "not stated" : request.currency + " " + budget}. Shortlisted ${shortlist.length} of ${pool.length}.`,
      fallback:
        shortlist.length === 0
          ? "No supplier in the network can serve this category. Sourcing is blocked."
          : `Shortlisted ${shortlist.length} of ${pool.length} suppliers from ${pool.length} in the network. ` +
            `Top match ${shortlist[0].supplier.name} at ${Math.round(shortlist[0].matchScore * 100)}%.`,
    });

    return {
      summary,
      output: {
        shortlist,
        poolSize: pool.length,
        rejections: rejections.slice(0, 8),
      },
      detail: { shortlist, rejections: rejections.slice(0, 8) },
    };
  },
};

function scoreCategory(
  categories: Category[],
  target: Category,
): number {
  if (categories.includes(target)) return 1;
  if (target === "general") return categories.length > 0 ? 0.6 : 0;
  const adjacent: Partial<Record<Category, Category[]>> = {
    "it-hardware": ["software", "logistics", "lab-equipment", "office-furniture"],
    software: ["it-hardware", "professional-services"],
    "office-furniture": ["facilities", "general"],
    facilities: ["office-furniture", "professional-services", "general"],
    marketing: ["professional-services", "logistics"],
    "professional-services": ["marketing", "software", "facilities"],
    logistics: ["it-hardware", "marketing"],
    "lab-equipment": ["it-hardware"],
  };
  return categories.some((category) => adjacent[target]?.includes(category))
    ? 0.55
    : 0;
}

function scoreCertifications(
  held: string[],
  required: string[],
): number {
  if (required.length === 0) return 0.8;
  const matched = required.filter((certification) =>
    held.some((candidate) =>
      candidate.toLowerCase().startsWith(certification.toLowerCase().split(" ")[0]),
    ),
  ).length;
  return clamp(matched / required.length, 0, 1);
}

function scoreCommercial(
  supplier: Supplier,
  quantity: number,
  budget: number | null,
): number {
  let score = 0.6;
  if (supplier.minOrderValue > 0) {
    score = quantity >= 1 ? 0.7 : 0.3;
  }
  if (budget && supplier.minOrderValue > budget * 0.5) {
    score -= 0.2;
  }
  if (supplier.financialHealth === "strong") score += 0.2;
  if (supplier.financialHealth === "watch") score -= 0.15;
  if (supplier.financialHealth === "distressed") score -= 0.35;
  return clamp(score, 0, 1);
}

function scoreTrackRecord(supplier: Supplier, neededBy: string | null): number {
  const delivery = supplier.onTimeRate / 100;
  const reliability = (supplier.qualityScore / 100) * 0.4 + delivery * 0.6;
  if (!neededBy) return clamp(reliability, 0, 1);
  return clamp(reliability * 0.9 + delivery * 0.1, 0, 1);
}

function buildNarrative(
  supplier: Supplier,
  spec: RequestSpec,
  certificationFit: number,
  commercialFit: number,
  trackRecord: number,
): { reasons: string[]; concerns: string[] } {
  const reasons: string[] = [];
  const concerns: string[] = [];

  if (supplier.categories.includes(spec.category)) {
    reasons.push(`Core supplier for ${spec.category.replace(/-/g, " ")}`);
  } else {
    reasons.push("Supplies an adjacent category");
  }

  if (certificationFit === 1) {
    reasons.push(`Holds all required certifications (${spec.requiredCertifications.join(", ")})`);
  } else if (certificationFit > 0) {
    concerns.push("Does not hold every required certification");
  }

  if (trackRecord >= 0.9) {
    reasons.push(`${supplier.onTimeRate}% on-time delivery, ${supplier.qualityScore}% quality score`);
  } else if (trackRecord < 0.8) {
    concerns.push(`${supplier.onTimeRate}% on-time delivery is below the 85% bar`);
  }

  if (commercialFit < 0.55) {
    concerns.push("Minimum order value sits awkwardly against this order size");
  }

  if (supplier.financialHealth === "watch") {
    concerns.push("Financial health flagged as 'watch'");
  }

  if (supplier.responseRate < 75) {
    concerns.push(`Responds to ${supplier.responseRate}% of RFQs, so may not quote`);
  }

  if (supplier.country !== "South Africa") {
    concerns.push(`Offshore supply from ${supplier.country} adds lead time and currency exposure`);
  }

  return { reasons, concerns };
}
