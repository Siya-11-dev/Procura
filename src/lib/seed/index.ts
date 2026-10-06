import { getDb } from "@/lib/db/client";
import {
  createRequest,
  getPurchaseOrder,
  insertApprovalAuthority,
  insertBudget,
  insertSupplier,
  listApprovalAuthority,
  listApprovals,
  listBudgets,
  listRequests,
  listSuppliers,
  type NewRequest,
} from "@/lib/db/repository";
import { decideApproval, runSourcingPipeline, submitInvoice } from "@/lib/pipeline";
import { DEFAULT_APPROVAL_CHAIN } from "@/lib/agents/approval.agent";
import { round } from "@/lib/util";
import { DEPARTMENTS } from "@/lib/org";
import { SEED_SUPPLIERS, withCompliance } from "./suppliers";

type Advance = "auto_approve" | "invoice_clean" | "invoice_overbilled" | null;

interface DemoRequest extends NewRequest {
  advance: Advance;
}

const DEMO_REQUESTS: DemoRequest[] = [
  {
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
    advance: null,
  },
  {
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
    advance: "auto_approve",
  },
  {
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
    advance: "invoice_clean",
  },
  {
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
    advance: "invoice_overbilled",
  },
];

let seeding: Promise<void> | null = null;

export function seedSuppliers(): void {
  if (listSuppliers().length > 0) return;
  for (const supplier of SEED_SUPPLIERS) insertSupplier(withCompliance(supplier));
}

/**
 * The delegation-of-authority ladder the approval agent routes against. Seeded
 * as data so a change to a threshold is a row update rather than a migration,
 * but only when nothing is there yet: an admin who has edited the ladder keeps
 * their version across a restart.
 */
export function seedApprovalAuthority(): void {
  if (listApprovalAuthority().length > 0) return;
  for (const threshold of DEFAULT_APPROVAL_CHAIN) {
    insertApprovalAuthority({
      stepOrder: threshold.stepOrder,
      role: threshold.role,
      approverName: threshold.approver,
      thresholdAmount: threshold.upTo,
    });
  }
}

/**
 * A generous per-department ceiling, one per organisation department. The point
 * of seeding it is that the budget check has something real to enforce, not
 * that the demo ever trips it: R5m dwarfs anything the demo requests spend.
 */
export function seedBudgets(): void {
  if (listBudgets().length > 0) return;
  const owners = ["Riaan Steyn", "Nomsa Khumalo", "Thandiwe Mokoena", "Daniel Fischer"];
  DEPARTMENTS.forEach((department, index) => {
    insertBudget({
      department,
      annualLimit: 5_000_000,
      ownerName: owners[index % owners.length],
    });
  });
}

/**
 * Everything a request pipeline assumes exists before it runs: suppliers to
 * shortlist, an authority ladder to route against and budgets to enforce.
 * Tests call this instead of seeding demo requests, which they build themselves.
 */
export function seedBaseline(): void {
  seedSuppliers();
  seedApprovalAuthority();
  seedBudgets();
}

export function ensureSeeded(): Promise<void> {
  if (!seeding) seeding = seedEverything();
  return seeding;
}

async function seedEverything(): Promise<void> {
  getDb();
  seedBaseline();
  if (listRequests().length > 0) return;

  for (const [index, demo] of DEMO_REQUESTS.entries()) {
    const { advance, ...input } = demo;
    const request = createRequest({ ...input, id: `req_seed_${index + 1}` });
    await runSourcingPipeline(request.id);

    if (advance === "auto_approve") {
      await approveEverything(request.id);
    }

    if (advance === "invoice_clean" || advance === "invoice_overbilled") {
      await approveEverything(request.id);
      const po = getPurchaseOrder(request.id);
      if (po) {
        const invoiceAmount = advance === "invoice_overbilled"
          ? round(po.subtotal * 1.085, 2)
          : round(po.subtotal + po.shippingCost, 2);
        const taxAmount = advance === "invoice_overbilled"
          ? round(invoiceAmount * 0.15, 2)
          : po.taxAmount;
        await submitInvoice(request.id, {
          invoiceNumber: `${po.poNumber}-INV`,
          invoiceAmount,
          taxAmount,
          receivedDate: po.expectedDelivery,
        });
      }
    }
  }
}

async function approveEverything(requestId: string): Promise<void> {
  for (let guard = 0; guard < 6; guard += 1) {
    const pending = listApprovals(requestId).find(
      (step) => step.status === "pending",
    );
    if (!pending) break;
    await decideApproval(requestId, pending.id, "approved", "Demo: approved without escalation.");
  }
}
