import type {
  Category,
  ProcurementRequest,
  Urgency,
} from "@/lib/domain/types";
import { addDays, clamp, round, todayIso } from "@/lib/util";

export interface CategoryProfile {
  category: Category;
  keywords: string[];
  units: string[];
  priceRange: [number, number];
  leadTimeRange: [number, number];
  taxRate: number;
  certifications: string[];
  paymentTerms: string[];
}

export const CATEGORY_PROFILES: Record<Category, CategoryProfile> = {
  "it-hardware": {
    category: "it-hardware",
    keywords: [
      "laptop", "laptops", "notebook", "notebooks", "desktop", "workstation",
      "monitor", "monitors", "screen", "screens", "display", "printer",
      "server", "servers", "router", "switch", "keyboard", "mouse", "ssd",
      "hard drive", "ram", "memory", "projector", "tablet", "dock", "usb",
      "pc", "pcs", "computer", "computers", "scanner", "backup",
    ],
    units: [
      "laptop", "desktop", "dock", "monitor", "server", "tablet", "printer",
      "workstation", "unit", "set", "item",
    ],
    priceRange: [7_500, 34_000],
    leadTimeRange: [3, 21],
    taxRate: 15,
    certifications: ["ISO 9001", "B-BBEE"],
    paymentTerms: ["Net 30", "Net 15", "Net 45"],
  },
  software: {
    category: "software",
    keywords: [
      "licence", "license", "licences", "licenses", "subscription", "saas",
      "software", "platform", "crm", "erp", "seat", "seats", "renewal",
      "api", "hosting", "cloud", "licensing", "subscription", "tool",
      "toolset", "add-on", "addon",
    ],
    units: ["seat", "licence", "license", "subscription", "user"],
    priceRange: [400, 12_000],
    leadTimeRange: [0, 7],
    taxRate: 15,
    certifications: ["ISO 27001", "POPIA compliant"],
    paymentTerms: ["Net 30", "Net 60", "Monthly billing"],
  },
  "office-furniture": {
    category: "office-furniture",
    keywords: [
      "desk", "desks", "chair", "chairs", "cabinet", "table", "tables",
      "workstation", "bench", "shelf", "drawer", "sofa", "partition",
      "furniture", "sit-stand", "task chair", "bookcase", "filing",
    ],
    units: ["item", "chair", "desk", "set", "unit"],
    priceRange: [900, 18_000],
    leadTimeRange: [5, 35],
    taxRate: 15,
    certifications: ["B-BBEE", "FSC Chain of Custody"],
    paymentTerms: ["Net 30", "Net 15", "30% deposit"],
  },
  facilities: {
    category: "facilities",
    keywords: [
      "aircon", "air conditioning", "plumbing", "electrical", "cleaning",
      "pest control", "generator", "lift", "maintenance", "fit-out",
      "renovation", "painting", "carpet", "roof", "fencing", "glass",
      "servicing", "repairs", "plant room",
    ],
    units: ["service", "hour", "day", "unit", "sqm", "m2"],
    priceRange: [850, 16_000],
    leadTimeRange: [5, 40],
    taxRate: 15,
    certifications: ["ISO 9001", "B-BBEE", "OHSAS 18001"],
    paymentTerms: ["Net 30", "Net 15", "30% deposit"],
  },
  marketing: {
    category: "marketing",
    keywords: [
      "campaign", "event", "banner", "exhibition", "branding", "advert",
      "advertising", "sponsorship", "social media", "print", "signage",
      "booth", "conference", "promotional", "activation", "media",
    ],
    units: ["item", "day", "campaign", "event", "unit"],
    priceRange: [1_500, 120_000],
    leadTimeRange: [7, 45],
    taxRate: 15,
    certifications: ["B-BBEE", "ISO 9001"],
    paymentTerms: ["Net 30", "50% deposit", "Net 15"],
  },
  "professional-services": {
    category: "professional-services",
    keywords: [
      "consultant", "consulting", "consultancy", "legal", "audit", "training",
      "workshop", "advisory", "review", "design", "architect", "translation",
      "accounting", "tax", "strategy", "facilitation", "coaching", "research",
    ],
    units: ["day", "hour", "engagement", "session", "unit"],
    priceRange: [4_500, 180_000],
    leadTimeRange: [5, 40],
    taxRate: 15,
    certifications: ["B-BBEE", "ISO 9001", "CPD accredited"],
    paymentTerms: ["Net 30", "Retainer", "50% deposit"],
  },
  logistics: {
    category: "logistics",
    keywords: [
      "courier", "freight", "shipping", "transport", "warehouse", "pallet",
      "clearance", "delivery", "dispatch", "haulage", "consignment", "airfreight",
    ],
    units: ["shipment", "pallet", "consignment", "kg", "tonne", "unit"],
    priceRange: [350, 22_000],
    leadTimeRange: [1, 14],
    taxRate: 15,
    certifications: ["ISO 9001", "B-BBEE"],
    paymentTerms: ["Net 30", "Net 15", "On delivery"],
  },
  "lab-equipment": {
    category: "lab-equipment",
    keywords: [
      "centrifuge", "spectrometer", "microscope", "pipette", "incubator",
      "calorimeter", "analytical", "laboratory", "lab", "reagent", "assay",
      "chromatograph", "freezer", "autoclave",
    ],
    units: ["unit", "instrument", "set", "each"],
    priceRange: [18_000, 480_000],
    leadTimeRange: [10, 60],
    taxRate: 15,
    certifications: ["ISO 13485", "ISO 9001"],
    paymentTerms: ["Net 30", "30% deposit", "Net 60"],
  },
  general: {
    category: "general",
    keywords: [],
    units: ["unit", "item", "each"],
    priceRange: [500, 25_000],
    leadTimeRange: [3, 30],
    taxRate: 15,
    certifications: ["B-BBEE"],
    paymentTerms: ["Net 30"],
  },
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3,
  april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// Order nouns that may carry a count. Durations (days, weeks, months) and
// measure/spec words (inch, GB, W) are deliberately excluded: they are
// deadlines and specifications, never order quantities. Extending this list is
// the cheap fix for an unrecognised noun, which otherwise silently collapses the
// order to a single unit.
const QUANTITY_UNITS =
  "units?|items?|each|laptops?|notebooks?|desktops?|workstations?|monitors?|displays?|screens?|projectors?|servers?|tablets?|printers?|scanners?|chairs?|desks?|signs?|signage|banners?|vehicles?|licences?|licenses?|subscriptions?|seats?|users?|boxes?|pallets?|crates?|kits?|sets?|pieces?|appliances?|services?|shipments?|consignments?|instruments?|campaigns?|events?|sessions?|engagements?|sqm|m2" +
  "|docks?|dongles?|adapters?|stations?|docking ?stations?|connectors?|receptacles?|power ?strips?|extension ?leads?|cables?|chargers?|batteries?|headsets?|headphones?|earphones?|microphones?|webcams?|cameras?|keyboards?|keypads?|mice|mouse|monitors? ?arms?|drones?|routers?|switches?|access ?points?|modems?|drives?|toners?|cartridges?|projectors? ?screens?" +
  "|whiteboards?|notice ?boards?|posters?|leaflets?|brochures?|mugs?|uniforms?|aprons?|name ?tags?|badges?|lanyards?|plaques?|trophies?|medals?|awards?" +
  "|first ?aid ?kits?|fire ?extinguishers?|smoke ?alarms?|safety ?glasses?|goggles?|hi-?vis ?vests?|hard ?hats?|helmets?|lab ?coats?|rubber ?gloves?" +
  "|waste ?bins?|mats?|locks?|safes?|cleaning ?services?|servicing|repairs?|maintenance|installations?|fit-?outs?|consultanc(?:y|ies)|trainings?|workshops?|audits?|reviews?|placements?|shifts?|meals?|catering ?meals?";

function countMatches(text: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    const pattern = new RegExp(
      `\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    count += text.match(pattern)?.length ?? 0;
  }
  return count;
}

/**
 * Words that turn up in almost any purchase request, so one of them appearing is
 * not evidence of anything. "We need delivery within six months" says nothing
 * about buying freight services, but on its own it was enough to read a request
 * for mining trucks as logistics, which then sourced it from an IT reseller.
 * A category must match at least one word outside this set to be sourced.
 */
const AMBIGUOUS_KEYWORDS = new Set([
  "delivery", "deliver", "supplier", "supply", "service", "services",
  "unit", "units", "item", "items", "set", "sets", "day", "days",
  "month", "months", "year", "years", "annual", "week", "weeks", "quarter",
  "purchase", "order", "quote", "price", "cost", "installation", "install",
]);

export function detectCategory(text: string): {
  category: Category;
  confidence: number;
  matched: string[];
  evidence: string[];
  inNetwork: boolean;
} {
  const scores = (Object.keys(CATEGORY_PROFILES) as Category[])
    .map((category) => {
      const profile = CATEGORY_PROFILES[category];
      const matched = profile.keywords.filter((keyword) =>
        new RegExp(`\\b${keyword}\\b`, "i").test(text),
      );
      const score = countMatches(text, profile.keywords) + matched.length * 2;
      const evidence = matched.filter((keyword) => !AMBIGUOUS_KEYWORDS.has(keyword));
      return { category, score, matched, evidence };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return {
      category: "general",
      confidence: 0.3,
      matched: [],
      evidence: [],
      inNetwork: false,
    };
  }

  // Only a category with a specific keyword counts. The best-scoring category
  // can otherwise be one that merely shares a generic word with the text, which
  // is how an out-of-network request used to reach a confident wrong supplier.
  const qualified = scores.filter((entry) => entry.evidence.length > 0);
  if (qualified.length === 0) {
    return {
      category: scores[0].category,
      confidence: round(scores[0].score / scores.reduce((a, e) => a + e.score, 0), 2),
      matched: scores[0].matched,
      evidence: [],
      inNetwork: false,
    };
  }

  const [best] = qualified;
  const total = scores.reduce((acc, entry) => acc + entry.score, 0);
  return {
    category: best.category,
    confidence: clamp(best.score / total, 0.35, 0.99),
    matched: best.matched,
    evidence: best.evidence,
    inNetwork: true,
  };
}

export function parseQuantity(text: string): number | null {
  const units = `(?:${QUANTITY_UNITS})`;
  const unitTest = new RegExp(`\\b${units}\\b`, "i");

  // Confident shapes first: an explicit multiplier, or a count sitting directly
  // against a unit noun. Durations are deliberately not in the unit vocabulary,
  // so "deliver in 3 days" reads as a deadline, not a quantity.
  const strict = [
    new RegExp(`\\bx\\s*(${NUMBER_TOKEN})\\b`, "i"),
    new RegExp(`\\b(${NUMBER_TOKEN})\\s*(?:off\\s+)?${units}\\b`, "i"),
    new RegExp(`\\b${units}\\s*[:x]?\\s*(${NUMBER_TOKEN})\\b`, "i"),
    new RegExp(`\\b${units}\\s+(?:of\\s+)(${NUMBER_TOKEN})\\b`, "i"),
  ];
  for (const pattern of strict) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const count = resolveCount(match[1]);
      if (count) return count;
    }
  }

  // Otherwise take the earliest count in the text and accept it only when a unit
  // noun follows within four tokens, which covers specs written between the
  // count and the noun ("three 4K 55 inch displays"). This is deliberately
  // conservative: a free-scanning window reads the panel size as the count and
  // inflates the order by an order of magnitude, so an ambiguous line is left
  // to the agent's clarifications instead.
  for (const match of text.matchAll(new RegExp(`\\b(${NUMBER_TOKEN})\\b`, "gi"))) {
    const token = match[1];

    // A four digit figure is a year, a standard number or a date, not a count.
    if (/^\d{4}$/.test(token)) continue;
    if (STANDARD_CONTEXT.test(previousToken(text, match.index ?? 0))) continue;

    const after = text.slice((match.index ?? 0) + token.length).trim();
    const [nextWord = ""] = after.split(/\s+/);
    if (MEASURE_WORD.test(nextWord)) continue;
    if (unitTest.test(after.split(/\s+/).slice(0, 4).join(" "))) {
      const count = resolveCount(token);
      if (count) return count;
    }
  }
  return null;
}

/** The word immediately before the character at `index`, with punctuation removed. */
function previousToken(text: string, index: number): string {
  return (text.slice(0, index).trim().split(/\s+/).pop() ?? "").replace(/[^\w]/g, "");
}

function normaliseAmount(raw: string): number | null {
  const digits = raw.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number.parseFloat(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A count-like number that parseQuantity could not attach to a unit noun, such
 * as the "Four" in "Four 600W monolights". Only called once parseQuantity has
 * already failed, so any surviving number is by definition unattached. Specs,
 * standards, dates, durations and money are filtered out so the caller can
 * distinguish a real unparsed quantity from ordinary text.
 */
function findOrphanCount(text: string): string | null {
  const units = new RegExp(`\\b${`(?:${QUANTITY_UNITS})`}\\b`, "i");
  const tokens = text.split(/\s+/);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].replace(/[^\w]/g, "");
    if (!new RegExp(`^(?:\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})$`, "i").test(token)) {
      continue;
    }

    const previous = tokens[i - 1]?.replace(/[^\w]/g, "") ?? "";
    if (STANDARD_CONTEXT.test(previous)) continue;
    // Currency, and dates such as 2026-04-15.
    if (/^(?:R|ZAR)$/i.test(previous)) continue;
    if (token.length === 4 && /^\d{4}$/.test(token)) continue;

    // A spec directly after the number, e.g. 600W, 32GB, 55 inch.
    const next = tokens[i + 1]?.replace(/[^\w]/g, "") ?? "";
    if (MEASURE_WORD.test(next)) continue;

    // Durations are deadlines, not order quantities.
    if (/^(?:day|days|week|weeks|month|months|year|years)$/i.test(next)) continue;

    // Anything the count patterns would have resolved is not an orphan.
    const nearby = tokens.slice(i + 1, i + 4).join(" ");
    if (units.test(nearby)) continue;

    return token;
  }

  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, dozen: 12,
};

const NUMBER_TOKEN = `\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")}`;

// Size and power specs that follow a number. A count directly before one of
// these is part of a spec, never an order quantity.
const MEASURE_WORD =
  /^(?:inch(?:es)?|cm|mm|met(?:re|er)s?|kg|kgs?|g|grams?|gb|mb|tb|kw|w|watts?|v|volts?|ml|l|litres?|liters?|ft|feet|micron)$/i;

// Words that turn a following number into a standard reference rather than a
// count: "ISO 9001", "B-BBEE Level 2".
const STANDARD_CONTEXT =
  /^(?:iso|iec|sans|bs|en|astm|ieee|isoiec|level|grade|class|category|part|no|nr|section|clause|amendment|ansi|ul|ce)$/i;

/** Resolve a count token that may be written as a digit or a word. */
function resolveCount(token: string): number | null {
  const value = Number.parseInt(token.replace(/[,\s]/g, ""), 10);
  if (Number.isFinite(value)) return value > 0 && value < 1_000_000 ? value : null;
  return NUMBER_WORDS[token.toLowerCase()] ?? null;
}

export function parseBudget(text: string): number | null {
  // The currency marker must not be the tail of a word: without the lookbehind
  // the "r" in "Four 600W monolights" reads as a rand sign and 600 becomes the
  // budget.
  const currencyMatch = text.match(
    /(?<![A-Za-z])(?:R|ZAR)\s?([\d][\d,.]*)\s*(k|m|thousand|million)?(?![A-Za-z])/i,
  );
  if (currencyMatch) {
    const base = normaliseAmount(currencyMatch[1]);
    if (base) {
      const suffix = currencyMatch[2]?.toLowerCase();
      if (suffix === "k" || suffix === "thousand") return base * 1_000;
      if (suffix === "m" || suffix === "million") return base * 1_000_000;
      return base;
    }
  }

  const budgetLine = text.match(
    /\b(?:budget|spend|cost(?:s|ing)?|cap|ceiling|approved)\b[^0-9R]{0,15}(?:R\s?)?([\d][\d,.]*)\s*(k|m|thousand|million)?/i,
  );
  if (budgetLine) {
    const base = normaliseAmount(budgetLine[1]);
    if (base) {
      const suffix = budgetLine[2]?.toLowerCase();
      if (suffix === "k" || suffix === "thousand") return base * 1_000;
      if (suffix === "m" || suffix === "million") return base * 1_000_000;
      return base;
    }
  }

  // A bare "95k" is only a budget when a spend word precedes it, otherwise
  // specs like "600W" and "4K monitors" are misread as money.
  const shorthand = text.match(
    /\b(?:budget|spend|cost(?:s|ing)?|cap|ceiling|approved|around|about|approx)\b[^0-9]{0,15}?([\d][\d,.]*)\s?(k|m|thousand|million)\b/i,
  );
  if (shorthand) {
    const base = normaliseAmount(shorthand[1]);
    if (base) {
      const suffix = shorthand[2].toLowerCase();
      if (suffix === "k" || suffix === "thousand") return base * 1_000;
      return base * 1_000_000;
    }
  }

  return null;
}

export function parseNeededBy(text: string): string | null {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const now = new Date();

  const within = text.match(
    new RegExp(
      `\\b(?:within|in|inside|over)\\s+(?:(?:about|around|roughly|approximately|some)\\s+)?(?:the\\s+next\\s+)?(${NUMBER_TOKEN})\\s*(day|week|month)s?\\b`,
      "i",
    ),
  );
  if (within) {
    const amount = resolveCount(within[1]);
    if (amount) {
      const unit = within[2].toLowerCase();
      return addDays(
        todayIso(),
        unit === "day" ? amount : unit === "week" ? amount * 7 : amount * 30,
      );
    }
  }

  // Scan every "<day> <word>" pair rather than the first one. A single match
  // would be shadowed by any earlier number-plus-word pair that is not a date,
  // such as "15 USB-C" ahead of "15 November".
  for (const named of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\b/gi)) {
    const month = MONTHS[named[2].toLowerCase()];
    if (month === undefined) continue;
    const day = Number.parseInt(named[1], 10);
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    let year = now.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getTime() < now.getTime() - 30 * 86_400_000) {
      year += 1;
      candidate = new Date(Date.UTC(year, month, day));
    }
    return candidate.toISOString().slice(0, 10);
  }

  if (/\bnext\s+week\b/i.test(text)) return addDays(todayIso(), 7);
  if (/\bnext\s+month\b/i.test(text)) return addDays(todayIso(), 30);
  if (/\bend\s+of\s+month\b/i.test(text)) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    return end.toISOString().slice(0, 10);
  }
  if (/\basap\b|\bimmediately\b|\bthis week\b/i.test(text)) {
    return addDays(todayIso(), 5);
  }

  return null;
}

