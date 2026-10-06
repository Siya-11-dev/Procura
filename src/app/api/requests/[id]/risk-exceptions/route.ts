import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireRoles } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import {
  getRequest,
  insertRiskException,
  listRisk,
} from "@/lib/db/repository";
import { appendAudit } from "@/lib/db/audit";
import { withTransaction } from "@/lib/db/client";
import { raisePurchaseOrder } from "@/lib/pipeline";
import { revalidatePath } from "next/cache";

const RISK_EXCEPTION_ROLES: readonly Role[] = [
  "procurement_lead",
  "cfo",
  "ceo",
  "compliance_officer",
  "admin",
];

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/requests/[id]/risk-exceptions">,
) {
  await bootstrap();
  const auth = await requireRoles(RISK_EXCEPTION_ROLES);
  if (auth.error) return authErrorResponse(auth.error);
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const flagCode = typeof body.flagCode === "string" ? body.flagCode.trim() : "";
  const justification =
    typeof body.justification === "string" ? body.justification.trim() : "";
  const approverName =
    typeof body.approverName === "string"
      ? body.approverName.trim()
      : auth.actor.name;

  if (!flagCode) {
    return Response.json({ error: "flagCode is required." }, { status: 422 });
  }
  if (justification.length < 10) {
    return Response.json(
      { error: "A written justification of at least 10 characters is required to accept a critical risk." },
      { status: 422 },
    );
  }

  const procurementRequest = getRequest(id);
  if (!procurementRequest) {
    return Response.json({ error: "Request not found." }, { status: 404 });
  }

  const recommended = listRisk(id).find((risk) => risk.isRecommended);
  const flag = recommended?.flags.find(
    (candidate) => candidate.code === flagCode && candidate.severity === "critical",
  );
  if (!flag) {
    return Response.json(
      { error: "That finding is not an unresolved critical risk on the recommended supplier." },
      { status: 409 },
    );
  }

  // The exception and its audit entry belong together. This route previously
  // wrote the exception with no entry at all, which is the one mutation in the
  // app that released a purchase order with no accountable approver on record.
  withTransaction(() => {
    insertRiskException({ requestId: id, flagCode, justification, approverName });

    appendAudit({
      requestId: id,
      actor: auth.actor.id,
      actorRole: auth.actor.role,
      action: "risk.exception_granted",
      entityType: "risk_exception",
      entityId: flagCode,
      detail: { justification },
    });
  });

  // Accepting the finding is what releases the purchase order, so try again.
  await raisePurchaseOrder(id, {
    id: auth.actor.id,
    name: auth.actor.name,
    role: auth.actor.role,
  });

  revalidatePath("/");
  revalidatePath(`/requests/${id}`);

  return Response.json({ ok: true, flagCode });
}
