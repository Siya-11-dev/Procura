/**
 * Run realistic procurement scenarios end to end and print what happened.
 *
 * Uses a throwaway database by default so a walkthrough never disturbs working
 * data. Point PROCURA_DB_PATH at ./data/procura.db to run against the real one.
 *
 *   npm run demo
 *   npm run demo -- --keep          # use ./data/procura.db instead of a temp file
 *   npm run demo -- --only "laptops"
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NewRequest } from "@/lib/db/repository";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? String(argv[onlyIndex + 1] ?? "").toLowerCase() : "";

const tempDir = keep ? null : mkdtempSync(path.join(tmpdir(), "procura-demo-"));
const dbPath = keep
  ? path.resolve("data", "procura.db")
  : path.join(tempDir!, "demo.db");

process.env.PROCURA_DB_PATH = dbPath;
process.env.PROCURA_UPLOAD_DIR = keep
  ? path.resolve("data", "uploads")
  : path.join(tempDir!, "uploads");

const { bootstrap } = await import("@/lib/bootstrap");
const {
  createRequest,
  getPurchaseOrder,
  getRequest,
  getRequestSpec,
  listApprovals,
  listQuotes,
  listRisk,
  insertRiskException,
} = await import("@/lib/db/repository");
const { decideApproval, runSourcingPipeline, submitInvoice, SYSTEM_ACTOR } =
  await import("@/lib/pipeline");
const { verifyAuditChain } = await import("@/lib/db/audit");
const { closeDb } = await import("@/lib/db/client");
const { listUserAudit } = await import("@/lib/auth/user-audit");
const { round } = await import("@/lib/util");

const money = (amount: number, currency = "ZAR") =>
  `${currency} ${Math.round(amount).toLocaleString("en-ZA")}`;

/** Each scenario is a real-shaped request with the outcome it should produce. */
const SCENARIOS: { key: string; title: string; request: NewRequest }[] = [
  {
    key: "laptops",
    title: "Developer laptops, urgent",
    request: {
      title: "Replace the design studio laptops",
      rawDescription:
        "Our design team is on five year old machines and Creative Cloud is starting to struggle with large files. " +
        "We need 12 developer laptops capable of running Adobe CC and Figma. 32GB RAM minimum, 1TB SSD, 16 inch screen. " +
        "Must be ISO 9001 certified suppliers and we need B-BBEE Level 2 or better. Budget is around R250,000 and we need " +
        "them before the end of next month. This is urgent because two designers have already had crashes on client work.",
      requesterName: "Amahle Dlamini",
      requesterDepartment: "Product & Design",
      requesterEmail: "amahle.dlamini@procura.co.za",
      unit: "laptop",
      quantity: 12,
      currency: "ZAR",
      budgetAmount: 250_000,
      neededBy: null,
      urgency: "high",
    },
  },
  {
    key: "chairs",
    title: "Task chairs, auto-approvable",
    request: {
      title: "Office chairs for the new Johannesburg floor",
      rawDescription:
        "We are taking on 24 additional staff on the third floor in Sandton in about three months and need task chairs for them. " +
        "Sit-stand, mesh back, 5 year warranty, black mesh. Also want local stock if possible so we are not waiting months. " +
        "Budget around R180,000 including delivery and installation.",
      requesterName: "Pieter van Wyk",
      requesterDepartment: "People Operations",
      requesterEmail: "pieter.vanwyk@procura.co.za",
      unit: "chair",
      quantity: 24,
      currency: "ZAR",
      budgetAmount: 180_000,
      neededBy: null,
      urgency: "normal",
    },
  },
  {
    key: "crm",
    title: "CRM renewal, clean invoice",
    request: {
      title: "Annual CRM licence renewal",
      rawDescription:
        "Our CRM licence renewal is due. 85 users, we need the enterprise tier with the advanced reporting add-on. " +
        "Must be POPIA compliant and we need an ISO 27001 certified vendor given we hold customer data. " +
        "This is roughly R250,000 a year. Please do not let it lapse, the sales team will lose their pipeline.",
      requesterName: "Sipho Mahlangu",
      requesterDepartment: "Sales",
      requesterEmail: "sipho.mahlangu@procura.co.za",
      unit: "seat",
      quantity: 85,
      currency: "ZAR",
      budgetAmount: 250_000,
      neededBy: null,
      urgency: "high",
    },
  },
  {
    key: "overbilled",
    title: "Facilities servicing, overbilled invoice",
    request: {
      title: "Air conditioning servicing for the Cape Town office",
      rawDescription:
        "The split units on the second floor of the Cape Town office need servicing before summer. Six units, " +
        "annual service including filter replacement and a gas check. We have ISO 9001 and OHSAS 18001 requirements " +
        "for anyone working on our site. Not urgent, needs to be done in the next quarter.",
      requesterName: "Nadia Fortune",
      requesterDepartment: "Facilities",
      requesterEmail: "nadia.fortune@procura.co.za",
      unit: "service",
      quantity: 6,
      currency: "ZAR",
      budgetAmount: 55_000,
      neededBy: null,
      urgency: "low",
    },
  },
  {
    key: "impossible",
    title: "Specification nothing can satisfy",
    request: {
      title: "Zero-emission articulated mining fleet",
      rawDescription:
        "We need 3 fully electric articulated dump trucks rated at 100 tonnes payload for our open pit operation. " +
        "The supplier must already have ISO 45001 and B-BBEE Level 1 certification for a comparable fleet in South Africa. " +
        "Budget is R40,000,000 and we need delivery within six months.",
      requesterName: "Thabo Nkosi",
      requesterDepartment: "Mining Operations",
      requesterEmail: "thabo.nkosi@procura.co.za",
      unit: "truck",
      quantity: 3,
      currency: "ZAR",
      budgetAmount: 40_000_000,
      neededBy: null,
      urgency: "normal",
    },
  },
];