export function detectUrgency(text: string, declared: Urgency): Urgency {
  if (/\b(critical|blocker|production down|emergency)\b/i.test(text)) {
    return "critical";
  }
  if (/\b(urgent|asap|as soon as possible|immediately|this week)\b/i.test(text)) {
    return "high";
  }
  if (/\b(no rush|not urgent|low priority|whenever convenient|next quarter)\b/i.test(text)) {
    return "low";
  }
  return declared;
}

const SPEC_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "Processor", pattern: /\b(i[3579]\s?-?\d{4,5}|ryzen\s?[3579]\s?\d{4,5}|core\s?i[3579])\b/i },
  { label: "Memory", pattern: /\b(\d{1,2}\s?gb\s?(ram|memory))\b/i },
  { label: "Storage", pattern: /\b(\d{2,4}\s?gb\s?(ssd|storage)|(\d|1|2|4)\s?tb\s?(ssd|hdd|nvme))\b/i },
  { label: "Screen size", pattern: /\b(\d{2}\s?(inch|inches|"))\b/i },
  { label: "Resolution", pattern: /\b(\d{3,4}\s?x\s?\d{3,4})\b/i },
  { label: "Warranty", pattern: /\b(\d\s?-?\s?year\s+warranty|on-?site\s+warranty)\b/i },
  { label: "Power rating", pattern: /\b(\d{2,4}\s?(kva|w|kw))\b/i },
  { label: "Capacity", pattern: /\b(\d+\s?(litres|litres|l|kg|tonnes|tons|seats|people))\b/i },
  { label: "Standard", pattern: /\b(iso\s?\d{4,5}|en\s?\d{3,5}|sabs|sans\s?\d+|iec\s?\d+)\b/i },
  { label: "Colour", pattern: /\b(black|white|silver|grey|gray|navy|red|blue)\s+(finish|frame|upholstery|panels?)\b/i },
  { label: "Connectivity", pattern: /\b(wifi\s?6|wi-?fi|bluetooth|usb-?c|thunderbolt|ethernet|5g)\b/i },
];

const CERTIFICATION_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "ISO 9001", pattern: /iso\s?9001/i },
  { name: "ISO 14001", pattern: /iso\s?14001/i },
  { name: "ISO 27001", pattern: /iso\s?27001|information security/i },
  { name: "ISO 13485", pattern: /iso\s?13485/i },
  { name: "B-BBEE", pattern: /b-?bbee/i },
  { name: "POPIA compliant", pattern: /popia/i },
  { name: "CE marked", pattern: /\bce\b(?!\w)/i },
  { name: "FSC Chain of Custody", pattern: /fsc/i },
  { name: "CPD accredited", pattern: /cpd/i },
  { name: "OHSAS 18001", pattern: /ohsas|iso\s?45001/i },
];

