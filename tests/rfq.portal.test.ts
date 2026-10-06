import { describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers";
import type { NextRequest } from "next/server";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listAudit } from "@/lib/db/audit";
import { getDb } from "@/lib/db/client";
import {
  createRequest,
  findRfqInvitationByToken,
  getComparison,
  getRequest,
  listQuotes,
  listRfqInvitations,
  type NewRequest,
} from "@/lib/db/repository";
import { runSourcingPipeline } from "@/lib/pipeline";
import openPortalPage from "@/app/portal/page";
import { POST as answerRfq } from "@/app/portal/rfq/route";
import { round, todayIso } from "@/lib/util";

setupTestDb();

const PORTAL_REQUEST: NewRequest = {
  title: "Task chairs for the studio",
  rawDescription:
    "We need 10 task chairs for the studio, black mesh, adjustable height, lumbar support.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Design",
  unit: "chair",
  quantity: 10,
  currency: "ZAR",
  budgetAmount: 60_000,
  neededBy: null,
  urgency: "normal",
  quoteMode: "portal",
};

/** The route answers by redirecting; the URL is what tells us the outcome. */
async function post(form: FormData): Promise<string> {
  const request = new Request("http://localhost/portal/rfq", {
    method: "POST",
    body: form,
  });
  try {
    await answerRfq(request as unknown as NextRequest);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    return digest;
  }
  throw new Error("expected the portal to redirect after a submission");
}

function quoteForm(token: string, unitPrice = "1250.50"): FormData {
  const form = new FormData();
  form.set("token", token);
  form.set("action", "quote");
  form.set("unitPrice", unitPrice);
  form.set("leadTimeDays", "10");
  form.set("shippingCost", "250");
  form.set("paymentTerms", "30 days");
  form.set("warrantyMonths", "12");
  form.set("notes", "Includes installation and training.");
  return form;
}

function declineForm(token: string, reason: string): FormData {
  const form = new FormData();
  form.set("token", token);
  form.set("action", "decline");
  form.set("reason", reason);
  return form;
}

describe("supplier portal invitations", () => {
  it("issues an RFQ instead of simulating quotes", async () => {
    const request = createRequest(PORTAL_REQUEST);
    const result = await runSourcingPipeline(request.id);

    expect(result.status).toBe("awaiting_quotes");
    expect(result.summary).toMatch(/supplier portal/i);

    const invitations = listRfqInvitations(request.id);
    expect(invitations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(invitations.map((row) => row.token)).size).toBe(
      invitations.length,
    );
    expect(invitations.every((row) => row.token.startsWith("rfqtok_"))).toBe(true);
    expect(invitations.every((row) => row.status === "invited")).toBe(true);
    expect(invitations.every((row) => row.expiresAt > row.invitedAt)).toBe(true);

    // Nothing has been awarded: the quotes are still out with real suppliers.
    expect(listQuotes(request.id)).toHaveLength(0);
    expect(getComparison(request.id)).toBeNull();

    const entries = listAudit(request.id).filter(
      (entry) => entry.action === "rfq.invitations_created",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({ count: invitations.length });
  });

  it("marks the invitation read when the supplier opens the link", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const invitation = listRfqInvitations(request.id)[0];
    expect(invitation.viewedAt).toBeNull();

    await openPortalPage({
      searchParams: Promise.resolve({ token: invitation.token }),
    });

    const stored = findRfqInvitationByToken(invitation.token)!;
    expect(stored.status).toBe("viewed");
    expect(stored.viewedAt).not.toBeNull();
    expect(stored.respondedAt).toBeNull();
  });
});