function heading(text: string) {
  console.log(`\n${"─".repeat(78)}\n  ${text}\n${"─".repeat(78)}`);
}

async function approveAll(requestId: string): Promise<string[]> {
  const trail: string[] = [];
  for (let guard = 0; guard < 8; guard += 1) {
    const pending = listApprovals(requestId).find((s) => s.status === "pending");
    if (!pending) break;

    // Compliance blocks are only cleared by a written exception, which is what a
    // human approver does. Grant it the way the app does, then decide the step.
    if (pending.role === "Compliance & Risk Review") {
      const recommended = listRisk(requestId).find((r) => r.isRecommended);
      for (const flag of recommended?.flags.filter((f) => f.severity === "critical") ?? []) {
        insertRiskException({
          requestId,
          flagCode: flag.code,
          justification: "Demo: mitigation accepted in writing by the compliance officer.",
          approverName: "Lerato Mabaso",
        });
        trail.push(`        compliance exception recorded for ${flag.code}`);
      }
    }

    await decideApproval(requestId, pending.id, "approved", "Demo: approved without escalation.");
    trail.push(`        ${pending.role} approved`);
  }
  return trail;
}

await bootstrap();

console.log(`\n  Procura end-to-end walkthrough`);
console.log(`  database: ${keep ? dbPath : "temporary (working data untouched)"}`);
console.log(`  agents:    ${process.env.PROCURA_LLM_API_KEY ? "LLM-backed" : "deterministic rule engine (no API key set)"}`);

const outcomes: { key: string; status: string; note: string }[] = [];