const MUST_HAVE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "local support or presence", pattern: /local (support|presence|service|delivery|stock)/i },
  { name: "B-BBEE compliance", pattern: /b-?bbee/i },
  { name: "on-site warranty", pattern: /on-?site/i },
  { name: "stock held locally", pattern: /stock|in stock|from stock/i },
  { name: "fixed price", pattern: /fixed price|no price increases/i },
  { name: "long-term agreement", pattern: /contract|framework|master agreement/i },
  { name: "sustainable or recycled", pattern: /sustainab|recycled|eco-?friendly|carbon/i },
];

const NICE_TO_HAVE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "extended warranty", pattern: /extended warranty|extra warranty/i },
  { name: "installation included", pattern: /install|installation|fit-?out/i },
  { name: "training included", pattern: /training|onboarding/i },
  { name: "preferential payment terms", pattern: /net\s?(45|60|90)|payment terms/i },
  { name: "local supplier preference", pattern: /local supplier|prefer local/i },
];

function uniqueMatches(
  text: string,
  patterns: { name: string; pattern: RegExp }[],
): { name: string; value: string }[] {
  const seen = new Set<string>();
  const results: { name: string; value: string }[] = [];
  for (const { name, pattern } of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = match[0].trim();
    const key = `${name}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ name, value });
  }
  return results;
}

export interface ParsedRequest {
  summary: string;
  category: Category;
  unit: string;
  quantity: number;
  budgetAmount: number | null;
  neededBy: string | null;
  specifications: { label: string; value: string; required: boolean }[];
  requiredCertifications: string[];
  mustHave: string[];
  niceToHave: string[];
  deliveryRequirement: string;
  budgetSignal: string;
  urgency: Urgency;
  completeness: number;
  clarifications: string[];
  assumptions: string[];
  /**
   * Codes for the questions a request cannot be sourced without answered. These
   * are a strict subset of `clarifications`: everything that merely explains an
   * assumption stays non-blocking, so a complete-enough request still runs.
   */
  blockingClarifications: string[];
  /** False when nothing specific in the text maps to a configured category. */
  inNetwork: boolean;
  /** The category words that carried the classification, for the audit trail. */
  categoryEvidence: string[];
}

export function parseRequestText(
  request: ProcurementRequest,
  attachmentText = "",
): ParsedRequest {
  // Attachments are parsed on exactly the same footing as the typed description:
  // a figure in a spec sheet counts the same as the same figure typed in prose.
  const text = [request.title, request.rawDescription, attachmentText]
    .filter((part) => part.trim().length > 0)
    .join("\n");
  const detection = detectCategory(text);
  const category = request.category ?? detection.category;
  const activeProfile = CATEGORY_PROFILES[category];

  // A category already on the record came from an earlier run or from a person,
  // and is taken at face value; "general" is what an out-of-network request was
  // parked as, so it must not be read back as a decision.
  const inNetwork =
    detection.inNetwork || (request.category !== null && request.category !== "general");

  const textQuantity = parseQuantity(text);
  const quantity = request.quantity ?? textQuantity ?? 1;
  const unit =
    request.unit && request.unit !== "units"
      ? request.unit
      : pickUnit(text, activeProfile, textQuantity);

  const textBudget = parseBudget(text);
  const budget = request.budgetAmount ?? textBudget;
  const neededBy = request.neededBy ?? parseNeededBy(text);
  const urgency = detectUrgency(text, request.urgency);

  const specMatches = uniqueMatches(
    text,
    SPEC_PATTERNS.map((entry) => ({ name: entry.label, pattern: entry.pattern })),
  ).map((match) => ({
    label: match.name,
    value: match.value.replace(/\s+/g, " "),
    required: true,
  }));

  const certifications = uniqueMatches(
    text,
    CERTIFICATION_PATTERNS.map((entry) => ({
      name: entry.name,
      pattern: entry.pattern,
    })),
  ).map((match) => match.name);

  const mustHave = uniqueMatches(
    text,
    MUST_HAVE_PATTERNS.map((entry) => ({
      name: entry.name,
      pattern: entry.pattern,
    })),
  ).map((match) => match.name);

  const niceToHave = uniqueMatches(
    text,
    NICE_TO_HAVE_PATTERNS.map((entry) => ({
      name: entry.name,
      pattern: entry.pattern,
    })),
  ).map((match) => match.name);

  const clarifications: string[] = [];
  const assumptions: string[] = [];
  const blockingClarifications: string[] = [];

  // A count we could not attach to a noun, or two counts that disagree, means
  // the request cannot be sourced: pricing and comparison both depend on how
  // many are wanted. These outcomes are recorded as blocking codes as well as
  // sentences, so the pipeline can gate on them without re-parsing the text.
  const orphanQuantity =
    !textQuantity && !request.quantity ? findOrphanCount(text) : null;

  if (orphanQuantity) {
    blockingClarifications.push("quantity_unconfirmed");
  } else if (!textQuantity && !request.quantity) {
    blockingClarifications.push("quantity_missing");
  } else if (request.quantity && textQuantity && request.quantity !== textQuantity) {
    blockingClarifications.push("quantity_conflict");
  }

  if (!textQuantity && !request.quantity) {
    // Distinguish "no number anywhere" from "a number is present but the noun
    // is not one we recognise". Guessing one lot in the second case is exactly
    // the assumption an approver needs told about.
    if (orphanQuantity) {
      clarifications.push(
        `A quantity of "${orphanQuantity}" appears in the description but the item it refers to could not be read, so sourcing assumes a single unit or lot. Confirm the quantity before this is approved.`,
      );
      assumptions.push(
        "Quantity was not read from the text; confirm the count with the requester.",
      );
    } else {
      clarifications.push(
        "Quantity was not stated, so sourcing assumes a single unit or lot.",
      );
      assumptions.push("Proceeding on the basis of one lot as described.");
    }
  }
  if (!textBudget && !request.budgetAmount) {
    clarifications.push(
      "No budget was provided, so quotes will be compared on commercial merit rather than against a ceiling.",
    );
  } else if (budget && activeProfile.priceRange) {
    const implied = budget / quantity;
    if (implied > activeProfile.priceRange[1]) {
      clarifications.push(
        `Budget implies about ${Math.round(implied).toLocaleString("en-ZA")} per ${unit}, above the typical ${activeProfile.category} range — quality or volume is being prioritised over price.`,
      );
    } else if (implied < activeProfile.priceRange[0] * 0.5) {
      clarifications.push(
        `Budget implies about ${Math.round(implied).toLocaleString("en-ZA")} per ${unit}, well below the typical ${activeProfile.category} range — expect a specification compromise.`,
      );
    }
  }
  if (!neededBy) {
    clarifications.push(
      "No delivery date was given, so lead time is treated as a scored criterion rather than a hard constraint.",
    );
  }
  if (specMatches.length === 0) {
    clarifications.push(
      "No technical specification was stated, so suppliers will be asked to propose one and it will be scored on quality and support.",
    );
  }
  if (request.quantity && textQuantity && request.quantity !== textQuantity) {
    clarifications.push(
      `Form quantity (${request.quantity}) differs from the quantity in the description (${textQuantity}); the form value is used.`,
    );
  }
  if (detection.confidence < 0.5 && !request.category) {
    clarifications.push(
      "Category could not be established with confidence, so the general supplier pool was searched.",
    );
  }
  if (certifications.length === 0) {
    assumptions.push(
      `Standard ${activeProfile.certifications.join(" and ")} requirements applied for ${activeProfile.category}.`,
    );
  }
  if (request.requesterDepartment) {
    assumptions.push(
      `Cost centre assumed to be ${request.requesterDepartment}.`,
    );
  }

  const completenessSignals = [
    Boolean(textQuantity || request.quantity),
    Boolean(textBudget || request.budgetAmount),
    Boolean(neededBy),
    specMatches.length > 0,
    Boolean(request.requesterName && request.requesterEmail),
    // A request counts as substantive if either the prose or an attachment
    // carried the detail, so a short note plus a full spec sheet is complete.
    request.rawDescription.trim().length > 60 ||
      attachmentText.trim().length > 60,
  ];
  const completeness = clamp(
    completenessSignals.filter(Boolean).length / completenessSignals.length,
    0.2,
    1,
  );

  const budgetSignal = budget
    ? `${request.currency} ${budget.toLocaleString("en-ZA")} for ${quantity} ${unit}${
        quantity === 1 ? "" : "s"
      }${neededBy ? `, needed by ${neededBy}` : ""}`
    : "No budget stated — sourcing will optimise on total commercial value";

  const deliveryRequirement = neededBy
    ? `Must be delivered by ${neededBy}`
    : "No fixed date — lead time will be scored, not enforced";

  const summary = buildSummary({
    title: request.title,
    category,
    quantity,
    unit,
    budget,
    currency: request.currency,
    neededBy,
    profile: activeProfile,
  });

  return {
    summary,
    category,
    unit,
    quantity,
    budgetAmount: budget,
    neededBy,
    specifications: specMatches,
    requiredCertifications:
      certifications.length > 0 ? certifications : activeProfile.certifications,
    mustHave,
    niceToHave,
    deliveryRequirement,
    budgetSignal,
    urgency,
    completeness,
    clarifications,
    assumptions,
    blockingClarifications,
    inNetwork,
    categoryEvidence: detection.evidence,
  };
}

/**
 * The noun a detected count actually modifies, e.g. the "docking stations" in
 * "15 docking stations". A title can mention a different product in the same
 * sentence ("Laptop docking stations for the design team"), so the noun attached
 * to the count wins over any other unit in the profile.
 */
function unitAfterCount(text: string, count: number): string | null {
  const before = text.slice(0, text.length);
  const digits = String(count);
  const index = before.search(
    new RegExp(
      `\\b${digits}\\b(?:\\s+\\S+){0,3}?\\s+((?:${QUANTITY_UNITS}))\\b`,
      "i",
    ),
  );
  if (index < 0) return null;
  const match = before
    .slice(index)
    .match(new RegExp(`\\b\\d{1,4}\\b(?:\\s+\\S+){0,3}?\\s+((?:${QUANTITY_UNITS}))\\b`, "i"));
  return match?.[1] ? match[1].toLowerCase().replace(/s$/, "") : null;
}

function pickUnit(
  text: string,
  profile: CategoryProfile,
  count: number | null,
): string {
  // The noun the count modifies is the most reliable signal available.
  if (count !== null) {
    const attached = unitAfterCount(text, count);
    if (attached) return attached;
  }
  const lower = text.toLowerCase();
  for (const unit of profile.units) {
    if (new RegExp(`\\b${unit}s?\\b`, "i").test(lower)) return unit;
  }
  return "unit";
}

function buildSummary(input: {
  title: string;
  category: Category;
  quantity: number;
  unit: string;
  budget: number | null;
  currency: ProcurementRequest["currency"];
  neededBy: string | null;
  profile: CategoryProfile;
}): string {
  const scope = `${input.quantity} ${input.unit}${input.quantity === 1 ? "" : "s"} of ${input.category.replace(/-/g, " ")}`;
  const money = input.budget
    ? `${input.currency} ${input.budget.toLocaleString("en-ZA")}`
    : "no stated budget";
  const timing = input.neededBy ? `, needed by ${input.neededBy}` : "";
  return `${input.title}: ${scope} within ${money}${timing}. Typical lead time for this category is ${input.profile.leadTimeRange[0]}–${input.profile.leadTimeRange[1]} days.`;
}