describe("supplier portal responses", () => {
  it("accepts a quotation and prices it with VAT at 15%", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const invitation = listRfqInvitations(request.id)[0];

    const url = await post(quoteForm(invitation.token));
    expect(url).toContain("done=quote");

    const stored = findRfqInvitationByToken(invitation.token)!;
    expect(stored.status).toBe("quoted");
    expect(stored.respondedAt).not.toBeNull();
    expect(stored.quoteId).not.toBeNull();

    const quote = listQuotes(request.id).find(
      (row) => row.id === stored.quoteId,
    )!;
    expect(quote.supplierId).toBe(invitation.supplierId);
    expect(quote.unitPrice).toBe(1250.5);
    expect(quote.quantity).toBe(10);
    expect(quote.subtotal).toBe(round(1250.5 * 10, 2));
    expect(quote.shippingCost).toBe(250);
    expect(quote.taxRate).toBe(15);
    expect(quote.totalPrice).toBe(
      round(quote.subtotal + 250 + (quote.subtotal + 250) * 0.15, 2),
    );
    expect(quote.leadTimeDays).toBe(10);
    expect(quote.paymentTerms).toBe("30 days");
    expect(quote.notes).toContain("installation");

    const entries = listAudit(request.id).filter(
      (entry) => entry.action === "rfq.response_received",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe(`supplier:${invitation.supplierId}`);
    expect(entries[0].detail).toMatchObject({ response: "quoted" });

    // Other suppliers are still open, so the run stays paused.
    expect(getRequest(request.id)!.status).toBe("awaiting_quotes");
  });

  it("records a decline with the supplier's reason", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const invitation = listRfqInvitations(request.id)[0];

    const url = await post(
      declineForm(invitation.token, "Outside our lead times this quarter."),
    );
    expect(url).toContain("done=decline");

    const stored = findRfqInvitationByToken(invitation.token)!;
    expect(stored.status).toBe("declined");
    expect(stored.declineReason).toBe("Outside our lead times this quarter.");
    expect(stored.quoteId).toBeNull();
    expect(listQuotes(request.id)).toHaveLength(0);
  });

  it("refuses a token that was never issued", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);

    const url = await post(quoteForm("rfqtok_made-up-token"));
    expect(url).toContain("/portal?error=");
    expect(listQuotes(request.id)).toHaveLength(0);
  });

  it("refuses a second submission after the answer has landed", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const invitation = listRfqInvitations(request.id)[0];

    await post(quoteForm(invitation.token, "1250.50"));
    await post(quoteForm(invitation.token, "999.99"));

    const quotes = listQuotes(request.id).filter(
      (row) => row.supplierId === invitation.supplierId,
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0].unitPrice).toBe(1250.5);
  });

  it("closes the window once every supplier has answered", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const invitations = listRfqInvitations(request.id);

    for (const [index, invitation] of invitations.entries()) {
      const url =
        index === 0
          ? await post(quoteForm(invitation.token))
          : await post(
              declineForm(invitation.token, "We cannot meet this specification."),
            );
      expect(url).toContain("done=");
    }

    // The last answer empties the window, so the run picks up from the
    // comparison step without anyone pressing a button.
    const requestAfter = getRequest(request.id)!;
    expect(requestAfter.status).not.toBe("awaiting_quotes");
    expect(getComparison(request.id)).not.toBeNull();
    expect(listQuotes(request.id)).toHaveLength(1);

    expect(
      listRfqInvitations(request.id).filter((row) => row.status === "quoted"),
    ).toHaveLength(1);
    expect(
      listRfqInvitations(request.id).filter((row) => row.status === "declined"),
    ).toHaveLength(invitations.length - 1);
  });

  it("blocks the request when every supplier declines", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const invitations = listRfqInvitations(request.id);

    for (const invitation of invitations) {
      await post(declineForm(invitation.token, "No capacity for this order."));
    }

    const requestAfter = getRequest(request.id)!;
    expect(requestAfter.status).toBe("blocked");
    expect(listQuotes(request.id)).toHaveLength(0);

    const closed = listAudit(request.id).filter(
      (entry) => entry.action === "rfq.collection_closed",
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].detail).toMatchObject({ quotes: 0, reason: "no_quotes" });
  });

  it("refuses answers after the response window has expired", async () => {
    const request = createRequest(PORTAL_REQUEST);
    await runSourcingPipeline(request.id);
    const target = listRfqInvitations(request.id)[0];

    // Window closed yesterday, no matter what the supplier sends today.
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(past < todayIso()).toBe(true);
    getDb()
      .prepare("UPDATE rfq_invitations SET expires_at = ? WHERE id = ?")
      .run(past, target.id);

    const url = await post(quoteForm(target.token));
    expect(url).toContain("error=");
    expect(url).toContain("window");
    expect(findRfqInvitationByToken(target.token)!.status).toBe("expired");
    expect(listQuotes(request.id)).toHaveLength(0);
  });
});