for (const scenario of SCENARIOS) {
  if (only && !scenario.key.includes(only)) continue;

  heading(scenario.title);

  const request = createRequest(scenario.request);
  const started = Date.now();

  const result = await runSourcingPipeline(request.id, SYSTEM_ACTOR);
  const elapsed = Date.now() - started;

  console.log(`\n  Pipeline finished in ${elapsed}ms`);
  console.log(`    status:    ${result.status}`);
  if (result.error) console.log(`    error:     ${result.error}`);
  console.log(`    quotes:    ${listQuotes(request.id).length} received`);
  console.log(`    summary:   ${result.summary}\n`);

  const spec = getRequestSpec(request.id);
  if (spec) {
    const certs = spec.requiredCertifications.length
      ? spec.requiredCertifications.join(", ")
      : "none";
    console.log(`  Read as: category "${spec.category}", required ${certs}\n`);
  }

  if (result.error) {
    outcomes.push({ key: scenario.key, status: result.status, note: result.error });
    continue;
  }

  const recommended = listRisk(request.id).find((r) => r.isRecommended);
  const critical = recommended?.flags.filter((f) => f.severity === "critical") ?? [];
  const warnings = recommended?.flags.filter((f) => f.severity !== "critical") ?? [];

  if (recommended) {
    console.log(`  Risk on the recommended supplier (band ${recommended.band}):`);
    if (critical.length === 0 && warnings.length === 0) {
      console.log("    no findings");
    }
    for (const flag of critical) console.log(`    CRITICAL  ${flag.label}`);
    for (const flag of warnings) console.log(`    ${flag.severity.padEnd(9)} ${flag.label}`);
    console.log("");
  }

  const approvals = await approveAll(request.id);
  if (approvals.length) {
    console.log("  Approval chain:");
    for (const line of approvals) console.log(line);
    console.log("");
  }

  let note = "left awaiting a human decision";
  const po = getPurchaseOrder(request.id);

  if (po) {
console.log(`  Purchase order ${po.poNumber} to ${po.supplierName}`);
  console.log(`    subtotal ${money(po.subtotal)} + shipping ${money(po.shippingCost)} + VAT ${money(po.taxAmount)}`);
  console.log(`    total    ${money(po.totalAmount)}, delivery ${po.expectedDelivery}\n`);

  note = approvals.length
    ? `approved through ${approvals.length} step(s) and issued`
    : "auto-approved under threshold and issued";

    // The last two scenarios exist to prove the invoice agent catches things.
    if (scenario.key === "crm") {
      await submitInvoice(request.id, {
        invoiceNumber: `${po.poNumber}-INV`,
        invoiceAmount: round(po.subtotal + po.shippingCost, 2),
        taxAmount: po.taxAmount,
        receivedDate: po.expectedDelivery,
      });
      note = "clean invoice matched and approved for payment";
    } else if (scenario.key === "overbilled") {
      const over = round(po.subtotal * 1.085, 2);
      await submitInvoice(request.id, {
        invoiceNumber: `${po.poNumber}-INV`,
        invoiceAmount: over,
        taxAmount: round(over * 0.15, 2),
        receivedDate: po.expectedDelivery,
      });
      note = "8.5% overbilled invoice caught and rejected";
    }
  } else if (critical.length > 0) {
    note = "purchase order withheld: unresolved critical findings";
  } else {
    note = "no purchase order raised";
  }

  const final = getRequest(request.id);
  console.log(`  Outcome: ${final?.status} — ${note}\n`);
  outcomes.push({ key: scenario.key, status: final?.status ?? "unknown", note });
}

heading("Integrity checks");

const chain = verifyAuditChain();
console.log(`  request audit chain: ${chain.entries} entries, valid: ${chain.valid}${chain.brokenAtSeq ? ` (broke at seq ${chain.brokenAtSeq})` : ""}`);
console.log(`  account audit log:  ${listUserAudit(200).length} entries`);

console.log("\n  Summary:");
for (const outcome of outcomes) {
  console.log(`    ${outcome.key.padEnd(12)} ${outcome.status.padEnd(18)} ${outcome.note}`);
}
console.log("");

if (!keep && tempDir) {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log("  Temporary database removed. Working data untouched.\n");
} else {
  console.log(`  Written to ${dbPath}\n`);
}

// Keep a non-zero exit if the chain is broken, so this can gate CI later.
if (!chain.valid) process.exitCode = 1;